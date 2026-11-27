from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from app.llm.schemas import ModelConfiguration, ModelResponse, ModelUsage


class EmbeddingConfiguration(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    api_key: str = Field(min_length=1, validation_alias=AliasChoices("api_key", "apiKey"))
    base_url: str = Field(min_length=1, validation_alias=AliasChoices("base_url", "baseUrl"))
    model: str = Field(min_length=1, max_length=120)
    dimensions: int = Field(default=1024, ge=64, le=4096)
    batch_size: int | None = Field(default=None, ge=1, le=2048, validation_alias=AliasChoices("batch_size", "batchSize"))


class KnowledgeCandidate(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(default="", max_length=500)
    content: str = Field(min_length=1, max_length=20000)
    metadata: dict[str, Any] = Field(default_factory=dict)
    vector_score: float | None = Field(default=None, ge=-1.0, le=1.0, validation_alias=AliasChoices("vector_score", "vectorScore"))
    vector_rank: int | None = Field(default=None, ge=1, validation_alias=AliasChoices("vector_rank", "vectorRank"))
    lexical_rank: int | None = Field(default=None, ge=1, validation_alias=AliasChoices("lexical_rank", "lexicalRank"))


class KnowledgeQueryRequest(ModelConfiguration):
    query: str = Field(min_length=1, max_length=2000)
    candidates: list[KnowledgeCandidate] = Field(default_factory=list, max_length=100)
    top_k: int = Field(default=4, ge=1, le=10)


class KnowledgeSource(BaseModel):
    id: str
    title: str
    excerpt: str
    score: float
    metadata: dict[str, Any] = Field(default_factory=dict)


class KnowledgeQueryResponse(ModelResponse):
    sources: list[KnowledgeSource] = Field(default_factory=list)


class DocumentIngestRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    title: str = Field(min_length=1, max_length=255)
    category: str = Field(default="OTHER", max_length=40)
    content_base64: str = Field(min_length=1, max_length=13981016)
    embedding: EmbeddingConfiguration | None = None


class DocumentChunk(BaseModel):
    chunk_index: int
    page_number: int | None = None
    content: str
    search_terms: str
    embedding: list[float] | None = None


class DocumentIngestResponse(BaseModel):
    chunks: list[DocumentChunk]
    character_count: int
    embedding_model: str | None = None
    embedding_usage: ModelUsage | None = None
    embedding_error: str | None = None


class SearchTermsRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    embedding: EmbeddingConfiguration | None = None


class SearchTermsResponse(BaseModel):
    search_query: str
    query_embedding: list[float] | None = None
    embedding_model: str | None = None
    embedding_usage: ModelUsage | None = None
    embedding_error: str | None = None
