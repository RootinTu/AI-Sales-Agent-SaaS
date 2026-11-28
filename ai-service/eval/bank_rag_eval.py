#!/usr/bin/env python3
"""Bank RAG Benchmark 双模式自动化导入与评测脚本。

支持两种模式：
1. local 模式：直接调用 ai-service 生产级解析(documents.py)、向量化(embeddings.py)
   与 LangGraph 重排/问答/实引裁剪(workflow.py)，本地缓存 100 份 PDF 向量并精确复现
   双路 Top30+Top30 混合召回，输出召回率、准确率、错误引用率与分段延迟报告。
2. api 模式：通过 Spring Boot HTTP API 自动登录、批量导入 PDF、调用 /api/v1/knowledge/query
   跑端到端评测，并支持按清单一键清理测试文档。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import operator
import os
import random
import re
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx
from openai import AsyncOpenAI

# 将 ai-service 根目录加入 sys.path，直接复用生产代码
AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = AI_SERVICE_ROOT.parent
if str(AI_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_ROOT))

from app.features.knowledge.documents import ingest_document, search_terms  # noqa: E402
from app.features.knowledge.embeddings import DEFAULT_EMBEDDING_DIMENSIONS, embed_texts  # noqa: E402
from app.features.knowledge.schemas import (  # noqa: E402
    DocumentIngestRequest,
    EmbeddingConfiguration,
    KnowledgeCandidate,
    KnowledgeQueryRequest,
)
from app.features.knowledge.workflow import answer_from_knowledge, rank_candidates  # noqa: E402

DOC_CODE_RE = re.compile(r"(?<![A-Za-z0-9])A\d{2,3}(?![0-9])")
CITATION_RE = re.compile(r"\[资料\s*([0-9]+(?:\s*[,，、]\s*[0-9]+)*)\]")
BEHAVIOR_RE = re.compile(r"【预期行为】([^\n]+)")
REFUSAL_HINTS = (
    "没有找到足够相关",
    "无法从当前知识库确认",
    "无法确认",
    "无法判断",
    "资料不足",
    "未提及",
    "不能确定",
    "请补充",
    "需要补充",
    "请提供",
)


@dataclass
class TestCase:
    case_id: str
    qtype: str
    question: str
    difficulty: str
    expected_answer: str
    expected_behavior: str
    expected_docs_raw: str
    expected_doc_codes: list[str]


def extract_doc_codes(text: str) -> list[str]:
    seen: list[str] = []
    for code in DOC_CODE_RE.findall(text or ""):
        if code not in seen:
            seen.append(code)
    return seen


def parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def resolve_runtime_llm_config(args: argparse.Namespace) -> dict[str, Any]:
    env_file = parse_dotenv(Path(args.env_file)) if args.env_file else {}

    def pick(cli_val: str | None, env_key: str, default: str = "") -> str:
        if cli_val:
            return cli_val
        return os.environ.get(env_key) or env_file.get(env_key) or default

    api_key = pick(args.api_key, "QWEN_API_KEY")
    base_url = pick(
        args.llm_base_url,
        "QWEN_BASE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    chat_model = pick(args.chat_model, "QWEN_MODEL", "qwen3.7-plus")
    embedding_model = pick(
        args.embedding_model,
        "QWEN_EMBEDDING_MODEL",
        "qwen3.7-text-embedding-flash",
    )
    judge_model = args.judge_model or chat_model
    dimensions = int(pick(None, "QWEN_EMBEDDING_DIMENSIONS", str(DEFAULT_EMBEDDING_DIMENSIONS)))
    if not api_key:
        raise RuntimeError("未找到 QWEN_API_KEY，请通过 --api-key、环境变量或 backend/.env 配置")
    return {
        "api_key": api_key,
        "base_url": base_url,
        "chat_model": chat_model,
        "embedding_model": embedding_model,
        "judge_model": judge_model,
        "dimensions": dimensions,
    }


def _col_ref_to_index(cell_ref: str) -> int:
    letters = "".join(ch for ch in cell_ref if ch.isalpha()).upper()
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return max(0, idx - 1)


def load_xlsx_rows(xlsx_path: Path) -> list[list[str]]:
    """纯标准库读取 xlsx 第一个工作表，不依赖 openpyxl。"""
    ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(xlsx_path, "r") as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("x:si", ns):
                parts = [t.text or "" for t in si.findall(".//x:t", ns)]
                shared.append("".join(parts))

        sheet_name = "xl/worksheets/sheet1.xml"
        if sheet_name not in zf.namelist():
            candidates = sorted(n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
            if not candidates:
                raise RuntimeError(f"无法在 {xlsx_path} 中找到工作表")
            sheet_name = candidates[0]

        sheet_root = ET.fromstring(zf.read(sheet_name))
        rows: list[list[str]] = []
        for row_el in sheet_root.findall(".//x:sheetData/x:row", ns):
            cells: dict[int, str] = {}
            max_col = -1
            for c in row_el.findall("x:c", ns):
                ref = c.attrib.get("r", "")
                col_idx = _col_ref_to_index(ref) if ref else (max_col + 1)
                max_col = max(max_col, col_idx)
                cell_type = c.attrib.get("t", "")
                val = ""
                if cell_type == "s":
                    v_el = c.find("x:v", ns)
                    if v_el is not None and v_el.text is not None:
                        s_idx = int(v_el.text)
                        val = shared[s_idx] if 0 <= s_idx < len(shared) else ""
                elif cell_type == "inlineStr":
                    val = "".join(t.text or "" for t in c.findall(".//x:t", ns))
                else:
                    v_el = c.find("x:v", ns)
                    val = v_el.text if v_el is not None and v_el.text is not None else ""
                cells[col_idx] = val
            if max_col >= 0:
                rows.append([cells.get(i, "") for i in range(max_col + 1)])
        return rows


def load_test_cases(dataset_dir: Path) -> list[TestCase]:
    xlsx_path = dataset_dir / "bank-rag-benchmark-test-cases.xlsx"
    rows = load_xlsx_rows(xlsx_path)
    if len(rows) < 2:
        raise RuntimeError(f"测试集为空：{xlsx_path}")
    cases: list[TestCase] = []
    for row in rows[1:]:
        padded = row + [""] * max(0, 6 - len(row))
        cid, qtype, question, difficulty, expected_answer, expected_docs = [x.strip() for x in padded[:6]]
        if not cid or not question:
            continue
        m = BEHAVIOR_RE.search(expected_answer)
        behavior = m.group(1).strip() if m else "直接回答"
        cases.append(
            TestCase(
                case_id=cid,
                qtype=qtype,
                question=question,
                difficulty=difficulty,
                expected_answer=expected_answer,
                expected_behavior=behavior,
                expected_docs_raw=expected_docs,
                expected_doc_codes=extract_doc_codes(expected_docs),
            )
        )
    return cases


def stratified_sample(cases: list[TestCase], per_type: int, seed: int) -> list[TestCase]:
    """按问题类型等额分层抽样，组内尽量按(预期行为, 难度)均衡覆盖。"""
    if per_type <= 0:
        return list(cases)
    rng = random.Random(seed)
    by_type: dict[str, list[TestCase]] = defaultdict(list)
    for c in cases:
        by_type[c.qtype].append(c)

    selected: list[TestCase] = []
    for qtype in sorted(by_type.keys()):
        group = by_type[qtype]
        if len(group) <= per_type:
            selected.extend(group)
            continue
        # 二级按 (behavior, difficulty) 分桶轮询抽取，保证边界/拒答/不同难度都被覆盖
        sub_buckets: dict[tuple[str, str], list[TestCase]] = defaultdict(list)
        for item in group:
            sub_buckets[(item.expected_behavior, item.difficulty)].append(item)
        for items in sub_buckets.values():
            rng.shuffle(items)
        bucket_keys = sorted(sub_buckets.keys())
        picked: list[TestCase] = []
        while len(picked) < per_type:
            progressed = False
            for bk in bucket_keys:
                if sub_buckets[bk] and len(picked) < per_type:
                    picked.append(sub_buckets[bk].pop())
                    progressed = True
            if not progressed:
                break
        selected.extend(picked)
    return selected


def l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm <= 0:
        return vec
    inv = 1.0 / norm
    return [v * inv for v in vec]


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return ordered[int(k)]
    return ordered[f] * (c - k) + ordered[c] * (k - f)


def extract_citations(content: str) -> list[int]:
    nums: list[int] = []
    for m in CITATION_RE.finditer(content or ""):
        for raw in re.findall(r"\d+", m.group(1)):
            nums.append(int(raw))
    return nums


def extract_cited_claims(content: str) -> list[dict[str, Any]]:
    """按句/行切分出带 [资料 N] 标注的陈述片段，供引用支持度核验。"""
    claims: list[dict[str, Any]] = []
    # 按换行或中文句末标点切分，但保留紧跟其后的 [资料 N]
    segments = re.split(r"(?<=\])\s*(?=[。\n])|\n+", content or "")
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        # 进一步按“非引文句末标点”拆分长段落
        sub_parts = re.split(r"(?<=[。！？；])(?!\s*\[资料)", seg)
        for part in sub_parts:
            part = part.strip()
            if not part:
                continue
            cites = extract_citations(part)
            if cites:
                clean_claim = CITATION_RE.sub("", part).strip(" 。；，：-*#")
                if clean_claim:
                    claims.append({"claim": clean_claim[:400], "citations": sorted(set(cites))})
    return claims


def parse_json_from_llm(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", raw)
    if fence:
        raw = fence.group(1)
    else:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            raw = raw[start : end + 1]
    return json.loads(raw)


async def judge_case(
    client: AsyncOpenAI,
    judge_model: str,
    case: TestCase,
    answer_text: str,
    sources: list[dict[str, Any]],
    claims: list[dict[str, Any]],
) -> dict[str, Any]:
    """用裁判模型一次性评判：答案正确性、行为匹配、忠实度以及逐条引用支持度。"""
    sources_block = "\n\n".join(
        f"[资料 {i + 1} | {s['title']} | 第{s.get('page_number') or '?'}页]\n{s['excerpt'][:900]}"
        for i, s in enumerate(sources)
    ) or "(无检索资料)"

    claims_payload = []
    for idx, item in enumerate(claims[:12], start=1):
        for cite_num in item["citations"]:
            if 1 <= cite_num <= len(sources):
                claims_payload.append({
                    "id": len(claims_payload) + 1,
                    "claim": item["claim"],
                    "cited_index": cite_num,
                    "cited_title": sources[cite_num - 1]["title"],
                })

    prompt = f"""你是严谨的企业知识库 RAG 评测裁判。请根据以下信息进行客观打分，并严格只输出一个 JSON 对象，不要输出任何额外解释。

【测试问题】
{case.question}

【问题类型 / 难度】
{case.qtype} / {case.difficulty}

【参考答案与预期行为】
{case.expected_answer}

【应命中文档】
{case.expected_docs_raw}

【系统实际回答】
{answer_text}

【系统返回的引用资料】
{sources_block}

【待核验的引用句列表】
{json.dumps(claims_payload, ensure_ascii=False)}

评分标准：
1. answer_score:
   - 1.0：核心结论与参考答案一致，关键数值/条件/版本号/例外项准确无重大遗漏；若预期行为是拒绝或要求补充信息，系统也做到了对应行为。
   - 0.5：方向基本正确，但遗漏部分关键条件/多跳要点，或混入了少量不准确表述。
   - 0.0：核心结论错误、选错版本/地区规则、答非所问，或该拒答却胡编/该回答却误拒。
2. behavior_match (bool)：是否符合参考答案的【预期行为】（直接回答 / 要求补充信息 / 拒绝回答 / 拒绝并说明）。
3. faithful (bool)：系统回答中的所有事实陈述是否都能从【系统返回的引用资料】中推出（若系统正常拒答且未编造事实，记 true）。
4. citation_results：针对【待核验的引用句列表】中的每一条（按 id 一一对应），判断对应的 [资料 cited_index] 原文是否真正支撑该 claim（true/false）。如果列表为空则返回空数组 []。
5. reason：不超过 60 字的中文简要判因。

严格返回如下 JSON 格式：
{{"answer_score": 1.0, "behavior_match": true, "faithful": true, "citation_results": [{{"id": 1, "supported": true}}], "reason": "..."}}"""

    for attempt in range(2):
        try:
            resp = await client.chat.completions.create(
                model=judge_model,
                temperature=0.0,
                messages=[
                    {"role": "system", "content": "你是客观严谨的评测裁判，只输出合法 JSON。"},
                    {"role": "user", "content": prompt},
                ],
            )
            text = resp.choices[0].message.content or ""
            parsed = parse_json_from_llm(text)
            usage = {
                "input_tokens": getattr(resp.usage, "prompt_tokens", 0) if resp.usage else 0,
                "output_tokens": getattr(resp.usage, "completion_tokens", 0) if resp.usage else 0,
                "total_tokens": getattr(resp.usage, "total_tokens", 0) if resp.usage else 0,
            }
            return {
                "answer_score": float(parsed.get("answer_score", 0.0)),
                "behavior_match": bool(parsed.get("behavior_match", False)),
                "faithful": bool(parsed.get("faithful", False)),
                "citation_results": parsed.get("citation_results", []),
                "claims_checked_count": len(claims_payload),
                "reason": str(parsed.get("reason", ""))[:160],
                "judge_usage": usage,
                "judge_error": None,
            }
        except Exception as exc:
            if attempt == 1:
                return {
                    "answer_score": 0.0,
                    "behavior_match": False,
                    "faithful": False,
                    "citation_results": [],
                    "claims_checked_count": len(claims_payload),
                    "reason": f"裁判解析失败: {exc}",
                    "judge_usage": None,
                    "judge_error": str(exc),
                }
            await asyncio.sleep(1.0)
    raise AssertionError("unreachable")


def compute_doc_recall(expected_codes: list[str], retrieved_titles: list[str]) -> dict[str, Any]:
    if not expected_codes:
        return {"hit": True, "full_hit": True, "recall": 1.0, "mrr": 1.0, "precision": 1.0, "matched": [], "retrieved_codes": []}
    expected_set = set(expected_codes)
    retrieved_codes: list[str] = []
    first_rank: int | None = None
    relevant_chunks = 0
    for idx, title in enumerate(retrieved_titles, start=1):
        codes = extract_doc_codes(title)
        is_rel = any(c in expected_set for c in codes)
        if is_rel:
            relevant_chunks += 1
            if first_rank is None:
                first_rank = idx
        for c in codes:
            if c not in retrieved_codes:
                retrieved_codes.append(c)
    matched = [c for c in expected_codes if c in retrieved_codes]
    recall = len(matched) / len(expected_codes)
    precision = (relevant_chunks / len(retrieved_titles)) if retrieved_titles else 0.0
    return {
        "hit": len(matched) > 0,
        "full_hit": len(matched) == len(expected_codes),
        "recall": recall,
        "mrr": (1.0 / first_rank) if first_rank else 0.0,
        "precision": precision,
        "matched": matched,
        "retrieved_codes": retrieved_codes,
    }


# ===========================
# LOCAL 模式（本地直连 ai-service）
# ===========================

async def build_or_load_local_index(
    dataset_dir: Path,
    cache_file: Path,
    llm_cfg: dict[str, Any],
    force_rebuild: bool = False,
) -> dict[str, Any]:
    if cache_file.exists() and not force_rebuild:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        if cached.get("embedding_model") == llm_cfg["embedding_model"] and len(cached.get("documents", [])) >= 100:
            print(f"[local] 已加载本地缓存索引：{cache_file}（{len(cached['documents'])} 份文档，{len(cached['chunks'])} 个切片）")
            return cached

    pdfs = sorted((dataset_dir / "documents").glob("*.pdf"))
    if not pdfs:
        raise RuntimeError(f"未在 {dataset_dir / 'documents'} 找到 PDF 文件")

    embed_cfg = EmbeddingConfiguration(
        api_key=llm_cfg["api_key"],
        base_url=llm_cfg["base_url"],
        model=llm_cfg["embedding_model"],
        dimensions=llm_cfg["dimensions"],
    )

    print(f"[local] 开始批量解析并向量化 {len(pdfs)} 份 PDF（模型：{embed_cfg.model}，维度：{embed_cfg.dimensions}）...")
    t0 = time.perf_counter()
    documents_meta: list[dict[str, Any]] = []
    all_chunks: list[dict[str, Any]] = []
    embed_inputs: list[str] = []
    parse_failed = 0
    total_parse_ms = 0.0

    for pdf_path in pdfs:
        title = pdf_path.stem
        doc_codes = extract_doc_codes(pdf_path.name)
        doc_code = doc_codes[0] if doc_codes else title
        t_p = time.perf_counter()
        try:
            raw_bytes = pdf_path.read_bytes()
            req = DocumentIngestRequest(
                filename=pdf_path.name,
                title=title,
                category="POLICY",
                content_base64=base64.b64encode(raw_bytes).decode("ascii"),
            )
            res = ingest_document(req)
            parse_ms = (time.perf_counter() - t_p) * 1000.0
            total_parse_ms += parse_ms
            documents_meta.append({
                "doc_code": doc_code,
                "filename": pdf_path.name,
                "title": title,
                "status": "READY",
                "chunk_count": len(res.chunks),
                "character_count": res.character_count,
                "parse_ms": round(parse_ms, 2),
                "error": None,
            })
            for ch in res.chunks:
                chunk_id = f"{doc_code}#c{ch.chunk_index}"
                all_chunks.append({
                    "id": chunk_id,
                    "doc_code": doc_code,
                    "title": title,
                    "chunk_index": ch.chunk_index,
                    "page_number": ch.page_number,
                    "content": ch.content,
                    "search_terms": ch.search_terms,
                })
                embed_inputs.append(f"{title}\n{ch.content}")
        except Exception as exc:
            parse_failed += 1
            documents_meta.append({
                "doc_code": doc_code,
                "filename": pdf_path.name,
                "title": title,
                "status": "FAILED",
                "chunk_count": 0,
                "character_count": 0,
                "parse_ms": round((time.perf_counter() - t_p) * 1000.0, 2),
                "error": str(exc),
            })

    print(f"[local] PDF 解析完成：成功 {len(pdfs) - parse_failed}/{len(pdfs)}，共生成 {len(all_chunks)} 个切片（解析耗时 {total_parse_ms / 1000:.2f}s）")

    t_e = time.perf_counter()
    embed_result = await embed_texts(embed_inputs, embed_cfg)
    embed_ms = (time.perf_counter() - t_e) * 1000.0
    for ch, vec in zip(all_chunks, embed_result.vectors, strict=True):
        ch["embedding"] = l2_normalize(vec)

    total_ms = (time.perf_counter() - t0) * 1000.0
    index_data = {
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "embedding_model": embed_cfg.model,
        "dimensions": embed_cfg.dimensions,
        "ingest_summary": {
            "total_pdfs": len(pdfs),
            "parsed_ok": len(pdfs) - parse_failed,
            "parsed_failed": parse_failed,
            "total_chunks": len(all_chunks),
            "total_characters": sum(d["character_count"] for d in documents_meta),
            "parse_total_ms": round(total_parse_ms, 2),
            "embed_total_ms": round(embed_ms, 2),
            "ingest_total_ms": round(total_ms, 2),
            "embed_tokens": embed_result.usage.total_tokens if embed_result.usage else 0,
        },
        "documents": documents_meta,
        "chunks": all_chunks,
    }
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(index_data, ensure_ascii=False), encoding="utf-8")
    print(
        f"[local] 向量化完成：{len(all_chunks)} 切片，耗时 {embed_ms / 1000:.2f}s，"
        f"消耗 {index_data['ingest_summary']['embed_tokens']} Token，已缓存至 {cache_file}"
    )
    return index_data


class LocalHybridIndex:
    """精确复现 KnowledgeMapper.xml 的双路 Top30(向量) + Top30(全文) 召回。"""

    def __init__(self, index_data: dict[str, Any]):
        self.chunks = index_data["chunks"]
        self.term_sets = [set(ch["search_terms"].split()) for ch in self.chunks]
        self.term_norms = [1.0 + math.log(1.0 + len(ts)) for ts in self.term_sets]
        self.vectors = [ch["embedding"] for ch in self.chunks]

    def search(self, query: str, query_vec: list[float]) -> tuple[list[KnowledgeCandidate], float, float]:
        q_norm = l2_normalize(query_vec)

        # 1. 向量路 Top 30（与 pgvector <=> 余弦距离数学等价）
        t_v = time.perf_counter()
        v_scores = [
            (sum(map(operator.mul, q_norm, vec)), idx)
            for idx, vec in enumerate(self.vectors)
        ]
        v_scores.sort(key=lambda x: x[0], reverse=True)
        vector_hits = v_scores[:30]
        vector_ms = (time.perf_counter() - t_v) * 1000.0

        # 2. 全文路 Top 30（Bi-gram OR 匹配，近似 ts_rank_cd）
        t_l = time.perf_counter()
        q_terms = set(search_terms(query)[:256])
        l_scores: list[tuple[float, int]] = []
        if q_terms:
            for idx, ts in enumerate(self.term_sets):
                overlap = len(q_terms & ts)
                if overlap > 0:
                    l_scores.append((overlap / self.term_norms[idx], idx))
            l_scores.sort(key=lambda x: x[0], reverse=True)
        lexical_hits = l_scores[:30]
        lexical_ms = (time.perf_counter() - t_l) * 1000.0

        # 3. 合并去重最多 60 条候选（与 KnowledgeService.ask 一致）
        merged: dict[int, dict[str, Any]] = {}
        for rank, (v_score, idx) in enumerate(vector_hits, start=1):
            merged[idx] = {"vector_score": float(v_score), "vector_rank": rank, "lexical_rank": None}
        for rank, (_, idx) in enumerate(lexical_hits, start=1):
            if idx in merged:
                merged[idx]["lexical_rank"] = rank
            else:
                merged[idx] = {"vector_score": None, "vector_rank": None, "lexical_rank": rank}

        candidates: list[KnowledgeCandidate] = []
        for idx, info in list(merged.items())[:60]:
            ch = self.chunks[idx]
            candidates.append(
                KnowledgeCandidate(
                    id=ch["id"],
                    title=ch["title"],
                    content=ch["content"],
                    metadata={
                        "doc_code": ch["doc_code"],
                        "chunk_index": ch["chunk_index"],
                        "page_number": ch["page_number"],
                    },
                    vector_score=info["vector_score"],
                    vector_rank=info["vector_rank"],
                    lexical_rank=info["lexical_rank"],
                )
            )
        return candidates, vector_ms, lexical_ms


async def run_local_eval(args: argparse.Namespace) -> None:
    dataset_dir = Path(args.dataset_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_file = Path(args.cache_file) if args.cache_file else (output_dir / "local_index_cache.json")

    llm_cfg = resolve_runtime_llm_config(args)
    index_data = await build_or_load_local_index(dataset_dir, cache_file, llm_cfg, force_rebuild=args.rebuild_cache)
    hybrid = LocalHybridIndex(index_data)

    all_cases = load_test_cases(dataset_dir)
    sampled = stratified_sample(all_cases, per_type=args.per_type, seed=args.seed)
    print(f"[local] 分层抽样完成：共 {len(sampled)} 题（总集 {len(all_cases)} 题，seed={args.seed}），并发={args.concurrency}")
    print("[local] 题型分布:", dict(Counter(c.qtype for c in sampled)))
    print("[local] 行为分布:", dict(Counter(c.expected_behavior for c in sampled)))

    embed_cfg = EmbeddingConfiguration(
        api_key=llm_cfg["api_key"],
        base_url=llm_cfg["base_url"],
        model=llm_cfg["embedding_model"],
        dimensions=llm_cfg["dimensions"],
    )
    judge_client = AsyncOpenAI(api_key=llm_cfg["api_key"], base_url=llm_cfg["base_url"], timeout=120.0, max_retries=1)
    sem = asyncio.Semaphore(args.concurrency)
    done_count = 0

    async def evaluate_one(case: TestCase) -> dict[str, Any]:
        nonlocal done_count
        async with sem:
            t_all = time.perf_counter()
            # 1. Query Embedding
            t_e = time.perf_counter()
            q_embed = await embed_texts([case.question], embed_cfg)
            embed_ms = (time.perf_counter() - t_e) * 1000.0
            q_vec = q_embed.vectors[0]

            # 2. 双路粗排召回 (30 + 30 -> <=60)
            candidates, vec_ms, lex_ms = hybrid.search(case.question, q_vec)
            coarse_titles = [c.title for c in candidates]

            # 3. 精排重排（生产级 rank_candidates）
            t_r = time.perf_counter()
            reranked = rank_candidates(case.question, candidates, top_k=args.top_k)
            rerank_ms = (time.perf_counter() - t_r) * 1000.0
            rerank_titles = [s.title for s in reranked]

            # 4. 生产级 LangGraph 回答 + 实引裁剪
            t_llm = time.perf_counter()
            qa_req = KnowledgeQueryRequest(
                provider="openai",
                api_key=llm_cfg["api_key"],
                base_url=llm_cfg["base_url"],
                model=llm_cfg["chat_model"],
                query=case.question,
                candidates=candidates,
                top_k=args.top_k,
            )
            qa_resp = await answer_from_knowledge(qa_req)
            # answer_from_knowledge 内部也跑了 rank_candidates（<2ms），扣除以逼近纯 LLM 时间
            llm_ms = max(0.0, (time.perf_counter() - t_llm) * 1000.0 - rerank_ms)
            e2e_ms = (time.perf_counter() - t_all) * 1000.0

            final_sources = [
                {
                    "id": s.id,
                    "title": s.title,
                    "score": s.score,
                    "page_number": s.metadata.get("page_number"),
                    "chunk_index": s.metadata.get("chunk_index"),
                    "excerpt": s.excerpt,
                }
                for s in qa_resp.sources
            ]
            final_titles = [s["title"] for s in final_sources]

            # 5. 召回率指标（三层）
            coarse_metrics = compute_doc_recall(case.expected_doc_codes, coarse_titles)
            rerank_metrics = compute_doc_recall(case.expected_doc_codes, rerank_titles)
            final_metrics = compute_doc_recall(case.expected_doc_codes, final_titles)

            # 6. 结构性引用检查
            cite_nums = extract_citations(qa_resp.content)
            unique_cites = set(cite_nums)
            out_of_range_cites = [n for n in cite_nums if n < 1 or n > len(final_sources)]
            uncited_residual_sources = [
                i for i in range(1, len(final_sources) + 1) if i not in unique_cites
            ]
            looks_like_refusal = any(h in qa_resp.content for h in REFUSAL_HINTS) and not cite_nums
            missing_citation = (not looks_like_refusal) and (len(cite_nums) == 0)

            claims = extract_cited_claims(qa_resp.content)

            # 7. LLM-as-a-Judge 裁判
            judge = await judge_case(judge_client, llm_cfg["judge_model"], case, qa_resp.content, final_sources, claims)

            done_count += 1
            if done_count % 10 == 0 or done_count == len(sampled):
                print(f"[local] 评测进度：{done_count}/{len(sampled)}（最新 {case.case_id} score={judge['answer_score']}）", flush=True)

            return {
                "case": asdict(case),
                "answer": qa_resp.content,
                "sources": final_sources,
                "candidate_count": len(candidates),
                "rerank_count": len(reranked),
                "recall_coarse": coarse_metrics,
                "recall_rerank": rerank_metrics,
                "recall_final": final_metrics,
                "citations": {
                    "total_markers": len(cite_nums),
                    "out_of_range_count": len(out_of_range_cites),
                    "uncited_residual_count": len(uncited_residual_sources),
                    "missing_citation": missing_citation,
                    "claims_checked": judge["claims_checked_count"],
                    "citation_results": judge["citation_results"],
                },
                "judge": judge,
                "latency_ms": {
                    "embed_ms": round(embed_ms, 2),
                    "vector_search_ms": round(vec_ms, 2),
                    "lexical_search_ms": round(lex_ms, 2),
                    "rerank_ms": round(rerank_ms, 2),
                    "retrieval_total_ms": round(embed_ms + vec_ms + lex_ms + rerank_ms, 2),
                    "llm_ms": round(llm_ms, 2),
                    "e2e_ms": round(e2e_ms, 2),
                },
                "usage": {
                    "embed_tokens": q_embed.usage.total_tokens if q_embed.usage else 0,
                    "qa_tokens": qa_resp.usage.total_tokens if qa_resp.usage else 0,
                    "judge_tokens": judge["judge_usage"]["total_tokens"] if judge.get("judge_usage") else 0,
                },
            }

    try:
        results = await asyncio.gather(*(evaluate_one(c) for c in sampled))
    finally:
        await judge_client.close()

    write_reports(
        results=results,
        output_dir=output_dir,
        meta={
            "mode": "local",
            "chat_model": llm_cfg["chat_model"],
            "embedding_model": llm_cfg["embedding_model"],
            "judge_model": llm_cfg["judge_model"],
            "top_k": args.top_k,
            "seed": args.seed,
            "ingest_summary": index_data.get("ingest_summary"),
        },
    )


# ===========================
# API 模式（连 Spring Boot HTTP 接口）
# ===========================

class ApiSession:
    """管理 JWT 令牌并在 401 时自动重新登录，避免长耗时评测中断。"""

    def __init__(self, client: httpx.AsyncClient, base_url: str, email: str, password: str):
        self.client = client
        self.base_url = base_url.rstrip("/")
        self.email = email
        self.password = password
        self._token: str = ""
        self._lock = asyncio.Lock()

    async def login(self) -> str:
        async with self._lock:
            resp = await self.client.post(
                f"{self.base_url}/api/public/auth/login",
                json={"email": self.email, "password": self.password, "rememberMe": False},
                timeout=30.0,
            )
            resp.raise_for_status()
            data = resp.json()
            token = data.get("accessToken")
            if not token:
                raise RuntimeError(f"登录响应缺少 accessToken: {data}")
            self._token = token
            return token

    async def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if not self._token:
            await self.login()
        url = f"{self.base_url}{path}"
        headers = dict(kwargs.pop("headers", None) or {})
        headers["Authorization"] = f"Bearer {self._token}"
        resp = await self.client.request(method, url, headers=headers, **kwargs)
        if resp.status_code == 401:
            await self.login()
            headers["Authorization"] = f"Bearer {self._token}"
            resp = await self.client.request(method, url, headers=headers, **kwargs)
        return resp


async def run_api_import(args: argparse.Namespace) -> dict[str, Any]:
    dataset_dir = Path(args.dataset_dir)
    manifest_path = Path(args.manifest)
    manifest: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"documents": {}}
    pdfs = sorted((dataset_dir / "documents").glob("*.pdf"))
    sem = asyncio.Semaphore(max(1, args.import_concurrency))
    write_lock = asyncio.Lock()
    progress = {"done": 0, "ok": 0, "skipped": 0, "failed": 0}
    t_all = time.perf_counter()

    async with httpx.AsyncClient(timeout=180.0) as client:
        session = ApiSession(client, args.base_url, args.email, args.password)
        await session.login()
        print(f"[api-import] 登录成功，准备导入 {len(pdfs)} 份 PDF（visibility={args.visibility}，并发={args.import_concurrency}）...", flush=True)

        async def upload_one(pdf_path: Path) -> None:
            async with sem:
                existing = manifest["documents"].get(pdf_path.name)
                if existing and existing.get("status") == "READY" and existing.get("id"):
                    async with write_lock:
                        progress["skipped"] += 1
                        progress["done"] += 1
                    return
                metadata = json.dumps(
                    {"title": pdf_path.stem, "category": "POLICY", "visibility": args.visibility},
                    ensure_ascii=False,
                )
                files = {
                    "metadata": ("metadata.json", metadata.encode("utf-8"), "application/json"),
                    "file": (pdf_path.name, pdf_path.read_bytes(), "application/pdf"),
                }
                t0 = time.perf_counter()
                entry: dict[str, Any] = {}
                is_ok = False
                for attempt in range(2):
                    try:
                        resp = await session.request("POST", "/api/v1/knowledge/documents", files=files)
                        if resp.status_code in (502, 503, 504):
                            await asyncio.sleep(3.0)
                            # 504 时后端可能已经异步落库，先按标题查重避免重复上传
                            chk = await session.request("GET", "/api/v1/knowledge/documents", params={"query": pdf_path.stem, "page": 0, "size": 5})
                            if chk.status_code == 200:
                                matched = [d for d in chk.json().get("content", []) if d.get("title") == pdf_path.stem]
                                if matched:
                                    doc = matched[0]
                                    entry = {
                                        "id": doc["id"],
                                        "version": doc["version"],
                                        "title": doc["title"],
                                        "status": doc["status"],
                                        "chunkCount": doc.get("chunkCount", 0),
                                        "embeddedChunkCount": doc.get("embeddedChunkCount", 0),
                                        "embeddingModel": doc.get("embeddingModel"),
                                        "characterCount": doc.get("characterCount", 0),
                                        "errorMessage": doc.get("errorMessage"),
                                        "upload_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                                    }
                                    is_ok = doc.get("status") == "READY"
                                    break
                            if attempt == 0:
                                continue
                        resp.raise_for_status()
                        doc = resp.json()
                        entry = {
                            "id": doc["id"],
                            "version": doc["version"],
                            "title": doc["title"],
                            "status": doc["status"],
                            "chunkCount": doc.get("chunkCount", 0),
                            "embeddedChunkCount": doc.get("embeddedChunkCount", 0),
                            "embeddingModel": doc.get("embeddingModel"),
                            "characterCount": doc.get("characterCount", 0),
                            "errorMessage": doc.get("errorMessage"),
                            "upload_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                        }
                        is_ok = doc.get("status") == "READY"
                        break
                    except Exception as exc:
                        entry = {"status": "ERROR", "error": str(exc)}
                        is_ok = False
                        if attempt == 0:
                            await asyncio.sleep(2.0)
                async with write_lock:
                    manifest["documents"][pdf_path.name] = entry
                    if is_ok:
                        progress["ok"] += 1
                    else:
                        progress["failed"] += 1
                    progress["done"] += 1
                    manifest_path.parent.mkdir(parents=True, exist_ok=True)
                    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                    if progress["done"] % 10 == 0 or progress["done"] == len(pdfs):
                        print(
                            f"[api-import] 进度 {progress['done']}/{len(pdfs)}"
                            f"（新增成功 {progress['ok']} / 跳过 {progress['skipped']} / 失败 {progress['failed']}）",
                            flush=True,
                        )

        await asyncio.gather(*(upload_one(p) for p in pdfs))

    docs_vals = list(manifest["documents"].values())
    ready_docs = [d for d in docs_vals if d.get("status") == "READY"]
    total_chunks = sum(d.get("chunkCount", 0) for d in ready_docs)
    embedded_chunks = sum(d.get("embeddedChunkCount", 0) for d in ready_docs)
    embed_models = sorted({d.get("embeddingModel") for d in ready_docs if d.get("embeddingModel")})
    summary = {
        "total_pdfs": len(pdfs),
        "parsed_ok": len(ready_docs),
        "parsed_failed": len(pdfs) - len(ready_docs),
        "total_chunks": total_chunks,
        "embedded_chunks": embedded_chunks,
        "embedding_models": embed_models,
        "total_characters": sum(d.get("characterCount", 0) for d in ready_docs),
        "parse_total_ms": 0.0,
        "embed_total_ms": 0.0,
        "ingest_total_ms": round((time.perf_counter() - t_all) * 1000.0, 2),
        "embed_tokens": 0,
    }
    print(
        f"[api-import] 导入完成：READY {summary['parsed_ok']}/{summary['total_pdfs']}，"
        f"切片 {total_chunks}（已向量化 {embedded_chunks}，模型 {embed_models}），"
        f"总耗时 {summary['ingest_total_ms'] / 1000:.1f}s",
        flush=True,
    )
    return summary


async def run_api_cleanup(args: argparse.Namespace) -> dict[str, int]:
    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        raise RuntimeError(f"未找到导入清单：{manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    docs = manifest.get("documents", {})
    deleted = failed = 0
    async with httpx.AsyncClient(timeout=60.0) as client:
        session = ApiSession(client, args.base_url, args.email, args.password)
        await session.login()
        for name, info in list(docs.items()):
            doc_id = info.get("id")
            if not doc_id:
                continue
            try:
                get_resp = await session.request("GET", f"/api/v1/knowledge/documents/{doc_id}")
                if get_resp.status_code == 404:
                    deleted += 1
                    continue
                get_resp.raise_for_status()
                version = get_resp.json().get("version", info.get("version", 0))
                del_resp = await session.request("DELETE", f"/api/v1/knowledge/documents/{doc_id}", params={"version": version})
                del_resp.raise_for_status()
                deleted += 1
            except Exception as exc:
                failed += 1
                print(f"[api-cleanup] 删除失败 {name} ({doc_id}): {exc}", flush=True)
        # 兜底扫描：清理因 504 未记录进 manifest 的 A01~A100 私有测试文档
        for page_i in range(10):
            list_resp = await session.request("GET", "/api/v1/knowledge/documents", params={"page": page_i, "size": 50})
            if list_resp.status_code != 200:
                break
            rows = list_resp.json().get("content", [])
            if not rows:
                break
            extra_deleted = 0
            for row in rows:
                if row.get("visibility") == "PRIVATE" and (
                    re.match(r"^A\d{2,3}_", row.get("filename", "")) or re.match(r"^A\d{2,3}_", row.get("title", ""))
                ):
                    try:
                        del_r = await session.request("DELETE", f"/api/v1/knowledge/documents/{row['id']}", params={"version": row["version"]})
                        del_r.raise_for_status()
                        deleted += 1
                        extra_deleted += 1
                    except Exception as exc:
                        failed += 1
                        print(f"[api-cleanup] 兜底删除失败 {row.get('title')}: {exc}", flush=True)
            if extra_deleted == 0 and len(rows) < 50:
                break
    print(f"[api-cleanup] 清理完成：已删除 {deleted} 份，失败 {failed} 份", flush=True)
    return {"deleted": deleted, "failed": failed}


async def run_api_eval(args: argparse.Namespace, ingest_summary: dict[str, Any] | None = None) -> None:
    dataset_dir = Path(args.dataset_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    llm_cfg = None if args.skip_judge else resolve_runtime_llm_config(args)

    all_cases = load_test_cases(dataset_dir)
    sampled = stratified_sample(all_cases, per_type=args.per_type, seed=args.seed)
    print(f"[api-eval] 分层抽样完成：共 {len(sampled)} 题（seed={args.seed}，并发={args.concurrency}，skip_judge={args.skip_judge}）", flush=True)
    print("[api-eval] 题型分布:", dict(Counter(c.qtype for c in sampled)), flush=True)
    print("[api-eval] 行为分布:", dict(Counter(c.expected_behavior for c in sampled)), flush=True)

    judge_client = (
        None
        if args.skip_judge
        else AsyncOpenAI(api_key=llm_cfg["api_key"], base_url=llm_cfg["base_url"], timeout=120.0, max_retries=1)
    )
    sem = asyncio.Semaphore(args.concurrency)
    progress_log = output_dir / "details_partial.jsonl"
    progress_log.write_text("", encoding="utf-8")
    write_lock = asyncio.Lock()

    async with httpx.AsyncClient(timeout=180.0) as client:
        session = ApiSession(client, args.base_url, args.email, args.password)
        await session.login()
        # 获取线上实际 AI 模型状态，记录到报告
        ai_status: dict[str, Any] = {}
        try:
            st_resp = await session.request("GET", "/api/v1/ai/model")
            if st_resp.status_code == 200:
                ai_status = st_resp.json()
        except Exception:
            pass
        done_count = 0

        async def evaluate_one(case: TestCase) -> dict[str, Any]:
            nonlocal done_count
            async with sem:
                body: dict[str, Any] = {}
                e2e_ms = 0.0
                req_error: str | None = None
                for attempt in range(3):
                    t0 = time.perf_counter()
                    try:
                        resp = await session.request("POST", "/api/v1/knowledge/query", json={"question": case.question})
                        if resp.status_code in (502, 503, 504) and attempt < 2:
                            await asyncio.sleep(2.0 * (attempt + 1))
                            continue
                        resp.raise_for_status()
                        e2e_ms = (time.perf_counter() - t0) * 1000.0
                        body = resp.json()
                        req_error = None
                        break
                    except Exception as exc:
                        e2e_ms = (time.perf_counter() - t0) * 1000.0
                        req_error = str(exc)
                        if attempt < 2:
                            await asyncio.sleep(2.0 * (attempt + 1))
                answer_text = body.get("content", "") if not req_error else f"[请求失败] {req_error}"
                raw_sources = (body.get("sources") or []) if not req_error else []
                final_sources = [
                    {
                        "id": str(s.get("id", "")),
                        "document_id": str(s.get("documentId", "")),
                        "title": s.get("title", ""),
                        "score": s.get("score", 0.0),
                        "page_number": s.get("pageNumber"),
                        "chunk_index": s.get("chunkIndex"),
                        "excerpt": s.get("excerpt", ""),
                    }
                    for s in raw_sources
                ]
                final_titles = [s["title"] for s in final_sources]
                final_metrics = compute_doc_recall(case.expected_doc_codes, final_titles)
                cite_nums = extract_citations(answer_text)
                unique_cites = set(cite_nums)
                out_of_range = [n for n in cite_nums if n < 1 or n > len(final_sources)]
                uncited_residual = [i for i in range(1, len(final_sources) + 1) if i not in unique_cites]
                looks_refusal = any(h in answer_text for h in REFUSAL_HINTS) and not cite_nums
                claims = extract_cited_claims(answer_text)
                if req_error:
                    judge = {
                        "answer_score": 0.0,
                        "behavior_match": False,
                        "faithful": False,
                        "citation_results": [],
                        "claims_checked_count": 0,
                        "reason": f"线上接口异常: {req_error[:100]}",
                        "judge_usage": None,
                        "judge_error": req_error,
                    }
                elif args.skip_judge or judge_client is None:
                    judge = {
                        "answer_score": 0.0,
                        "behavior_match": False,
                        "faithful": False,
                        "citation_results": [],
                        "claims_checked_count": sum(len(x["citations"]) for x in claims),
                        "reason": "待评审(skip_judge)",
                        "judge_usage": None,
                        "judge_error": None,
                    }
                else:
                    judge = await judge_case(judge_client, llm_cfg["judge_model"], case, answer_text, final_sources, claims)

                usage = body.get("usage") or {}
                record = {
                    "case": asdict(case),
                    "answer": answer_text,
                    "sources": final_sources,
                    "claims": claims,
                    "candidate_count": None,
                    "rerank_count": len(final_sources),
                    "recall_coarse": None,
                    "recall_rerank": final_metrics,
                    "recall_final": final_metrics,
                    "citations": {
                        "total_markers": len(cite_nums),
                        "out_of_range_count": len(out_of_range),
                        "uncited_residual_count": len(uncited_residual),
                        "missing_citation": (not looks_refusal) and (len(cite_nums) == 0),
                        "claims_checked": judge["claims_checked_count"],
                        "citation_results": judge["citation_results"],
                    },
                    "judge": judge,
                    "latency_ms": {
                        "embed_ms": None,
                        "vector_search_ms": None,
                        "lexical_search_ms": None,
                        "rerank_ms": None,
                        "retrieval_total_ms": None,
                        "llm_ms": None,
                        "e2e_ms": round(e2e_ms, 2),
                    },
                    "usage": {
                        "embed_tokens": 0,
                        "qa_tokens": usage.get("totalTokens", 0) or 0,
                        "judge_tokens": judge["judge_usage"]["total_tokens"] if judge.get("judge_usage") else 0,
                    },
                    "req_error": req_error,
                }
                async with write_lock:
                    with progress_log.open("a", encoding="utf-8") as pfh:
                        pfh.write(json.dumps(record, ensure_ascii=False) + "\n")
                    done_count += 1
                    if done_count % 5 == 0 or done_count == len(sampled):
                        print(
                            f"[api-eval] 进度：{done_count}/{len(sampled)}（最新 {case.case_id} "
                            f"recall={final_metrics['recall']:.2f} e2e={e2e_ms/1000:.1f}s err={bool(req_error)}）",
                            flush=True,
                        )
                return record

        try:
            results = await asyncio.gather(*(evaluate_one(c) for c in sampled))
        finally:
            if judge_client is not None:
                await judge_client.close()

    write_reports(
        results=results,
        output_dir=output_dir,
        meta={
            "mode": "api",
            "base_url": args.base_url,
            "chat_model": ai_status.get("model") or (llm_cfg["chat_model"] if llm_cfg else "-"),
            "embedding_model": ai_status.get("embeddingModel")
            or (ingest_summary["embedding_models"][0] if ingest_summary and ingest_summary.get("embedding_models") else "-"),
            "judge_model": "manual-review" if args.skip_judge else (llm_cfg["judge_model"] if llm_cfg else "-"),
            "top_k": args.top_k,
            "seed": args.seed,
            "ingest_summary": ingest_summary,
        },
    )


# ===========================
# 报告汇总
# ===========================

def summarize_group(items: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(items)
    if n == 0:
        return {}

    def avg(vals: list[float]) -> float:
        return (sum(vals) / len(vals)) if vals else 0.0

    coarse_items = [x["recall_coarse"] for x in items if x.get("recall_coarse") is not None]
    rerank_items = [x["recall_rerank"] for x in items]
    final_items = [x["recall_final"] for x in items]

    # 引用统计
    total_checked_cites = 0
    unsupported_cites = 0
    out_of_range_cites = 0
    uncited_residual_total = 0
    queries_with_cites = 0
    queries_with_cite_error = 0
    missing_cite_queries = 0

    for x in items:
        cinfo = x["citations"]
        oor = cinfo["out_of_range_count"]
        out_of_range_cites += oor
        uncited_residual_total += cinfo["uncited_residual_count"]
        if cinfo["missing_citation"]:
            missing_cite_queries += 1
        c_res = cinfo.get("citation_results") or []
        unsup = sum(1 for r in c_res if not r.get("supported", False))
        checked = len(c_res)
        total_checked_cites += checked + oor
        unsupported_cites += unsup
        if checked + oor > 0:
            queries_with_cites += 1
            if unsup + oor > 0:
                queries_with_cite_error += 1

    cite_error_rate = ((unsupported_cites + out_of_range_cites) / total_checked_cites) if total_checked_cites else 0.0
    query_cite_error_rate = (queries_with_cite_error / queries_with_cites) if queries_with_cites else 0.0

    return {
        "count": n,
        "coarse_hit_rate": avg([1.0 if m["hit"] else 0.0 for m in coarse_items]) if coarse_items else None,
        "coarse_recall": avg([m["recall"] for m in coarse_items]) if coarse_items else None,
        "coarse_full_hit": avg([1.0 if m["full_hit"] else 0.0 for m in coarse_items]) if coarse_items else None,
        "rerank_hit_rate": avg([1.0 if m["hit"] else 0.0 for m in rerank_items]),
        "rerank_recall": avg([m["recall"] for m in rerank_items]),
        "rerank_full_hit": avg([1.0 if m["full_hit"] else 0.0 for m in rerank_items]),
        "rerank_mrr": avg([m["mrr"] for m in rerank_items]),
        "rerank_precision": avg([m["precision"] for m in rerank_items]),
        "final_hit_rate": avg([1.0 if m["hit"] else 0.0 for m in final_items]),
        "final_recall": avg([m["recall"] for m in final_items]),
        "final_precision": avg([m["precision"] for m in final_items]),
        "answer_accuracy": avg([x["judge"]["answer_score"] for x in items]),
        "answer_strict_acc": avg([1.0 if x["judge"]["answer_score"] >= 0.99 else 0.0 for x in items]),
        "behavior_match_rate": avg([1.0 if x["judge"]["behavior_match"] else 0.0 for x in items]),
        "faithfulness_rate": avg([1.0 if x["judge"]["faithful"] else 0.0 for x in items]),
        "citation_checked_total": total_checked_cites,
        "citation_error_count": unsupported_cites + out_of_range_cites,
        "citation_error_rate": cite_error_rate,
        "query_citation_error_rate": query_cite_error_rate,
        "out_of_range_cites": out_of_range_cites,
        "uncited_residual_total": uncited_residual_total,
        "missing_citation_rate": missing_cite_queries / n,
    }


def fmt_pct(val: float | None) -> str:
    return "-" if val is None else f"{val * 100:.1f}%"


def write_reports(results: list[dict[str, Any]], output_dir: Path, meta: dict[str, Any]) -> None:
    details_path = output_dir / "details.jsonl"
    with details_path.open("w", encoding="utf-8") as fh:
        for r in results:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    overall = summarize_group(results)
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in results:
        by_type[r["case"]["qtype"]].append(r)

    # 延迟统计
    latency_keys = [
        ("embed_ms", "Query Embedding"),
        ("vector_search_ms", "向量检索 (Top 30)"),
        ("lexical_search_ms", "全文检索 (Top 30)"),
        ("rerank_ms", "融合重排过滤 (rank_candidates)"),
        ("retrieval_total_ms", "纯检索总延迟 (不含 LLM)"),
        ("llm_ms", "LLM 生成 (LangGraph)"),
        ("e2e_ms", "问答端到端总延迟"),
    ]
    latency_stats: dict[str, dict[str, float]] = {}
    for key, _ in latency_keys:
        vals = [r["latency_ms"][key] for r in results if r["latency_ms"].get(key) is not None]
        if vals:
            latency_stats[key] = {
                "mean": round(sum(vals) / len(vals), 1),
                "p50": round(percentile(vals, 50), 1),
                "p95": round(percentile(vals, 95), 1),
                "p99": round(percentile(vals, 99), 1),
            }

    total_usage = {
        "embed_tokens": sum(r["usage"]["embed_tokens"] for r in results),
        "qa_tokens": sum(r["usage"]["qa_tokens"] for r in results),
        "judge_tokens": sum(r["usage"]["judge_tokens"] for r in results),
    }

    summary_json = {
        "meta": meta,
        "overall": overall,
        "by_type": {k: summarize_group(v) for k, v in sorted(by_type.items())},
        "latency_ms": latency_stats,
        "usage": total_usage,
    }
    (output_dir / "summary.json").write_text(json.dumps(summary_json, ensure_ascii=False, indent=2), encoding="utf-8")

    lines: list[str] = [
        "# Bank RAG Benchmark 基线评测报告",
        "",
        "## 1. 测试配置",
        f"- **评测模式**：`{meta['mode']}`",
        f"- **问答模型**：`{meta.get('chat_model', '-')}` | **向量模型**：`{meta.get('embedding_model', '-')}` | **裁判模型**：`{meta.get('judge_model', '-')}`",
        f"- **抽样规模**：{len(results)} 题（seed={meta.get('seed')}，top_k={meta.get('top_k', 4)}）",
    ]
    ingest = meta.get("ingest_summary")
    if ingest:
        lines.append(
            f"- **底库入库**：{ingest['parsed_ok']}/{ingest['total_pdfs']} 份 PDF 解析成功，"
            f"共 {ingest['total_chunks']} 个切片（{ingest['total_characters']:,} 字符），"
            f"解析耗时 {ingest['parse_total_ms']/1000:.2f}s，向量化耗时 {ingest['embed_total_ms']/1000:.2f}s（{ingest['embed_tokens']:,} Token）"
        )
    lines.append(
        f"- **评测 Token 用量**：Query Embedding {total_usage['embed_tokens']:,} | 问答 {total_usage['qa_tokens']:,} | 裁判 {total_usage['judge_tokens']:,}"
    )

    lines.extend([
        "",
        "## 2. 核心指标总览",
        "",
        "| 指标类别 | 指标名称 | 实测结果 | 说明 |",
        "| :--- | :--- | :---: | :--- |",
        f"| **召回率** | 粗排文档召回率 (Top 60 Recall) | **{fmt_pct(overall['coarse_recall'])}** | Hit@60: {fmt_pct(overall['coarse_hit_rate'])} / 全命中: {fmt_pct(overall['coarse_full_hit'])} |",
        f"| **召回率** | 精排文档召回率 (Top {meta.get('top_k', 4)} Recall) | **{fmt_pct(overall['rerank_recall'])}** | Hit@{meta.get('top_k', 4)}: {fmt_pct(overall['rerank_hit_rate'])} / 全命中: {fmt_pct(overall['rerank_full_hit'])} / MRR: {overall['rerank_mrr']:.3f} |",
        f"| **召回率** | 最终实引文档召回率 | **{fmt_pct(overall['final_recall'])}** | 经 `prune_uncited_sources` 裁剪后 Hit: {fmt_pct(overall['final_hit_rate'])} |",
        f"| **准确率** | 检索来源精确率 (精排 / 最终实引) | **{fmt_pct(overall['rerank_precision'])} / {fmt_pct(overall['final_precision'])}** | 返回来源属于应命中文档的比例 |",
        f"| **准确率** | 问答综合准确率 (加权 / 严格满分) | **{fmt_pct(overall['answer_accuracy'])} / {fmt_pct(overall['answer_strict_acc'])}** | 行为匹配率: {fmt_pct(overall['behavior_match_rate'])} |",
        f"| **准确率** | 回答忠实度 (无幻觉率) | **{fmt_pct(overall['faithfulness_rate'])}** | 回答陈述完全基于检索资料的比例 |",
        f"| **错误引用率** | 引用级错误率 | **{fmt_pct(overall['citation_error_rate'])}** | 错误 {overall['citation_error_count']} / 共核验 {overall['citation_checked_total']} 处引用（越界 {overall['out_of_range_cites']}） |",
        f"| **错误引用率** | 问答级错误引用率 | **{fmt_pct(overall['query_citation_error_rate'])}** | 至少含 1 处错误引用的问答占比；幽灵残留来源: {overall['uncited_residual_total']} |",
        f"| **错误引用率** | 漏标引用率 | **{fmt_pct(overall['missing_citation_rate'])}** | 正常回答但未标 `[资料 N]` 的占比 |",
        "",
        "## 3. 按五大问题类型拆解",
        "",
        "| 问题类型 | 题数 | 粗排 Recall@60 | 精排 Recall@4 | 精排全命中 | 检索精确率 | 问答准确率 | 忠实度 | 引用错误率 |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
    ])
    for qtype in sorted(by_type.keys()):
        g = summarize_group(by_type[qtype])
        lines.append(
            f"| {qtype} | {g['count']} | {fmt_pct(g['coarse_recall'])} | {fmt_pct(g['rerank_recall'])} | "
            f"{fmt_pct(g['rerank_full_hit'])} | {fmt_pct(g['final_precision'])} | {fmt_pct(g['answer_accuracy'])} | "
            f"{fmt_pct(g['faithfulness_rate'])} | {fmt_pct(g['citation_error_rate'])} |"
        )

    lines.extend([
        "",
        "## 4. 检索与问答延迟分布（ms）",
        "",
        "| 阶段 | Mean | P50 | P95 | P99 |",
        "| :--- | ---: | ---: | ---: | ---: |",
    ])
    for key, label in latency_keys:
        st = latency_stats.get(key)
        if st:
            lines.append(f"| {label} | {st['mean']:.1f} | {st['p50']:.1f} | {st['p95']:.1f} | {st['p99']:.1f} |")

    # 典型错题 Top 10
    bad_cases = sorted(results, key=lambda x: (x["judge"]["answer_score"], x["recall_rerank"]["recall"]))[:10]
    lines.extend(["", "## 5. 典型低分/失误案例（Top 10）", ""])
    for r in bad_cases:
        c = r["case"]
        lines.append(
            f"- **`{c['case_id']}` [{c['qtype']}/{c['difficulty']}/{c['expected_behavior']}]** "
            f"(得分 {r['judge']['answer_score']}, 粗排命中 {r['recall_coarse']['matched'] if r['recall_coarse'] else '-'}, "
            f"精排命中 {r['recall_rerank']['matched']}/{c['expected_doc_codes']})\n"
            f"  - 问题：{c['question']}\n"
            f"  - 判因：{r['judge']['reason']}"
        )

    report_path = output_dir / "report.md"
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n[done] 报告已生成：{report_path}")
    print(f"[done] 明细已保存：{details_path}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Bank RAG Benchmark 双模式导入与评测脚本")
    p.add_argument("--mode", choices=["local", "api"], default="local", help="运行模式：local 直连 ai-service，api 连 Spring Boot HTTP 接口")
    p.add_argument("--action", choices=["eval", "import", "cleanup", "full"], default="eval", help="api 模式下可选 import / eval / cleanup / full(导入+评测+自动清理)")
    p.add_argument("--dataset-dir", required=True, help="bank-rag-benchmark 仓库目录")
    p.add_argument("--output-dir", default=str(AI_SERVICE_ROOT / "eval" / "output"), help="评测报告与缓存输出目录")
    p.add_argument("--cache-file", default="", help="local 模式向量索引缓存路径")
    p.add_argument("--rebuild-cache", action="store_true", help="强制重新解析并向量化全部 PDF")
    p.add_argument("--per-type", type=int, default=12, help="每种题型抽样题数（0 表示全量 450 题）")
    p.add_argument("--seed", type=int, default=42, help="分层抽样随机种子")
    p.add_argument("--top-k", type=int, default=4, help="精排送入 LLM 的最大片段数（与生产一致默认为 4）")
    p.add_argument("--concurrency", type=int, default=4, help="并发评测协程数")
    p.add_argument("--import-concurrency", type=int, default=3, help="api 模式批量上传 PDF 的并发数")
    p.add_argument("--env-file", default=str(REPO_ROOT / "backend" / ".env"), help="读取 QWEN_* 配置的 .env 文件路径")
    p.add_argument("--api-key", default="", help="覆盖 QWEN_API_KEY")
    p.add_argument("--llm-base-url", default="", help="覆盖 QWEN_BASE_URL")
    p.add_argument("--chat-model", default="", help="覆盖问答模型名")
    p.add_argument("--embedding-model", default="", help="覆盖向量模型名")
    p.add_argument("--judge-model", default="", help="裁判模型名（默认与问答模型相同）")
    p.add_argument("--skip-judge", action="store_true", help="api 模式下跳过远程裁判模型调用，仅保存完整检索与问答明细供人工/离线评审")
    # API 模式参数
    p.add_argument("--base-url", default="http://127.0.0.1:8080", help="Spring Boot 后端地址")
    p.add_argument("--email", default="", help="API 模式登录邮箱")
    p.add_argument("--password", default="", help="API 模式登录密码")
    p.add_argument("--visibility", choices=["PRIVATE", "TEAM"], default="PRIVATE", help="批量导入的资料可见范围")
    p.add_argument("--manifest", default=str(AI_SERVICE_ROOT / "eval" / "output" / "api_manifest.json"), help="API 模式导入清单路径（用于断点续传和一键清理）")
    return p


async def run_api_full(args: argparse.Namespace) -> None:
    ingest_summary = await run_api_import(args)
    try:
        await run_api_eval(args, ingest_summary=ingest_summary)
    finally:
        print("[api-full] 评测结束，开始自动清理全部测试 PDF...", flush=True)
        await run_api_cleanup(args)


def main() -> None:
    args = build_parser().parse_args()
    if args.mode == "local":
        asyncio.run(run_local_eval(args))
    else:
        email = args.email or os.environ.get("EVAL_EMAIL", "")
        password = args.password or os.environ.get("EVAL_PASSWORD", "")
        if not email or not password:
            raise SystemExit("api 模式必须提供 --email 与 --password（或设置环境变量 EVAL_EMAIL / EVAL_PASSWORD）")
        args.email = email
        args.password = password
        if args.action == "import":
            asyncio.run(run_api_import(args))
        elif args.action == "cleanup":
            asyncio.run(run_api_cleanup(args))
        elif args.action == "full":
            asyncio.run(run_api_full(args))
        else:
            asyncio.run(run_api_eval(args))


if __name__ == "__main__":
    main()
