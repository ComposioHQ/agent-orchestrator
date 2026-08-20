-- +goose Up
-- +goose StatementBegin
ALTER TABLE usage_bindings
    ADD COLUMN provider_hint TEXT NOT NULL DEFAULT '';

ALTER TABLE model_usage_events
    ADD COLUMN provider_id TEXT
        CHECK (provider_id IS NULL OR trim(provider_id) <> '');
ALTER TABLE model_usage_events
    ADD COLUMN cache_write_5m_tokens INTEGER
        CHECK (cache_write_5m_tokens IS NULL OR cache_write_5m_tokens >= 0);
ALTER TABLE model_usage_events
    ADD COLUMN cache_write_1h_tokens INTEGER
        CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0);
ALTER TABLE model_usage_events
    ADD COLUMN uncached_input_cost_nanos INTEGER
        CHECK (uncached_input_cost_nanos IS NULL OR uncached_input_cost_nanos >= 0);
ALTER TABLE model_usage_events
    ADD COLUMN cache_read_cost_nanos INTEGER
        CHECK (cache_read_cost_nanos IS NULL OR cache_read_cost_nanos >= 0);
ALTER TABLE model_usage_events
    ADD COLUMN cache_write_cost_nanos INTEGER
        CHECK (cache_write_cost_nanos IS NULL OR cache_write_cost_nanos >= 0);
ALTER TABLE model_usage_events
    ADD COLUMN output_cost_nanos INTEGER
        CHECK (output_cost_nanos IS NULL OR output_cost_nanos >= 0);
ALTER TABLE model_usage_events
    ADD COLUMN estimated_cost_nanos INTEGER
        CHECK (estimated_cost_nanos IS NULL OR estimated_cost_nanos >= 0);
ALTER TABLE model_usage_events
    ADD COLUMN pricing_version TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_model_usage_events_cost_candidates
    ON model_usage_events (provider_id, pricing_version, id)
    WHERE estimated_cost_nanos IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- This migration is intentionally additive. Rebuilding both durable usage
-- tables to remove nullable/defaulted columns would add downgrade data-loss
-- risk without restoring any behavior required by an older binary.
SELECT 1;
-- +goose StatementEnd
