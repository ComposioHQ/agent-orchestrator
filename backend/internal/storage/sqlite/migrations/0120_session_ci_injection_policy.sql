-- CI-failure injection is a session policy. Keeping a copied value on each PR
-- creates a second source of truth and makes policy changes harder to reason
-- about. PR summaries derive the value from their owning session.

-- +goose Up
DROP TRIGGER IF EXISTS pr_cdc_update;

-- +goose StatementBegin
CREATE TRIGGER pr_cdc_update
AFTER UPDATE ON pr
WHEN OLD.pr_state <> NEW.pr_state
    OR OLD.ci_state <> NEW.ci_state
    OR OLD.review_decision <> NEW.review_decision
    OR OLD.mergeability <> NEW.mergeability
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'pr_updated',
        json_object('url', NEW.url, 'session', NEW.session_id, 'state', NEW.pr_state,
                    'ci', NEW.ci_state, 'review', NEW.review_decision, 'mergeability', NEW.mergeability),
        NEW.updated_at);
END;
-- +goose StatementEnd

ALTER TABLE pr DROP COLUMN auto_inject_ci;

-- +goose Down
ALTER TABLE pr ADD COLUMN auto_inject_ci BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE pr
SET auto_inject_ci = COALESCE(
    (SELECT sessions.auto_inject_ci FROM sessions WHERE sessions.id = pr.session_id),
    TRUE
);

DROP TRIGGER IF EXISTS pr_cdc_update;

-- +goose StatementBegin
CREATE TRIGGER pr_cdc_update
AFTER UPDATE ON pr
WHEN OLD.pr_state <> NEW.pr_state
    OR OLD.ci_state <> NEW.ci_state
    OR OLD.review_decision <> NEW.review_decision
    OR OLD.mergeability <> NEW.mergeability
    OR OLD.auto_inject_ci <> NEW.auto_inject_ci
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'pr_updated',
        json_object('url', NEW.url, 'session', NEW.session_id, 'state', NEW.pr_state,
                    'ci', NEW.ci_state, 'review', NEW.review_decision, 'mergeability', NEW.mergeability,
                    'autoInjectCI', json(CASE WHEN NEW.auto_inject_ci THEN 'true' ELSE 'false' END)),
        NEW.updated_at);
END;
-- +goose StatementEnd
