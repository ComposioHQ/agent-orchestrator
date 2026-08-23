-- +goose Up
-- The durable state a hosted AO deployment keeps for its tenants: the project
-- registry, the session fact rows, and the per-repo worktrees a session
-- materialises. These mirror the local SQLite tables of the same shape, because
-- the same services read both through one set of storage ports — there is no
-- second API and no synchronisation between the two stores.
--
-- Identity is where the two schemas necessarily differ. Locally a project id
-- ("acme") and a session id ("acme-1") are globally unique because there is one
-- user. Hosted, they are user-chosen labels unique only inside one acting
-- user's organization scope, so every key and foreign key carries org_id and
-- owner_user_id. Keying on the AO id alone would silently merge users or
-- organizations that both registered a project called "acme".
--
-- Scope is organization plus user. Membership admits the organization while
-- owner_user_id keeps v1 product state private between members of a team org,
-- matching the existing ao_cloud_workspaces boundary.

CREATE TABLE ao_projects (
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (btrim(id) <> ''),
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK (btrim(path) <> ''),
    repo_origin_url TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'single_repo'
        CHECK (kind IN ('single_repo', 'workspace', 'scratch')),
    -- The typed per-project config, stored as one JSON document exactly as
    -- SQLite stores it. NULL means unset and reads back as a zero config; an
    -- empty object would not, which is why the column is nullable.
    config JSONB,
    -- Workspace child repositories are part of the project aggregate. Keeping
    -- the authoritative set here avoids a fourth core table while preserving
    -- atomic replacement semantics across both storage implementations.
    workspace_repos JSONB NOT NULL DEFAULT '[]'::jsonb,
    registered_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, owner_user_id, id)
);
-- A path identifies at most one ACTIVE project per tenant. Archived rows are
-- excluded so a user can re-register a directory they archived, which is the
-- behaviour FindProjectByPath already assumes by ignoring archived rows.
CREATE UNIQUE INDEX ao_projects_active_path_idx
    ON ao_projects(org_id, owner_user_id, path) WHERE archived_at IS NULL;
-- Covers the sidebar's project list: active rows for one tenant, in id order.
CREATE INDEX ao_projects_active_idx
    ON ao_projects(org_id, owner_user_id, id) WHERE archived_at IS NULL;

-- The session fact row. It holds only durable facts: identity, harness,
-- activity_state, is_terminated, and operational metadata. The user-facing
-- status is derived at read time from these plus PR facts and is never stored,
-- so there is deliberately no status column to write.
CREATE TABLE ao_sessions (
    org_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (btrim(id) <> ''),
    project_id TEXT NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    -- The per-project counter behind the "{project}-{num}" identity.
    num BIGINT NOT NULL CHECK (num > 0),
    issue_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'worker'
        CHECK (kind IN ('worker', 'orchestrator')),
    -- Harness and reviewer names are an open, frequently extended set. The
    -- local schema has had to rewrite its CHECK allowlist for every new agent;
    -- validation belongs in the domain layer, which already owns it.
    harness TEXT NOT NULL DEFAULT '',
    reviewer_harness TEXT NOT NULL DEFAULT '',
    auto_review_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    display_name TEXT NOT NULL DEFAULT '',
    session_mode TEXT NOT NULL DEFAULT 'tui'
        CHECK (session_mode IN ('tui', 'chat')),
    activity_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (activity_state IN ('active', 'idle', 'waiting_input', 'blocked', 'exited')),
    activity_last_at TIMESTAMPTZ NOT NULL,
    -- NULL means no agent hook has ever reported for the current launch, which
    -- reads as the no_signal status after a grace period. An epoch default
    -- would be indistinguishable from a real first signal.
    first_signal_at TIMESTAMPTZ,
    is_terminated BOOLEAN NOT NULL DEFAULT FALSE,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    pinned_at TIMESTAMPTZ,
    terminate_on_pr_merge BOOLEAN NOT NULL DEFAULT FALSE,
    auto_inject_review BOOLEAN NOT NULL DEFAULT FALSE,
    auto_inject_ci BOOLEAN NOT NULL DEFAULT FALSE,
    cleanup_generation BIGINT NOT NULL DEFAULT 0,

    branch TEXT NOT NULL DEFAULT '',
    workspace_path TEXT NOT NULL DEFAULT '',
    workspace_repo_path TEXT NOT NULL DEFAULT '',
    diff_base_sha TEXT NOT NULL DEFAULT '',
    diff_base_ref TEXT NOT NULL DEFAULT '',
    runtime_handle_id TEXT NOT NULL DEFAULT '',
    runtime_launch_id TEXT NOT NULL DEFAULT '',
    agent_session_id TEXT NOT NULL DEFAULT '',
    agent_session_id_launch_id TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    latest_user_prompt TEXT NOT NULL DEFAULT '',
    latest_assistant_update TEXT NOT NULL DEFAULT '',
    native_transcript_path TEXT NOT NULL DEFAULT '',
    preview_url TEXT NOT NULL DEFAULT '',
    preview_revision BIGINT NOT NULL DEFAULT 0,
    -- A one-way verifier for the session's browser capability. The bearer token
    -- is never persisted, so reading this table cannot grant access.
    browser_capability_verifier TEXT NOT NULL DEFAULT '',
    provider_conversation_id TEXT NOT NULL DEFAULT '',
    controller_generation TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',

    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, id),
    UNIQUE (org_id, owner_user_id, project_id, num),
    FOREIGN KEY (org_id, owner_user_id, project_id)
        REFERENCES ao_projects(org_id, owner_user_id, id) ON DELETE CASCADE
);
-- The sidebar and kanban read every session for a tenant in one query, ordered
-- by project then per-project number. This index serves that read and the
-- per-project list, and makes the next-number probe an index-only backward scan
-- rather than an aggregate over the project's history.
CREATE INDEX ao_sessions_org_project_num_idx
    ON ao_sessions(org_id, owner_user_id, project_id, num);

CREATE TABLE ao_session_worktrees (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    repo_name TEXT NOT NULL CHECK (btrim(repo_name) <> ''),
    branch TEXT NOT NULL DEFAULT '',
    base_sha TEXT NOT NULL DEFAULT '',
    base_ref TEXT NOT NULL DEFAULT '',
    worktree_path TEXT NOT NULL DEFAULT '',
    preserved_ref TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'removed', 'retry_remove', 'unavailable', 'stray_moved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, owner_user_id, session_id, repo_name),
    FOREIGN KEY (org_id, owner_user_id, session_id)
        REFERENCES ao_sessions(org_id, owner_user_id, id) ON DELETE CASCADE
);

ALTER TABLE ao_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_projects_tenant ON ao_projects
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

ALTER TABLE ao_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_sessions_tenant ON ao_sessions
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

ALTER TABLE ao_session_worktrees ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_session_worktrees FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_session_worktrees_tenant ON ao_session_worktrees
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

REVOKE ALL ON TABLE ao_projects, ao_sessions, ao_session_worktrees FROM PUBLIC;

-- +goose Down
DROP POLICY IF EXISTS ao_session_worktrees_tenant ON ao_session_worktrees;
DROP POLICY IF EXISTS ao_sessions_tenant ON ao_sessions;
DROP POLICY IF EXISTS ao_projects_tenant ON ao_projects;
DROP TABLE IF EXISTS ao_session_worktrees;
DROP TABLE IF EXISTS ao_sessions;
DROP TABLE IF EXISTS ao_projects;
