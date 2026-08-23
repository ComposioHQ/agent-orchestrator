-- +goose Up
CREATE TABLE ao_notifications (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL,
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    pr_url TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (type IN (
        'needs_input', 'ready_to_merge', 'pr_merged', 'pr_closed_unmerged'
    )),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('read', 'unread')),
    created_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    PRIMARY KEY (org_id, owner_user_id, id),
    FOREIGN KEY (org_id, owner_user_id, session_id)
        REFERENCES ao_sessions(org_id, owner_user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, owner_user_id, project_id)
        REFERENCES ao_projects(org_id, owner_user_id, id) ON DELETE CASCADE
);
CREATE INDEX ao_notifications_history_idx
    ON ao_notifications(org_id, owner_user_id, created_at DESC, id DESC);
CREATE INDEX ao_notifications_status_idx
    ON ao_notifications(org_id, owner_user_id, status, created_at DESC, id DESC);
CREATE UNIQUE INDEX ao_notifications_open_dedupe_idx
    ON ao_notifications(org_id, owner_user_id, session_id, type, pr_url)
    WHERE status = 'unread' OR resolved_at IS NULL;
ALTER TABLE ao_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_notifications_tenant ON ao_notifications FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
REVOKE ALL ON TABLE ao_notifications FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_notifications;
