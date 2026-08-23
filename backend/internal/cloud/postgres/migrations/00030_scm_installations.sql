-- +goose Up
-- SCM credential boundary. A GitHub App installation is linked to exactly one
-- AO organization, and a cloud project may only clone or push repositories the
-- organization has explicitly allowlisted. No shared operator token exists:
-- every sandbox credential is minted per repository from the installation.

CREATE TABLE ao_scm_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider = 'github'),
    external_installation_id BIGINT NOT NULL CHECK (external_installation_id > 0),
    account_login TEXT NOT NULL CHECK (btrim(account_login) <> ''),
    account_type TEXT NOT NULL DEFAULT 'Organization'
        CHECK (account_type IN ('Organization', 'User')),
    app_slug TEXT NOT NULL DEFAULT '',
    repository_selection TEXT NOT NULL DEFAULT 'selected'
        CHECK (repository_selection IN ('selected', 'all')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'removed')),
    linked_by_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One installation belongs to one tenant. Without this an attacker who
    -- guessed an installation id could re-link a victim's installation into
    -- an organization they control.
    UNIQUE (provider, external_installation_id)
);
CREATE INDEX ao_scm_installations_org_idx
    ON ao_scm_installations(org_id, provider, created_at DESC);

-- Repository allowlist. `allowed` is the enforcement column read by the token
-- broker; a row merely existing means the installation can see the repository,
-- not that AO may hand out a credential for it.
CREATE TABLE ao_scm_repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL
        REFERENCES ao_scm_installations(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    external_repository_id BIGINT NOT NULL CHECK (external_repository_id > 0),
    full_name TEXT NOT NULL
        CHECK (full_name = lower(full_name)
               AND full_name ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'),
    private BOOLEAN NOT NULL DEFAULT TRUE,
    allowed BOOLEAN NOT NULL DEFAULT FALSE,
    allowed_by_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    allowed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (installation_id, external_repository_id),
    CHECK (allowed = FALSE OR allowed_at IS NOT NULL)
);
-- A repository resolves to at most one installation per organization, so the
-- broker's lookup by name cannot be made ambiguous by a second linked account.
CREATE UNIQUE INDEX ao_scm_repositories_org_name_idx
    ON ao_scm_repositories(org_id, full_name);
CREATE INDEX ao_scm_repositories_installation_idx
    ON ao_scm_repositories(installation_id, allowed);

-- Single-use, short-lived state for the GitHub App install redirect. Only the
-- digest is stored so a database read cannot replay a pending link.
CREATE TABLE ao_scm_install_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider = 'github'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at)
);
CREATE INDEX ao_scm_install_states_expiry_idx
    ON ao_scm_install_states(expires_at);

-- Audit ledger for brokered installation tokens. Token material is never
-- written here: the row records that a scoped credential existed, for whom,
-- and when it expired, so a leak can be bounded during incident response.
CREATE TABLE ao_scm_token_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    installation_id UUID NOT NULL
        REFERENCES ao_scm_installations(id) ON DELETE CASCADE,
    repository_id UUID NOT NULL
        REFERENCES ao_scm_repositories(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES ao_cloud_workspaces(id) ON DELETE SET NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('clone', 'push', 'observe')),
    requested_by_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > granted_at)
);
CREATE INDEX ao_scm_token_grants_org_idx
    ON ao_scm_token_grants(org_id, granted_at DESC);
CREATE INDEX ao_scm_token_grants_installation_idx
    ON ao_scm_token_grants(installation_id, granted_at DESC);

ALTER TABLE ao_scm_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_scm_installations_select ON ao_scm_installations
    FOR SELECT
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_installations_insert ON ao_scm_installations
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_installations_update ON ao_scm_installations
    FOR UPDATE
    USING (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_installations_delete ON ao_scm_installations
    FOR DELETE
    USING (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );

ALTER TABLE ao_scm_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_scm_repositories_select ON ao_scm_repositories
    FOR SELECT
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_repositories_insert ON ao_scm_repositories
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
        AND EXISTS (
            SELECT 1
            FROM ao_scm_installations installation
            WHERE installation.id = ao_scm_repositories.installation_id
              AND installation.org_id = ao_scm_repositories.org_id
        )
    );
CREATE POLICY ao_scm_repositories_update ON ao_scm_repositories
    FOR UPDATE
    USING (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_repositories_delete ON ao_scm_repositories
    FOR DELETE
    USING (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );

ALTER TABLE ao_scm_install_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_install_states FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_scm_install_states_insert ON ao_scm_install_states
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND user_id = ao_current_user_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_install_states_select ON ao_scm_install_states
    FOR SELECT
    USING (user_id = ao_current_user_id());

ALTER TABLE ao_scm_token_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_token_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_scm_token_grants_select ON ao_scm_token_grants
    FOR SELECT
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
-- The foreign keys below are checked by the system with RLS bypassed, so the
-- policy has to re-prove that the installation, repository, and workspace this
-- grant names all belong to the writing organization. Without that, a tenant
-- could append audit rows referencing another tenant's installation.
CREATE POLICY ao_scm_token_grants_insert ON ao_scm_token_grants
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
        AND requested_by_user_id = ao_current_user_id()
        AND EXISTS (
            SELECT 1
            FROM ao_scm_installations installation
            WHERE installation.id = ao_scm_token_grants.installation_id
              AND installation.org_id = ao_scm_token_grants.org_id
        )
        AND EXISTS (
            SELECT 1
            FROM ao_scm_repositories repository
            WHERE repository.id = ao_scm_token_grants.repository_id
              AND repository.installation_id = ao_scm_token_grants.installation_id
              AND repository.org_id = ao_scm_token_grants.org_id
        )
        AND (
            workspace_id IS NULL
            OR EXISTS (
                SELECT 1
                FROM ao_cloud_workspaces workspace
                WHERE workspace.id = ao_scm_token_grants.workspace_id
                  AND workspace.org_id = ao_scm_token_grants.org_id
            )
        )
    );

REVOKE ALL ON TABLE
    ao_scm_installations, ao_scm_repositories,
    ao_scm_install_states, ao_scm_token_grants
    FROM PUBLIC;

-- +goose Down
DROP POLICY IF EXISTS ao_scm_token_grants_insert ON ao_scm_token_grants;
DROP POLICY IF EXISTS ao_scm_token_grants_select ON ao_scm_token_grants;
DROP POLICY IF EXISTS ao_scm_install_states_select ON ao_scm_install_states;
DROP POLICY IF EXISTS ao_scm_install_states_insert ON ao_scm_install_states;
DROP POLICY IF EXISTS ao_scm_repositories_delete ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_repositories_update ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_repositories_insert ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_repositories_select ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_installations_delete ON ao_scm_installations;
DROP POLICY IF EXISTS ao_scm_installations_update ON ao_scm_installations;
DROP POLICY IF EXISTS ao_scm_installations_insert ON ao_scm_installations;
DROP POLICY IF EXISTS ao_scm_installations_select ON ao_scm_installations;
DROP TABLE IF EXISTS ao_scm_token_grants;
DROP TABLE IF EXISTS ao_scm_install_states;
DROP TABLE IF EXISTS ao_scm_repositories;
DROP TABLE IF EXISTS ao_scm_installations;
