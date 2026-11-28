ALTER TABLE ai_model_configuration
    ADD COLUMN IF NOT EXISTS agent_afp_baseline_5h numeric(12, 3)
        CHECK (agent_afp_baseline_5h IS NULL OR agent_afp_baseline_5h >= 0),
    ADD COLUMN IF NOT EXISTS agent_afp_baseline_7d numeric(12, 3)
        CHECK (agent_afp_baseline_7d IS NULL OR agent_afp_baseline_7d >= 0),
    ADD COLUMN IF NOT EXISTS agent_afp_baseline_30d numeric(12, 3)
        CHECK (agent_afp_baseline_30d IS NULL OR agent_afp_baseline_30d >= 0),
    ADD COLUMN IF NOT EXISTS agent_afp_calibrated_at timestamptz;
