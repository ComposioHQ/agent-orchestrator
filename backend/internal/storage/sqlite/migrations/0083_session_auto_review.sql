-- +goose Up
ALTER TABLE sessions ADD COLUMN auto_review_enabled INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE sessions DROP COLUMN auto_review_enabled;
