-- V22: 支持多提供商与自主 Agent 专用模型通道（如火山引擎方舟 Agent Plan），MCP 助手与知识库继续使用默认主模型
ALTER TABLE ai_model_configuration DROP CONSTRAINT IF EXISTS ck_ai_model_provider;
ALTER TABLE ai_model_configuration ADD CONSTRAINT ck_ai_model_provider
    CHECK (provider IN ('QWEN', 'VOLCENGINE_ARK', 'OPENAI_COMPATIBLE'));

ALTER TABLE ai_model_configuration
    ADD COLUMN IF NOT EXISTS agent_provider varchar(40),
    ADD COLUMN IF NOT EXISTS agent_model_name varchar(120),
    ADD COLUMN IF NOT EXISTS agent_base_url varchar(500),
    ADD COLUMN IF NOT EXISTS encrypted_agent_api_key text;

ALTER TABLE ai_model_configuration DROP CONSTRAINT IF EXISTS ck_ai_model_agent_provider;
ALTER TABLE ai_model_configuration ADD CONSTRAINT ck_ai_model_agent_provider
    CHECK (agent_provider IS NULL OR agent_provider IN ('QWEN', 'VOLCENGINE_ARK', 'OPENAI_COMPATIBLE'));

COMMENT ON COLUMN ai_model_configuration.agent_provider IS '自主 Agent 专用模型提供商（如 VOLCENGINE_ARK）；为空时回退使用主模型配置。';
COMMENT ON COLUMN ai_model_configuration.agent_model_name IS '自主 Agent 专用模型名称（如 doubao-seed-2.1-pro）；为空时回退使用主模型。';
COMMENT ON COLUMN ai_model_configuration.agent_base_url IS '自主 Agent 专用 API 地址（如火山方舟 Agent Plan: https://ark.cn-beijing.volces.com/api/plan/v3）。';
COMMENT ON COLUMN ai_model_configuration.encrypted_agent_api_key IS '使用 AES-256-GCM 加密保存的自主 Agent 专用 API Key 密文。';
