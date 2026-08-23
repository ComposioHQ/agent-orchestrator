-- +goose Up
-- +goose StatementBegin
-- `turn_complete` was added to the domain, the DTO enum, and the notification
-- queries, but never to this CHECK. Every insert of one therefore failed with
-- "CHECK constraint failed", and because notification writes are best-effort by
-- design (a failed notification must never fail the lifecycle write that
-- produced it) the error was logged as a warning and the notification silently
-- dropped. SQLite cannot alter a CHECK in place, so the table is rebuilt.
CREATE TABLE notifications_new (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pr_url TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (
        type IN (
            'needs_input',
            'turn_complete',
            'ready_to_merge',
            'pr_merged',
            'pr_closed_unmerged'
        )
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('read', 'unread')),
    created_at TIMESTAMP NOT NULL,
    resolved_at TIMESTAMP
);

INSERT INTO notifications_new (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, resolved_at
)
SELECT id, session_id, project_id, pr_url, type, title, body, status, created_at, resolved_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

-- Recreated verbatim from 0031 and 0041; DROP TABLE took them with it.
CREATE INDEX idx_notifications_status_history
    ON notifications(status, created_at DESC, id DESC);

CREATE INDEX idx_notifications_history
    ON notifications(created_at DESC, id DESC);

CREATE UNIQUE INDEX idx_notifications_open_dedupe
    ON notifications(session_id, type, pr_url)
    WHERE status = 'unread' OR resolved_at IS NULL;

CREATE INDEX idx_notifications_unresolved
    ON notifications(resolved_at, created_at DESC, id DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Narrowing the CHECK again would orphan any turn_complete row written while
-- the wider constraint was live, so drop those rows first. They are advisory
-- notifications, not durable state.
DELETE FROM notifications WHERE type = 'turn_complete';

CREATE TABLE notifications_old (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pr_url TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (
        type IN (
            'needs_input',
            'ready_to_merge',
            'pr_merged',
            'pr_closed_unmerged'
        )
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('read', 'unread')),
    created_at TIMESTAMP NOT NULL,
    resolved_at TIMESTAMP
);

INSERT INTO notifications_old (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, resolved_at
)
SELECT id, session_id, project_id, pr_url, type, title, body, status, created_at, resolved_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_old RENAME TO notifications;

CREATE INDEX idx_notifications_status_history
    ON notifications(status, created_at DESC, id DESC);

CREATE INDEX idx_notifications_history
    ON notifications(created_at DESC, id DESC);

CREATE UNIQUE INDEX idx_notifications_open_dedupe
    ON notifications(session_id, type, pr_url)
    WHERE status = 'unread' OR resolved_at IS NULL;

CREATE INDEX idx_notifications_unresolved
    ON notifications(resolved_at, created_at DESC, id DESC);
-- +goose StatementEnd
