-- V21: 引入 pgvector 扩展支持企业知识库语义向量检索（默认适配 qwen3.7-text-embedding-flash 1024 维）
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE ai_model_configuration
    ADD COLUMN IF NOT EXISTS embedding_model varchar(120);

COMMENT ON COLUMN ai_model_configuration.embedding_model IS '可选的组织级向量模型名称；为空时回退至系统默认值（qwen3.7-text-embedding-flash）。';

ALTER TABLE knowledge_chunk
    ADD COLUMN IF NOT EXISTS embedding vector(1024),
    ADD COLUMN IF NOT EXISTS embedding_model varchar(120);

COMMENT ON COLUMN knowledge_chunk.embedding IS '片段的 1024 维语义向量，用于 pgvector 余弦相似度检索；为空时自动降级为全文检索。';
COMMENT ON COLUMN knowledge_chunk.embedding_model IS '生成该向量的 Embedding 模型名称，防止跨模型向量混用。';

CREATE INDEX IF NOT EXISTS ix_knowledge_chunk_embedding_hnsw
    ON knowledge_chunk USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;

ALTER TABLE model_call DROP CONSTRAINT IF EXISTS ck_model_call_purpose;
ALTER TABLE model_call ADD CONSTRAINT ck_model_call_purpose
    CHECK (purpose IN ('SALES_ANALYSIS', 'EMAIL_DRAFT', 'SUMMARY', 'KNOWLEDGE_QA', 'KNOWLEDGE_EMBEDDING', 'PLANNING', 'AGENT_PLAN'));
