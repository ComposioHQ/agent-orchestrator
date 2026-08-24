-- +goose Up
-- Durable compute placement, scoped sandbox capabilities, and one-time mux
-- tickets. Quota reservations are separate from the workspace-scoped runtime
-- rows so an organization-wide count can remain atomic without weakening the
-- runtime row's workspace RLS boundary.

ALTER TABLE ao_cloud_session_runtimes
    DROP CONSTRAINT ao_cloud_session_runtimes_state_check,
    ADD COLUMN owner_user_id UUID REFERENCES ao_users(id) ON DELETE CASCADE,
    ADD COLUMN role TEXT NOT NULL DEFAULT 'worker'
        CHECK (role IN ('coordinator', 'worker')),
    ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'running'
        CHECK (desired_state IN ('running', 'stopped')),
    ADD COLUMN last_heartbeat_at TIMESTAMPTZ,
    ADD CONSTRAINT ao_cloud_session_runtimes_state_check
        CHECK (state IN ('provisioning', 'running', 'stopped', 'failed', 'deleting'));

UPDATE ao_cloud_session_runtimes runtime
SET owner_user_id = workspace.owner_user_id
FROM ao_cloud_workspaces workspace
WHERE workspace.id = runtime.workspace_id;

ALTER TABLE ao_cloud_session_runtimes
    ALTER COLUMN owner_user_id SET NOT NULL;

ALTER TABLE ao_cloud_workspaces
    ADD CONSTRAINT ao_cloud_workspaces_compute_scope_key
        UNIQUE (id, org_id, owner_user_id);
ALTER TABLE ao_cloud_session_runtimes
    ADD CONSTRAINT ao_cloud_session_runtimes_compute_scope_fk
        FOREIGN KEY (workspace_id, org_id, owner_user_id)
        REFERENCES ao_cloud_workspaces(id, org_id, owner_user_id) ON DELETE CASCADE;

CREATE TABLE ao_compute_quota_reservations (
    runtime_id UUID PRIMARY KEY REFERENCES ao_cloud_session_runtimes(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker')),
    live BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (workspace_id, org_id, owner_user_id)
        REFERENCES ao_cloud_workspaces(id, org_id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX ao_compute_quota_org_live_idx
    ON ao_compute_quota_reservations(org_id) WHERE live;
CREATE INDEX ao_compute_quota_user_live_idx
    ON ao_compute_quota_reservations(org_id, owner_user_id) WHERE live;
CREATE INDEX ao_compute_quota_workspace_live_idx
    ON ao_compute_quota_reservations(org_id, workspace_id, role) WHERE live;

INSERT INTO ao_compute_quota_reservations
    (runtime_id, org_id, owner_user_id, workspace_id, role, live, created_at)
SELECT id, org_id, owner_user_id, workspace_id, role, state <> 'deleting', created_at
FROM ao_cloud_session_runtimes;

ALTER TABLE ao_compute_quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_compute_quota_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_compute_quota_select ON ao_compute_quota_reservations
    FOR SELECT
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE POLICY ao_compute_quota_insert ON ao_compute_quota_reservations
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, owner_user_id)
    );
CREATE POLICY ao_compute_quota_update ON ao_compute_quota_reservations
    FOR UPDATE
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id())
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id());
CREATE POLICY ao_compute_quota_delete ON ao_compute_quota_reservations
    FOR DELETE
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id());

CREATE TABLE ao_compute_capabilities (
    id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker')),
    operations TEXT[] NOT NULL CHECK (cardinality(operations) > 0),
    verifier TEXT NOT NULL CHECK (btrim(verifier) <> ''),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    rotated_to_id TEXT,
    FOREIGN KEY (workspace_id, org_id, owner_user_id)
        REFERENCES ao_cloud_workspaces(id, org_id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX ao_compute_capabilities_scope_idx
    ON ao_compute_capabilities(org_id, owner_user_id, workspace_id, session_id)
    WHERE revoked_at IS NULL;
ALTER TABLE ao_compute_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_compute_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_compute_capabilities_tenant ON ao_compute_capabilities
    FOR ALL
    USING (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, owner_user_id)
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, owner_user_id)
    );

CREATE TABLE ao_terminal_tickets (
    id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    session_id TEXT NOT NULL CHECK (btrim(session_id) <> ''),
    sandbox_id TEXT NOT NULL CHECK (btrim(sandbox_id) <> ''),
    scopes TEXT[] NOT NULL CHECK (cardinality(scopes) > 0),
    verifier TEXT NOT NULL CHECK (btrim(verifier) <> ''),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    FOREIGN KEY (workspace_id, org_id, owner_user_id)
        REFERENCES ao_cloud_workspaces(id, org_id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX ao_terminal_tickets_expiry_idx ON ao_terminal_tickets(expires_at);
ALTER TABLE ao_terminal_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_terminal_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_terminal_tickets_tenant ON ao_terminal_tickets
    FOR ALL
    USING (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND workspace_id = ao_current_workspace_id()
        AND ao_is_org_member(org_id, owner_user_id)
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND workspace_id = ao_current_workspace_id()
        AND ao_is_org_member(org_id, owner_user_id)
    );

REVOKE ALL ON TABLE ao_compute_quota_reservations,
    ao_compute_capabilities, ao_terminal_tickets FROM PUBLIC;

-- +goose Down
DROP POLICY IF EXISTS ao_terminal_tickets_tenant ON ao_terminal_tickets;
DROP POLICY IF EXISTS ao_compute_capabilities_tenant ON ao_compute_capabilities;
DROP POLICY IF EXISTS ao_compute_quota_delete ON ao_compute_quota_reservations;
DROP POLICY IF EXISTS ao_compute_quota_update ON ao_compute_quota_reservations;
DROP POLICY IF EXISTS ao_compute_quota_insert ON ao_compute_quota_reservations;
DROP POLICY IF EXISTS ao_compute_quota_select ON ao_compute_quota_reservations;
DROP TABLE IF EXISTS ao_terminal_tickets;
DROP TABLE IF EXISTS ao_compute_capabilities;
DROP TABLE IF EXISTS ao_compute_quota_reservations;
ALTER TABLE ao_cloud_session_runtimes
    DROP CONSTRAINT IF EXISTS ao_cloud_session_runtimes_compute_scope_fk,
    DROP CONSTRAINT ao_cloud_session_runtimes_state_check,
    DROP COLUMN IF EXISTS last_heartbeat_at,
    DROP COLUMN IF EXISTS desired_state,
    DROP COLUMN IF EXISTS role,
    DROP COLUMN IF EXISTS owner_user_id,
    ADD CONSTRAINT ao_cloud_session_runtimes_state_check
        CHECK (state IN ('provisioning', 'running', 'stopped', 'failed'));
ALTER TABLE ao_cloud_workspaces
    DROP CONSTRAINT IF EXISTS ao_cloud_workspaces_compute_scope_key;
