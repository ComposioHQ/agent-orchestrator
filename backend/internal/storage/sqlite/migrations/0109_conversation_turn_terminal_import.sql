-- +goose Up
-- +goose StatementBegin
-- A recovered outcome says only that the provider omitted portable completion
-- metadata. Record the TUI-to-Chat source separately so ordinary Chat resume
-- cannot be mislabeled as a Terminal import.
ALTER TABLE conversation_turns
    ADD COLUMN imported_from_terminal INTEGER NOT NULL DEFAULT 0
        CHECK (imported_from_terminal IN (0, 1));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE conversation_turns DROP COLUMN imported_from_terminal;
-- +goose StatementEnd
