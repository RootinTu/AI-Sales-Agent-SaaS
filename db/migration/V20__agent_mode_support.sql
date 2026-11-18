-- V20: 扩展模型调用目的约束以支持规划与自主 Agent 推理记录
ALTER TABLE model_call DROP CONSTRAINT IF EXISTS ck_model_call_purpose;
ALTER TABLE model_call ADD CONSTRAINT ck_model_call_purpose
    CHECK (purpose IN ('SALES_ANALYSIS', 'EMAIL_DRAFT', 'SUMMARY', 'KNOWLEDGE_QA', 'PLANNING', 'AGENT_PLAN'));
