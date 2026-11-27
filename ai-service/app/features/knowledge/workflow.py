import math
from typing import Any, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

from app.features.knowledge.prompts import KNOWLEDGE_SYSTEM_PROMPT
from app.features.knowledge.schemas import (
    KnowledgeCandidate,
    KnowledgeQueryRequest,
    KnowledgeQueryResponse,
    KnowledgeSource,
)
from app.llm.factory import create_chat_model
from app.llm.messages import message_metadata, message_text, message_usage
from app.features.knowledge.documents import search_terms


class KnowledgeState(TypedDict, total=False):
    request: KnowledgeQueryRequest
    sources: list[KnowledgeSource]
    response: Any


def _terms(value: str) -> set[str]:
    return set(search_terms(value))


MIN_VECTOR_SCORE = 0.25
RRF_K = 60.0


def rank_candidates(query: str, candidates: list[KnowledgeCandidate], top_k: int) -> list[KnowledgeSource]:
    query_terms = _terms(query)
    has_vector = any(candidate.vector_score is not None for candidate in candidates)
    ranked: list[KnowledgeSource] = []
    for candidate in candidates:
        candidate_terms = _terms(candidate.title + candidate.content)
        overlap = len(query_terms & candidate_terms)
        lexical_score = overlap / math.sqrt(max(1, len(query_terms)) * max(1, len(candidate_terms)))
        if has_vector:
            vector_score = max(0.0, float(candidate.vector_score)) if candidate.vector_score is not None else 0.0
            if lexical_score <= 0 and vector_score < MIN_VECTOR_SCORE:
                continue
            rrf_bonus = 0.0
            if candidate.vector_rank is not None:
                rrf_bonus += 1.0 / (RRF_K + candidate.vector_rank)
            if candidate.lexical_rank is not None:
                rrf_bonus += 1.0 / (RRF_K + candidate.lexical_rank)
            # 融合向量余弦相似度、词项重合度与双路 RRF 增益（归一化至约 0~1）
            score = 0.62 * vector_score + 0.23 * lexical_score + 0.15 * min(1.0, rrf_bonus * (RRF_K / 2.0))
        else:
            score = lexical_score
            if score <= 0:
                continue
        ranked.append(KnowledgeSource(
            id=candidate.id,
            title=candidate.title,
            excerpt=candidate.content[:1200],
            score=round(score, 6),
            metadata=candidate.metadata,
        ))
    return sorted(ranked, key=lambda item: item.score, reverse=True)[:top_k]


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
    return KnowledgeQueryResponse(
        content=message_text(response.content),
        usage=message_usage(response),
        provider_request_id=request_id,
        model=model_name,
        sources=result["sources"],
    )
