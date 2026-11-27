import asyncio
from dataclasses import dataclass

from openai import AsyncOpenAI

from app.core.config import settings
from app.features.knowledge.schemas import EmbeddingConfiguration
from app.llm.schemas import ModelUsage

DEFAULT_EMBEDDING_DIMENSIONS = 1024
DEFAULT_EMBEDDING_CONCURRENCY = 4


@dataclass(frozen=True)
class EmbeddingBatchResult:
    vectors: list[list[float]]
    usage: ModelUsage | None
    model: str


def resolve_batch_size(configuration: EmbeddingConfiguration) -> int:
    """根据模型规格选择安全的单批文本条数。

    qwen3.7-text-embedding-flash 单批上限 20 条；text-embedding-v3/v4 单批上限 10 条。
    """
    if configuration.batch_size is not None:
        return configuration.batch_size
    model_lower = configuration.model.strip().lower()
    if "text-embedding-v3" in model_lower or "text-embedding-v4" in model_lower:
        return 10
    if "qwen" in model_lower or "dashscope" in configuration.base_url.lower() or "maas.aliyuncs.com" in configuration.base_url.lower():
        return 20
    return 32


def _create_openai_client(configuration: EmbeddingConfiguration) -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=configuration.api_key,
        base_url=configuration.base_url,
        timeout=settings.request_timeout_seconds,
        max_retries=1,
    )


async def embed_texts(texts: list[str], configuration: EmbeddingConfiguration) -> EmbeddingBatchResult:
    """异步分批生成文本向量，并汇总精确 Token 消耗。"""
    if not texts:
        return EmbeddingBatchResult(vectors=[], usage=None, model=configuration.model)

    batch_size = max(1, resolve_batch_size(configuration))
    batches = [texts[index:index + batch_size] for index in range(0, len(texts), batch_size)]
    semaphore = asyncio.Semaphore(DEFAULT_EMBEDDING_CONCURRENCY)
    client = _create_openai_client(configuration)

    async def run_batch(batch: list[str]) -> tuple[list[list[float]], int, int]:
        async with semaphore:
            response = await client.embeddings.create(
                model=configuration.model,
                input=batch,
                dimensions=configuration.dimensions,
                encoding_format="float",
            )
            ordered = sorted(response.data, key=lambda item: item.index)
            vectors = [[float(value) for value in item.embedding] for item in ordered]
            if len(vectors) != len(batch):
                raise ValueError(f"向量接口返回数量异常：期望 {len(batch)}，实际 {len(vectors)}")
            for vector in vectors:
                if len(vector) != configuration.dimensions:
                    raise ValueError(f"向量维度不匹配：期望 {configuration.dimensions}，实际 {len(vector)}")
            prompt_tokens = int(getattr(response.usage, "prompt_tokens", 0) or 0) if response.usage else 0
            total_tokens = int(getattr(response.usage, "total_tokens", prompt_tokens) or prompt_tokens) if response.usage else 0
            return vectors, prompt_tokens, total_tokens

    try:
        batch_results = await asyncio.gather(*(run_batch(batch) for batch in batches))
    finally:
        await client.close()

    all_vectors: list[list[float]] = []
    input_tokens = 0
    total_tokens = 0
    for vectors, batch_prompt_tokens, batch_total_tokens in batch_results:
        all_vectors.extend(vectors)
        input_tokens += batch_prompt_tokens
        total_tokens += batch_total_tokens

    usage = (
        ModelUsage(input_tokens=input_tokens, output_tokens=0, total_tokens=total_tokens)
        if total_tokens > 0 or input_tokens > 0
        else None
    )
    return EmbeddingBatchResult(vectors=all_vectors, usage=usage, model=configuration.model)
