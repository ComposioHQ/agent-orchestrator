-- +goose Up
ALTER TABLE conversations ADD COLUMN latest_turn_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_turns ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;

WITH ordered AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY conversation_id
               ORDER BY requested_at, id
           ) AS sequence
    FROM conversation_turns
)
UPDATE conversation_turns
SET sequence = (SELECT ordered.sequence FROM ordered WHERE ordered.id = conversation_turns.id);

UPDATE conversations
SET latest_turn_sequence = COALESCE((
    SELECT MAX(sequence)
    FROM conversation_turns
    WHERE conversation_turns.conversation_id = conversations.id
), 0);

CREATE UNIQUE INDEX idx_conversation_turns_sequence
    ON conversation_turns(conversation_id, sequence);

-- +goose Down
DROP INDEX IF EXISTS idx_conversation_turns_sequence;
ALTER TABLE conversation_turns DROP COLUMN sequence;
ALTER TABLE conversations DROP COLUMN latest_turn_sequence;
