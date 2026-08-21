-- Capture review-run lifecycle changes in change_log so the desktop can react
-- immediately when a review pass is created or changes state.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE change_log_new (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects (id),
    session_id TEXT REFERENCES sessions (id),
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'session_created',
            'session_updated',
            'pr_created',
            'pr_updated',
            'pr_check_recorded',
            'pr_session_changed',
            'pr_review_thread_added',
            'pr_review_thread_resolved',
            'review_run_created',
            'review_run_updated'
        )),
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    created_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO change_log_new (seq, project_id, session_id, event_type, payload, created_at)
SELECT seq, project_id, session_id, event_type, payload, created_at
FROM change_log;

DROP INDEX IF EXISTS idx_change_log_project;
DROP VIEW IF EXISTS change_log_old;
DROP TRIGGER IF EXISTS change_log_old_insert;
ALTER TABLE change_log RENAME TO change_log_old;
ALTER TABLE change_log_new RENAME TO change_log;
DROP TABLE change_log_old;
CREATE INDEX idx_change_log_project ON change_log (project_id, seq);

CREATE VIEW change_log_old AS
SELECT seq, project_id, session_id, event_type, payload, created_at
FROM change_log;

CREATE TRIGGER change_log_old_insert
INSTEAD OF INSERT ON change_log_old
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.session_id, NEW.event_type, NEW.payload, NEW.created_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TRIGGER IF EXISTS review_run_cdc_insert;
DROP TRIGGER IF EXISTS review_run_cdc_update;

CREATE TRIGGER review_run_cdc_insert
AFTER INSERT ON review_run
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT project_id FROM sessions WHERE id = NEW.session_id),
        NEW.session_id,
        'review_run_created',
        json_object(
            'id', NEW.id,
            'reviewId', NEW.review_id,
            'sessionId', NEW.session_id,
            'pr', NEW.pr_url,
            'targetSha', NEW.target_sha,
            'status', NEW.status,
            'verdict', NEW.verdict,
            'triggerSource', NEW.trigger_source,
            'githubReviewId', NEW.github_review_id,
            'autoInjectReview', json(CASE WHEN NEW.auto_inject_review THEN 'true' ELSE 'false' END)
        ),
        NEW.created_at);
END;

CREATE TRIGGER review_run_cdc_update
AFTER UPDATE ON review_run
WHEN OLD.status <> NEW.status
    OR OLD.verdict <> NEW.verdict
    OR OLD.body <> NEW.body
    OR OLD.github_review_id <> NEW.github_review_id
    OR OLD.auto_inject_review <> NEW.auto_inject_review
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT project_id FROM sessions WHERE id = NEW.session_id),
        NEW.session_id,
        'review_run_updated',
        json_object(
            'id', NEW.id,
            'reviewId', NEW.review_id,
            'sessionId', NEW.session_id,
            'pr', NEW.pr_url,
            'targetSha', NEW.target_sha,
            'status', NEW.status,
            'verdict', NEW.verdict,
            'triggerSource', NEW.trigger_source,
            'githubReviewId', NEW.github_review_id,
            'autoInjectReview', json(CASE WHEN NEW.auto_inject_review THEN 'true' ELSE 'false' END)
        ),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS review_run_cdc_insert;
DROP TRIGGER IF EXISTS review_run_cdc_update;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE change_log_old (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects (id),
    session_id TEXT REFERENCES sessions (id),
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'session_created',
            'session_updated',
            'pr_created',
            'pr_updated',
            'pr_check_recorded',
            'pr_session_changed',
            'pr_review_thread_added',
            'pr_review_thread_resolved'
        )),
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    created_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO change_log_old (seq, project_id, session_id, event_type, payload, created_at)
SELECT seq, project_id, session_id, event_type, payload, created_at
FROM change_log
WHERE event_type NOT IN ('review_run_created', 'review_run_updated');

DROP INDEX IF EXISTS idx_change_log_project;
DROP VIEW IF EXISTS change_log_new;
DROP TRIGGER IF EXISTS change_log_new_insert;
ALTER TABLE change_log RENAME TO change_log_new;
ALTER TABLE change_log_old RENAME TO change_log;
DROP TABLE change_log_new;
CREATE INDEX idx_change_log_project ON change_log (project_id, seq);

CREATE VIEW change_log_new AS
SELECT seq, project_id, session_id, event_type, payload, created_at
FROM change_log;

CREATE TRIGGER change_log_new_insert
INSTEAD OF INSERT ON change_log_new
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.session_id, NEW.event_type, NEW.payload, NEW.created_at);
END;
-- +goose StatementEnd
