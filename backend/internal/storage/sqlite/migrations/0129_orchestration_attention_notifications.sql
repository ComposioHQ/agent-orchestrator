-- +goose Up
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_open_dedupe;
DROP INDEX IF EXISTS idx_notifications_unresolved;
DROP INDEX IF EXISTS idx_notifications_status_history;
DROP INDEX IF EXISTS idx_notifications_history;
ALTER TABLE notifications RENAME TO notifications_before_orchestration_attention;
CREATE TABLE notifications (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, pr_url TEXT NOT NULL DEFAULT '',
 type TEXT NOT NULL CHECK(type IN ('needs_input','ready_to_merge','pr_merged','pr_closed_unmerged','orchestration_attention')),
 title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('read','unread')),
 created_at TIMESTAMP NOT NULL, resolved_at TIMESTAMP
);
INSERT INTO notifications SELECT * FROM notifications_before_orchestration_attention;
DROP TABLE notifications_before_orchestration_attention;
CREATE INDEX idx_notifications_status_history ON notifications(status,created_at DESC,id DESC);
CREATE INDEX idx_notifications_history ON notifications(created_at DESC,id DESC);
CREATE UNIQUE INDEX idx_notifications_open_dedupe ON notifications(session_id,type,pr_url) WHERE status='unread' OR resolved_at IS NULL;
CREATE INDEX idx_notifications_unresolved ON notifications(resolved_at,created_at DESC,id DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM notifications WHERE type='orchestration_attention';
DROP INDEX IF EXISTS idx_notifications_open_dedupe;
DROP INDEX IF EXISTS idx_notifications_unresolved;
DROP INDEX IF EXISTS idx_notifications_status_history;
DROP INDEX IF EXISTS idx_notifications_history;
ALTER TABLE notifications RENAME TO notifications_with_orchestration_attention;
CREATE TABLE notifications (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, pr_url TEXT NOT NULL DEFAULT '',
 type TEXT NOT NULL CHECK(type IN ('needs_input','ready_to_merge','pr_merged','pr_closed_unmerged')),
 title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('read','unread')),
 created_at TIMESTAMP NOT NULL, resolved_at TIMESTAMP
);
INSERT INTO notifications SELECT * FROM notifications_with_orchestration_attention;
DROP TABLE notifications_with_orchestration_attention;
CREATE INDEX idx_notifications_status_history ON notifications(status,created_at DESC,id DESC);
CREATE INDEX idx_notifications_history ON notifications(created_at DESC,id DESC);
CREATE UNIQUE INDEX idx_notifications_open_dedupe ON notifications(session_id,type,pr_url) WHERE status='unread' OR resolved_at IS NULL;
CREATE INDEX idx_notifications_unresolved ON notifications(resolved_at,created_at DESC,id DESC);
-- +goose StatementEnd
