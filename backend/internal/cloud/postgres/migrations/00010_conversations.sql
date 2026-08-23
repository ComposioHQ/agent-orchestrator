-- +goose Up
-- Conversation state is one tenant-owned aggregate. The JSON document contains
-- only durable provider-neutral facts; identity and ownership stay relational
-- so RLS and foreign keys cannot be bypassed by malformed JSON.
CREATE TABLE ao_conversations (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (btrim(id) <> ''),
    scope TEXT NOT NULL CHECK (scope IN ('session', 'project')),
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, id),
    UNIQUE (org_id, owner_user_id, session_id),
    FOREIGN KEY (org_id, owner_user_id, project_id)
        REFERENCES ao_projects(org_id, owner_user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, owner_user_id, session_id)
        REFERENCES ao_sessions(org_id, owner_user_id, id) ON DELETE CASCADE
);
CREATE INDEX ao_conversations_project_idx
    ON ao_conversations(org_id, owner_user_id, project_id, created_at);
CREATE UNIQUE INDEX ao_conversations_project_scope_idx
    ON ao_conversations(org_id, owner_user_id, project_id)
    WHERE scope = 'project';

ALTER TABLE ao_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_conversations_tenant ON ao_conversations
    FOR ALL
    USING (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
REVOKE ALL ON TABLE ao_conversations FROM PUBLIC;

-- +goose Down
DROP POLICY IF EXISTS ao_conversations_tenant ON ao_conversations;
DROP TABLE IF EXISTS ao_conversations;
