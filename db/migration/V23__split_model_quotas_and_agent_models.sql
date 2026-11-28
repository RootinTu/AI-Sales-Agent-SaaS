ALTER TABLE ai_model_configuration
    ADD COLUMN IF NOT EXISTS agent_available_models text;

ALTER TABLE organization_token_budget
    ADD COLUMN IF NOT EXISTS embedding_total_tokens bigint
        CHECK (embedding_total_tokens IS NULL OR embedding_total_tokens >= 0);

ALTER TABLE member_token_quota
    ALTER COLUMN allocated_tokens DROP NOT NULL;

ALTER TABLE member_token_quota
    ADD COLUMN IF NOT EXISTS embedding_allocated_tokens bigint
        CHECK (embedding_allocated_tokens IS NULL OR embedding_allocated_tokens >= 0);

ALTER TABLE assistant_conversation
    ADD COLUMN IF NOT EXISTS mode varchar(16) NOT NULL DEFAULT 'LIGHT'
        CHECK (mode IN ('LIGHT', 'AGENT'));

ALTER TABLE assistant_conversation
    ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE assistant_conversation conv
SET mode = 'AGENT',
    expires_at = NULL
WHERE EXISTS (
    SELECT 1
    FROM assistant_message msg
    WHERE msg.conversation_id = conv.id
      AND msg.data->>'assistantMode' = 'AGENT'
);

UPDATE assistant_conversation
SET expires_at = COALESCE(last_message_at, created_at) + INTERVAL '7 days'
WHERE mode = 'LIGHT'
  AND expires_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_assistant_conversation_org_member_mode_recent
    ON assistant_conversation (organization_id, member_id, mode, last_message_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_assistant_conversation_expires_at
    ON assistant_conversation (expires_at)
    WHERE expires_at IS NOT NULL;
