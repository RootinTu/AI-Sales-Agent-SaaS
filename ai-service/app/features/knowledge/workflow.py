import math
import re
from typing import Any, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

from app.features.knowledge.documents import search_terms
from app.features.knowledge.prompts import KNOWLEDGE_SYSTEM_PROMPT
from app.features.knowledge.schemas import (
    KnowledgeCandidate,
    KnowledgeQueryRequest,
    KnowledgeQueryResponse,
    KnowledgeSource,
)
from app.llm.factory import create_chat_model
from app.llm.messages import message_metadata, message_text, message_usage


class KnowledgeState(TypedDict, total=False):
    request: KnowledgeQueryRequest
    sources: list[KnowledgeSource]
    response: Any


def _terms(value: str) -> set[str]:
    return set(search_terms(value))


MIN_VECTOR_SCORE = 0.42
STRONG_LEXICAL_SCORE = 0.16
MAX_VECTOR_SCORE_GAP = 0.16
MAX_SCORE_GAP = 0.18
RRF_K = 60.0
MAX_CHUNKS_PER_DOCUMENT = 2
DEPRECATED_SCORE_MULTIPLIER = 0.78

_CITATION_GROUP_PATTERN = re.compile(r"\[资料\s*([0-9]+(?:\s*[,，、]\s*[0-9]+)*)\]")
_HISTORICAL_QUERY_PATTERN = re.compile(
    r"旧版|历史|废止|失效|修订稿|征求意见稿|草稿|原版|曾|以前|202[0-4]年"
)
_DEPRECATED_DOC_PATTERN = re.compile(
    r"已废止|征求意见稿|从未生效|历史废止版本|[（(]旧版[)）]|_旧版|_修订稿|[（(]修订稿[)）]|-DRAFT",
    re.IGNORECASE,
)
_REFUSAL_ANSWER_PATTERN = re.compile(
    r"无法从当前知识库确认|当前知识库中没有|没有找到足够相关|无法确认|资料不足|没有相关记载|未包含.{0,12}条款|未提供.{0,16}信息"
)


def _is_deprecated_candidate(candidate: KnowledgeCandidate) -> bool:
    head = f"{candidate.title}\n{candidate.content[:400]}"
    return bool(_DEPRECATED_DOC_PATTERN.search(head))


def _document_group_key(candidate: KnowledgeCandidate) -> str:
    doc_id = candidate.metadata.get("document_id") if isinstance(candidate.metadata, dict) else None
    if doc_id:
        return str(doc_id)
    return candidate.title or candidate.id


def rank_candidates(query: str, candidates: list[KnowledgeCandidate], top_k: int) -> list[KnowledgeSource]:
    query_terms = _terms(query)
    asks_historical = bool(_HISTORICAL_QUERY_PATTERN.search(query))
    has_vector = any(candidate.vector_score is not None for candidate in candidates)

    # 计算最佳向量基准分时优先使用非废止/非草稿文档，防止失效版本抬高门槛误杀现行主规程
    active_vector_scores = [
        float(candidate.vector_score)
        for candidate in candidates
        if candidate.vector_score is not None and (asks_historical or not _is_deprecated_candidate(candidate))
    ]
    all_vector_scores = [
        float(candidate.vector_score)
        for candidate in candidates
        if candidate.vector_score is not None
    ]
    best_vector_score = max(active_vector_scores, default=max(all_vector_scores, default=0.0))

    scored: list[tuple[KnowledgeSource, float, float, str, bool]] = []
    for candidate in candidates:
        candidate_terms = _terms(candidate.title + candidate.content)
        overlap = len(query_terms & candidate_terms)
        lexical_score = overlap / math.sqrt(max(1, len(query_terms)) * max(1, len(candidate_terms)))
        is_adjacent = bool(isinstance(candidate.metadata, dict) and candidate.metadata.get("adjacent"))
        is_deprecated = (not asks_historical) and _is_deprecated_candidate(candidate)

        if has_vector:
            vector_score = max(0.0, float(candidate.vector_score)) if candidate.vector_score is not None else 0.0
            has_strong_lexical = lexical_score >= STRONG_LEXICAL_SCORE
            if not is_adjacent and not has_strong_lexical and vector_score < MIN_VECTOR_SCORE:
                continue
            if (
                not is_adjacent
                and not has_strong_lexical
                and best_vector_score >= MIN_VECTOR_SCORE
                and (best_vector_score - vector_score) > MAX_VECTOR_SCORE_GAP
            ):
                continue
            rrf_bonus = 0.0
            if candidate.vector_rank is not None:
                rrf_bonus += 1.0 / (RRF_K + candidate.vector_rank)
            if candidate.lexical_rank is not None:
                rrf_bonus += 1.0 / (RRF_K + candidate.lexical_rank)
            if is_adjacent and rrf_bonus == 0.0:
                rrf_bonus = 1.0 / (RRF_K + 2.0)
            # 融合向量余弦相似度、词项重合度与双路 RRF 增益（归一化至约 0~1）
            score = 0.62 * vector_score + 0.23 * lexical_score + 0.15 * min(1.0, rrf_bonus * (RRF_K / 2.0))
        else:
            vector_score = 0.0
            score = lexical_score
            if not is_adjacent and score <= 0:
                continue
            if is_adjacent and score <= 0:
                score = 0.01

        if is_deprecated:
            score *= DEPRECATED_SCORE_MULTIPLIER

        scored.append((
            KnowledgeSource(
                id=candidate.id,
                title=candidate.title,
                excerpt=candidate.content[:1200],
                score=round(score, 6),
                metadata=candidate.metadata,
            ),
            vector_score,
            lexical_score,
            _document_group_key(candidate),
            is_adjacent,
        ))

    scored.sort(key=lambda item: item[0].score, reverse=True)
    if not scored:
        return []

    top_score = scored[0][0].score
    eligible: list[tuple[KnowledgeSource, str, bool]] = []
    for source, vector_score, lexical_score, doc_key, is_adjacent in scored:
        if (
            has_vector
            and eligible
            and not is_adjacent
            and (top_score - source.score) > MAX_SCORE_GAP
            and vector_score < 0.55
            and lexical_score < STRONG_LEXICAL_SCORE
        ):
            continue
        eligible.append((source, doc_key, is_adjacent))

    # 第一轮：单文档最多占 MAX_CHUNKS_PER_DOCUMENT(2) 槽，确保多跳检索覆盖多份文档
    selected: list[KnowledgeSource] = []
    selected_ids: set[str] = set()
    doc_counts: dict[str, int] = {}
    selected_docs: set[str] = set()
    deferred: list[tuple[KnowledgeSource, str]] = []

    for source, doc_key, is_adjacent in eligible:
        if is_adjacent and doc_key not in selected_docs:
            # 邻近扩展切片仅在其所属主文档已入选时才补位，不凭空引入无关文档
            deferred.append((source, doc_key))
            continue
        if doc_counts.get(doc_key, 0) < MAX_CHUNKS_PER_DOCUMENT:
            selected.append(source)
            selected_ids.add(source.id)
            doc_counts[doc_key] = doc_counts.get(doc_key, 0) + 1
            selected_docs.add(doc_key)
            if len(selected) >= top_k:
                return selected
        else:
            deferred.append((source, doc_key))

    # 若主文档刚入选但邻近切片排在后面，优先补齐已入选主文档的邻近参数切片（不超过单文档上限）
    for source, doc_key in deferred:
        if source.id in selected_ids:
            continue
        if doc_key in selected_docs and doc_counts.get(doc_key, 0) < MAX_CHUNKS_PER_DOCUMENT:
            selected.append(source)
            selected_ids.add(source.id)
            doc_counts[doc_key] = doc_counts.get(doc_key, 0) + 1
            if len(selected) >= top_k:
                return selected

    # 若不同文档总数不足 top_k，再从剩余合规候选中按原排序补满
    for source, _ in deferred:
        if source.id in selected_ids:
            continue
        selected.append(source)
        selected_ids.add(source.id)
        if len(selected) >= top_k:
            break

    return selected


def prune_uncited_sources(content: str, sources: list[KnowledgeSource]) -> tuple[str, list[KnowledgeSource]]:
    """只保留回答正文中实际引用到的资料，并将引用编号重排为连续的 [资料 1], [资料 2]...
    若回答未引用任何资料且为明确拒答/资料不足表述，则清空来源列表以避免前端展示无关参考文档。
    """
    if not content or not sources:
        return content, sources

    cited_order: list[int] = []
    for match in _CITATION_GROUP_PATTERN.finditer(content):
        for raw_num in re.findall(r"\d+", match.group(1)):
            idx = int(raw_num)
            if 1 <= idx <= len(sources) and idx not in cited_order:
                cited_order.append(idx)

    if not cited_order:
        if _REFUSAL_ANSWER_PATTERN.search(content):
            return content, []
        return content, sources

    remap = {old_idx: new_idx for new_idx, old_idx in enumerate(cited_order, start=1)}

    def replace_group(match: re.Match[str]) -> str:
        numbers = [int(raw_num) for raw_num in re.findall(r"\d+", match.group(1))]
        valid = [remap[num] for num in numbers if num in remap]
        if not valid:
            return ""
        return "".join(f"[资料 {num}]" for num in valid)

    remapped_content = _CITATION_GROUP_PATTERN.sub(replace_group, content)
    pruned_sources = [sources[old_idx - 1] for old_idx in cited_order]
    return remapped_content, pruned_sources


async def retrieve(state: KnowledgeState) -> KnowledgeState:
    request = state["request"]
    return {**state, "sources": rank_candidates(request.query, request.candidates, request.top_k)}


async def generate(state: KnowledgeState) -> KnowledgeState:
    request = state["request"]
    sources = state["sources"]
    if not sources:
        return {**state, "response": None}
    context = "\n\n".join(
        f"[资料 {index + 1} | {source.id} | {source.title}]\n{source.excerpt}"
        for index, source in enumerate(sources)
    )
    model = create_chat_model(request)
    response = await model.ainvoke([
        SystemMessage(content=KNOWLEDGE_SYSTEM_PROMPT),
        HumanMessage(content=f"问题：\n{request.query}\n\n可用资料：\n{context}"),
    ])
    return {**state, "response": response}


def build_knowledge_graph():
    graph = StateGraph(KnowledgeState)
    graph.add_node("retrieve", retrieve)
    graph.add_node("generate", generate)
    graph.add_edge(START, "retrieve")
    graph.add_edge("retrieve", "generate")
    graph.add_edge("generate", END)
    return graph.compile()


knowledge_graph = build_knowledge_graph()


async def answer_from_knowledge(request: KnowledgeQueryRequest) -> KnowledgeQueryResponse:
    result = await knowledge_graph.ainvoke({"request": request})
    response = result.get("response")
    if response is None:
        return KnowledgeQueryResponse(
            content="当前知识库中没有找到足够相关的资料。",
            model=request.model,
            sources=[],
        )
    request_id, model_name = message_metadata(response, request.model)
    raw_content = message_text(response.content)
    final_content, final_sources = prune_uncited_sources(raw_content, result["sources"])
    return KnowledgeQueryResponse(
        content=final_content,
        usage=message_usage(response),
        provider_request_id=request_id,
        model=model_name,
        sources=final_sources,
    )
