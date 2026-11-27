import logging

from fastapi import APIRouter, Depends, HTTPException

from app.core.security import verify_internal_token
from app.features.knowledge import workflow
from app.features.knowledge.documents import ingest_document, search_query
from app.features.knowledge.embeddings import embed_texts
from app.features.knowledge.schemas import (
    DocumentIngestRequest,
    DocumentIngestResponse,
    KnowledgeQueryRequest,
    KnowledgeQueryResponse,
    SearchTermsRequest,
    SearchTermsResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1/knowledge",
    tags=["knowledge"],
    dependencies=[Depends(verify_internal_token)],
)


@router.post("/query", response_model=KnowledgeQueryResponse)
async def knowledge_query(request: KnowledgeQueryRequest) -> KnowledgeQueryResponse:
    return await workflow.answer_from_knowledge(request)


@router.post("/ingest", response_model=DocumentIngestResponse)
async def knowledge_ingest(request: DocumentIngestRequest) -> DocumentIngestResponse:
    try:
        result = ingest_document(request)
    except ValueError as exception:
        raise HTTPException(status_code=400, detail=str(exception)) from exception
    except Exception as exception:
        raise HTTPException(status_code=400, detail="文件无法解析，请确认格式和内容有效") from exception

    if request.embedding is None or not result.chunks:
        return result

    try:
        texts = [f"{request.title}\n{chunk.content}" for chunk in result.chunks]
        embedded = await embed_texts(texts, request.embedding)
        enriched_chunks = [
            chunk.model_copy(update={"embedding": vector})
            for chunk, vector in zip(result.chunks, embedded.vectors, strict=True)
        ]
        return result.model_copy(
            update={
                "chunks": enriched_chunks,
                "embedding_model": embedded.model,
                "embedding_usage": embedded.usage,
                "embedding_error": None,
            }
        )
    except Exception as exception:
        logger.warning("Knowledge document embedding failed, falling back to full-text index: %s", exception)
        return result.model_copy(
            update={
                "embedding_error": str(exception)[:500] or "向量化服务暂不可用，已降级为全文检索",
            }
        )


@router.post("/terms", response_model=SearchTermsResponse)
async def knowledge_terms(request: SearchTermsRequest) -> SearchTermsResponse:
    query_terms = search_query(request.query)
    if request.embedding is None:
        return SearchTermsResponse(search_query=query_terms)

    try:
        embedded = await embed_texts([request.query], request.embedding)
        vector = embedded.vectors[0] if embedded.vectors else None
        return SearchTermsResponse(
            search_query=query_terms,
            query_embedding=vector,
            embedding_model=embedded.model,
            embedding_usage=embedded.usage,
        )
    except Exception as exception:
        logger.warning("Knowledge query embedding failed, falling back to full-text search: %s", exception)
        return SearchTermsResponse(
            search_query=query_terms,
            embedding_error=str(exception)[:500] or "问题向量化失败，已降级为全文检索",
        )
