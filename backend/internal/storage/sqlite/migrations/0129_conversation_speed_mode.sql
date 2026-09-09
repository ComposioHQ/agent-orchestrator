-- +goose Up
-- +goose StatementBegin
-- Provider-advertised speed/service-tier choice for the next native Chat turn.
ALTER TABLE conversations ADD COLUMN speed_mode TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Nullable and ignored by older builds; preserve it on downgrade.
SELECT 1;
-- +goose StatementEnd
