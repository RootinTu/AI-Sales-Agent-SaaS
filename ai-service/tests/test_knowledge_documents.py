import asyncio
import base64
from io import BytesIO

import pytest
from docx import Document
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from pypdf import PdfWriter

from app.main import app
from app.core.config import settings
from app.features.knowledge.documents import ingest_document, search_query, search_terms
from app.features.knowledge.schemas import DocumentIngestRequest, KnowledgeCandidate, KnowledgeQueryRequest
from app.features.knowledge.workflow import answer_from_knowledge


def request(filename: str, content: bytes) -> DocumentIngestRequest:
    return DocumentIngestRequest(filename=filename, title="销售手册", category="PLAYBOOK", content_base64=base64.b64encode(content).decode())


def test_ingest_chinese_text_has_bounded_chunks_and_searchable_terms():
    content = ("报价审批需要销售经理确认。客户报价附件必须核对。\n" * 100).encode()
    result = ingest_document(request("报价流程.md", content))
    assert len(result.chunks) > 1
    assert all(len(chunk.content) <= 900 for chunk in result.chunks)
    assert [chunk.chunk_index for chunk in result.chunks] == list(range(len(result.chunks)))
    assert "报价" in result.chunks[0].search_terms.split()
    assert result.character_count == len(content.decode())


def test_supports_gb18030_text():
    result = ingest_document(request("销售.txt", "报价审批".encode("gb18030")))
    assert result.chunks[0].content == "报价审批"


def test_extracts_docx_paragraphs_and_tables():
    doc = Document()
    doc.add_paragraph("标准版报价")
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "企业版"
    table.cell(0, 1).text = "联系销售"
    output = BytesIO(); doc.save(output)
    result = ingest_document(request("报价.docx", output.getvalue()))
    assert "标准版报价" in result.chunks[0].content
    assert "企业版 | 联系销售" in result.chunks[0].content


def test_blank_pdf_requires_ocr_instead_of_inventing_text():
    writer = PdfWriter(); writer.add_blank_page(width=300, height=300)
    output = BytesIO(); writer.write(output)
    with pytest.raises(ValueError, match="OCR"):
        ingest_document(request("scan.pdf", output.getvalue()))


@pytest.mark.parametrize("filename,content", [("run.exe", b"hello"), ("empty.txt", b""), ("binary.txt", b"\x00\x01")])
def test_rejects_unsupported_empty_and_binary_files(filename, content):
    with pytest.raises(ValueError):
        ingest_document(request(filename, content))


def test_terms_are_safe_tsquery_tokens():
    assert "报价" in search_terms("报价流程")
    assert "crm" in search_terms("CRM pricing")
    assert all(term.strip().isalnum() or "_" in term for term in search_terms("x' | : & ! () 报价"))
    assert search_query("? | & !") == ""


def test_ingestion_and_terms_require_internal_auth(monkeypatch):
    monkeypatch.setattr(settings, "token", "internal-test")
    client = TestClient(app)
    assert client.post("/v1/knowledge/ingest", json=request("a.txt", b"hello").model_dump()).status_code == 401
    response = client.post("/v1/knowledge/terms", headers={"Authorization": "Bearer internal-test"}, json={"query": "报价"})
    assert response.status_code == 200
    assert response.json()["search_query"] == "报价"


def test_parse_error_is_a_readable_400():
    response = TestClient(app).post("/v1/knowledge/ingest", json=request("a.exe", b"hello").model_dump())
    assert response.status_code == 400
    assert "支持" in response.json()["detail"]


def test_grounded_answer_preserves_sources_and_usage(monkeypatch):
    class FakeModel:
        async def ainvoke(self, messages):
            assert "资料 1" in messages[1].content
            assert "销售经理审批" in messages[1].content
            return AIMessage(content="需要销售经理审批。[资料 1]", usage_metadata={"input_tokens": 20, "output_tokens": 10, "total_tokens": 30})
    monkeypatch.setattr("app.features.knowledge.workflow.create_chat_model", lambda _: FakeModel())
    result = asyncio.run(answer_from_knowledge(KnowledgeQueryRequest(api_key="test", base_url="https://example.invalid/v1", model="test",
        query="报价审批", candidates=[KnowledgeCandidate(id="source-1", title="报价流程", content="报价须经销售经理审批")])))
    assert result.sources[0].id == "source-1"
    assert result.usage.total_tokens == 30
    assert "[资料 1]" in result.content


def test_no_match_does_not_call_model(monkeypatch):
    def unexpected(_):
        raise AssertionError("no model call expected")
    monkeypatch.setattr("app.features.knowledge.workflow.create_chat_model", unexpected)
    result = asyncio.run(answer_from_knowledge(KnowledgeQueryRequest(api_key="test", base_url="https://example.invalid/v1", model="test", query="报价", candidates=[])))
    assert result.sources == []
    assert result.usage is None


def test_resolve_batch_size_and_embed_batches_for_qwen37_flash(monkeypatch):
    from types import SimpleNamespace
    from app.features.knowledge.embeddings import embed_texts, resolve_batch_size
    from app.features.knowledge.schemas import EmbeddingConfiguration

    qwen37 = EmbeddingConfiguration(
        api_key="sk-test",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.7-text-embedding-flash",
        dimensions=64,
    )
    qwen_v3 = EmbeddingConfiguration(
        api_key="sk-test",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="text-embedding-v3",
        dimensions=64,
    )
    assert resolve_batch_size(qwen37) == 20
    assert resolve_batch_size(qwen_v3) == 10

    seen_batches: list[list[str]] = []

    class FakeEmbeddingsApi:
        async def create(self, *, model, input, dimensions, encoding_format):
            assert model == "qwen3.7-text-embedding-flash"
            assert dimensions == 64
            assert encoding_format == "float"
            seen_batches.append(list(input))
            return SimpleNamespace(
                data=[SimpleNamespace(index=idx, embedding=[float(idx + 1)] + [0.0] * 63) for idx in range(len(input))],
                usage=SimpleNamespace(prompt_tokens=len(input) * 5, total_tokens=len(input) * 5),
            )

    class FakeClient:
        embeddings = FakeEmbeddingsApi()

        async def close(self):
            return None

    monkeypatch.setattr("app.features.knowledge.embeddings._create_openai_client", lambda _: FakeClient())
    texts = [f"片段-{i}" for i in range(25)]
    result = asyncio.run(embed_texts(texts, qwen37))
    assert len(result.vectors) == 25
    assert sorted(len(batch) for batch in seen_batches) == [5, 20]
    assert result.usage is not None
    assert result.usage.input_tokens == 125
    assert result.usage.total_tokens == 125


def test_ingest_and_terms_return_embeddings_and_degrade_gracefully(monkeypatch):
    from app.features.knowledge.embeddings import EmbeddingBatchResult
    from app.llm.schemas import ModelUsage

    sample_vec = [0.1] * 64

    async def fake_embed(texts, config):
        return EmbeddingBatchResult(
            vectors=[sample_vec for _ in texts],
            usage=ModelUsage(input_tokens=12, output_tokens=0, total_tokens=12),
            model=config.model,
        )

    monkeypatch.setattr("app.features.knowledge.router.embed_texts", fake_embed)
    monkeypatch.setattr(settings, "token", "")
    client = TestClient(app)

    embedding_cfg = {
        "api_key": "sk-test",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen3.7-text-embedding-flash",
        "dimensions": 64,
    }
    ingest_payload = request("报价.txt", "客户折扣需要销售总监审批".encode()).model_dump()
    ingest_payload["embedding"] = embedding_cfg
    ingest_resp = client.post("/v1/knowledge/ingest", json=ingest_payload)
    assert ingest_resp.status_code == 200
    ingest_json = ingest_resp.json()
    assert ingest_json["embedding_model"] == "qwen3.7-text-embedding-flash"
    assert ingest_json["embedding_usage"]["total_tokens"] == 12
    assert ingest_json["chunks"][0]["embedding"] == sample_vec

    terms_resp = client.post("/v1/knowledge/terms", json={"query": "打折流程", "embedding": embedding_cfg})
    assert terms_resp.status_code == 200
    terms_json = terms_resp.json()
    assert terms_json["query_embedding"] == sample_vec
    assert terms_json["embedding_usage"]["total_tokens"] == 12

    async def failing_embed(texts, config):
        raise RuntimeError("upstream 503")

    monkeypatch.setattr("app.features.knowledge.router.embed_texts", failing_embed)
    degraded = client.post("/v1/knowledge/ingest", json=ingest_payload)
    assert degraded.status_code == 200
    assert degraded.json()["chunks"][0]["embedding"] is None
    assert "503" in degraded.json()["embedding_error"]


def test_hybrid_ranking_recalls_semantic_match_without_lexical_overlap():
    from app.features.knowledge.workflow import rank_candidates

    candidates = [
        KnowledgeCandidate(
            id="semantic-only",
            title="价格与优惠规则",
            content="大客户年度采购可申请阶梯返点与特别价格优惠。",
            vector_score=0.86,
            vector_rank=1,
        ),
        KnowledgeCandidate(
            id="weak-unrelated",
            title="React 前端核心笔记",
            content="React 核心组件状态更新，怎么推导 TypeScript 泛型。",
            vector_score=0.45,
            vector_rank=2,
            lexical_rank=1,
        ),
        KnowledgeCandidate(
            id="low-noise",
            title="考勤制度",
            content="员工工作日需按时打卡。",
            vector_score=0.12,
            vector_rank=10,
        ),
    ]
    sources = rank_candidates("怎么给核心重点客户申请打折", candidates, top_k=3)
    assert [source.id for source in sources] == ["semantic-only"]
    assert sources[0].score > 0.5


def test_prune_uncited_sources_keeps_only_cited_and_renumbers():
    from app.features.knowledge.schemas import KnowledgeSource
    from app.features.knowledge.workflow import prune_uncited_sources

    sources = [
        KnowledgeSource(id="s1", title="大客户优惠政策", excerpt="A", score=0.8),
        KnowledgeSource(id="s2", title="无关 React 笔记", excerpt="B", score=0.4),
        KnowledgeSource(id="s3", title="审批流程补充", excerpt="C", score=0.6),
    ]
    content, pruned = prune_uncited_sources("适用条件为 50 万以上 [资料 1]，并参考补充规定 [资料 3]。", sources)
    assert [source.id for source in pruned] == ["s1", "s3"]
    assert content == "适用条件为 50 万以上 [资料 1]，并参考补充规定 [资料 2]。"


def test_prune_uncited_sources_clears_sources_on_explicit_refusal():
    from app.features.knowledge.schemas import KnowledgeSource
    from app.features.knowledge.workflow import prune_uncited_sources

    sources = [
        KnowledgeSource(id="s1", title="上海自贸区基本户规程", excerpt="A", score=0.6),
        KnowledgeSource(id="s2", title="上海普通基本户说明", excerpt="B", score=0.5),
    ]
    content, pruned = prune_uncited_sources("当前知识库中没有相关记载，无法确认周六营业时间。", sources)
    assert pruned == []
    assert "无法确认" in content


def test_rank_candidates_penalizes_deprecated_docs_unless_historical_query():
    from app.features.knowledge.workflow import rank_candidates

    candidates = [
        KnowledgeCandidate(
            id="draft-a06",
            title="A06_成都分行工程款专用账户操作规程_修订稿",
            content="文件状态 征求意见稿/从未生效。拟议改为系统自动终审。",
            vector_score=0.78,
            vector_rank=1,
            metadata={"document_id": "doc-a06"},
        ),
        KnowledgeCandidate(
            id="active-a02",
            title="A02_成都分行建筑企业工程款专用账户操作规程_V1.2",
            content="文件状态 现行有效。由开户网点运营主管复核，成都分行公司金融运营部终审。",
            vector_score=0.72,
            vector_rank=2,
            metadata={"document_id": "doc-a02"},
        ),
    ]
    normal_sources = rank_candidates("成都工程款专户最后要走到哪个部门，能不能系统自动终审？", candidates, top_k=2)
    assert normal_sources[0].id == "active-a02"

    historical_sources = rank_candidates("修订稿里对自动终审是怎么写的？", candidates, top_k=2)
    assert historical_sources[0].id == "draft-a06"


def test_rank_candidates_enforces_per_document_cap_and_includes_adjacent_chunk():
    from app.features.knowledge.workflow import rank_candidates

    candidates = [
        KnowledgeCandidate(id="d1-c0", title="文档1", content="成都工程款专户适用范围", vector_score=0.88, vector_rank=1, metadata={"document_id": "d1", "chunk_index": 0}),
        KnowledgeCandidate(id="d1-c1", title="文档1", content="单笔300万元、日累计1000万元、T+3", vector_score=0.84, metadata={"document_id": "d1", "chunk_index": 1, "adjacent": True}),
        KnowledgeCandidate(id="d1-c2", title="文档1", content="持续监测条款", vector_score=0.83, vector_rank=2, metadata={"document_id": "d1", "chunk_index": 2}),
        KnowledgeCandidate(id="d1-c3", title="文档1", content="归档留痕条款", vector_score=0.82, vector_rank=3, metadata={"document_id": "d1", "chunk_index": 3}),
        KnowledgeCandidate(id="d2-c0", title="文档2", content="补充通知附加材料要求", vector_score=0.80, vector_rank=4, metadata={"document_id": "d2", "chunk_index": 0}),
        KnowledgeCandidate(id="d3-c0", title="文档3", content="支付限额与工作日计算示例", vector_score=0.79, vector_rank=5, metadata={"document_id": "d3", "chunk_index": 0}),
    ]
    sources = rank_candidates("成都工程款专户限额和补充材料", candidates, top_k=4)
    doc_ids = [s.metadata["document_id"] for s in sources]
    assert doc_ids.count("d1") == 2
    assert "d2" in doc_ids
    assert "d3" in doc_ids
    assert any(s.id == "d1-c1" for s in sources)
