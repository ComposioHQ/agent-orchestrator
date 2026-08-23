-- +goose Up
-- GitHub App installation ownership, default-deny repository authorization,
-- one-shot install state, and the non-secret credential audit ledger.

CREATE TABLE ao_scm_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider = 'github'),
    external_installation_id BIGINT NOT NULL CHECK (external_installation_id > 0),
    account_login TEXT NOT NULL CHECK (btrim(account_login) <> '' AND length(account_login) <= 255),
    account_type TEXT NOT NULL CHECK (account_type IN ('Organization', 'User')),
    app_slug TEXT NOT NULL CHECK (btrim(app_slug) <> '' AND length(app_slug) <= 255),
    repository_selection TEXT NOT NULL CHECK (repository_selection IN ('selected', 'all')),
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'removed')),
    linked_by_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (provider, external_installation_id)
);
CREATE INDEX ao_scm_installations_org_idx
    ON ao_scm_installations(org_id, provider, created_at DESC);

CREATE TABLE ao_scm_repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL REFERENCES ao_scm_installations(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    external_repository_id BIGINT NOT NULL CHECK (external_repository_id > 0),
    full_name TEXT NOT NULL CHECK (
        full_name = lower(full_name)
        AND length(full_name) <= 255
        AND full_name ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'
    ),
    private BOOLEAN NOT NULL DEFAULT TRUE,
    allowed BOOLEAN NOT NULL DEFAULT FALSE,
    allowed_by_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    allowed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (installation_id, external_repository_id),
    CHECK ((NOT allowed AND allowed_at IS NULL) OR (allowed AND allowed_at IS NOT NULL))
);
CREATE UNIQUE INDEX ao_scm_repositories_org_name_idx
    ON ao_scm_repositories(org_id, full_name);
CREATE INDEX ao_scm_repositories_installation_idx
    ON ao_scm_repositories(installation_id, allowed, full_name);

-- Only a digest is persisted. A database read cannot replay the browser state.
CREATE TABLE ao_scm_install_states (
    state_hash BYTEA PRIMARY KEY CHECK (octet_length(state_hash) = 32),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider = 'github'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at)
);
CREATE INDEX ao_scm_install_states_expiry_idx ON ao_scm_install_states(expires_at);

-- Credential material is deliberately absent. This ledger records only who
-- caused a repository-scoped token to exist and its bounded lifetime.
CREATE TABLE ao_scm_token_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    installation_id UUID NOT NULL REFERENCES ao_scm_installations(id) ON DELETE CASCADE,
    repository_id UUID NOT NULL REFERENCES ao_scm_repositories(id) ON DELETE CASCADE,
    sandbox_id TEXT NOT NULL CHECK (btrim(sandbox_id) <> '' AND length(sandbox_id) <= 255),
    purpose TEXT NOT NULL CHECK (purpose IN ('clone', 'push')),
    requested_by_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > granted_at)
);
CREATE INDEX ao_scm_token_grants_org_idx
    ON ao_scm_token_grants(org_id, granted_at DESC);

ALTER TABLE ao_scm_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_scm_installations_select ON ao_scm_installations
    FOR SELECT USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_installations_admin_insert ON ao_scm_installations
    FOR INSERT WITH CHECK (
        org_id = ao_current_org_id()
        AND linked_by_user_id = ao_current_user_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_installations_admin_update ON ao_scm_installations
    FOR UPDATE USING (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    ) WITH CHECK (
        org_id = ao_current_org_id()
        AND linked_by_user_id = ao_current_user_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_installations_admin_delete ON ao_scm_installations
    FOR DELETE USING (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );

ALTER TABLE ao_scm_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_scm_repositories_select ON ao_scm_repositories
    FOR SELECT USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_repositories_admin_insert ON ao_scm_repositories
    FOR INSERT WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
        AND EXISTS (
            SELECT 1 FROM ao_scm_installations installation
            WHERE installation.id = ao_scm_repositories.installation_id
              AND installation.org_id = ao_scm_repositories.org_id
        )
    );
CREATE POLICY ao_scm_repositories_admin_update ON ao_scm_repositories
    FOR UPDATE USING (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    ) WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_repositories_admin_delete ON ao_scm_repositories
    FOR DELETE USING (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );

ALTER TABLE ao_scm_install_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_install_states FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_scm_install_states_admin_insert ON ao_scm_install_states
    FOR INSERT WITH CHECK (
        org_id = ao_current_org_id()
        AND user_id = ao_current_user_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );

ALTER TABLE ao_scm_token_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_token_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_scm_token_grants_select ON ao_scm_token_grants
    FOR SELECT USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE POLICY ao_scm_token_grants_insert ON ao_scm_token_grants
    FOR INSERT WITH CHECK (
        org_id = ao_current_org_id()
        AND requested_by_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
        AND EXISTS (
            SELECT 1 FROM ao_scm_installations installation
            WHERE installation.id = ao_scm_token_grants.installation_id
              AND installation.org_id = ao_scm_token_grants.org_id
        )
        AND EXISTS (
            SELECT 1 FROM ao_scm_repositories repository
            WHERE repository.id = ao_scm_token_grants.repository_id
              AND repository.installation_id = ao_scm_token_grants.installation_id
              AND repository.org_id = ao_scm_token_grants.org_id
              AND repository.allowed
        )
        AND (
            EXISTS (
                SELECT 1 FROM ao_cloud_workspaces workspace
                WHERE workspace.org_id = ao_scm_token_grants.org_id
                  AND workspace.owner_user_id = ao_current_user_id()
                  AND workspace.sandbox_id = ao_scm_token_grants.sandbox_id
            )
            OR EXISTS (
                SELECT 1
                FROM ao_cloud_session_runtimes runtime
                JOIN ao_cloud_workspaces workspace ON workspace.id = runtime.workspace_id
                WHERE runtime.org_id = ao_scm_token_grants.org_id
                  AND workspace.owner_user_id = ao_current_user_id()
                  AND runtime.sandbox_id = ao_scm_token_grants.sandbox_id
            )
        )
    );

REVOKE ALL ON TABLE ao_scm_installations, ao_scm_repositories,
    ao_scm_install_states, ao_scm_token_grants FROM PUBLIC;

-- The callback has no AO bearer context. A narrowly owned one-shot function
-- is the sole read/delete path for install state.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_cloud_scm') THEN
        CREATE ROLE ao_cloud_scm NOLOGIN NOBYPASSRLS;
    END IF;
    IF NOT pg_has_role(current_user, 'ao_cloud_scm', 'SET') THEN
        EXECUTE format('GRANT ao_cloud_scm TO %I WITH SET TRUE', current_user);
    END IF;
END
$$;
-- +goose StatementEnd

GRANT USAGE ON SCHEMA public TO ao_cloud_scm;
GRANT SELECT, INSERT, UPDATE ON ao_scm_installations TO ao_cloud_scm;
GRANT SELECT, DELETE ON ao_scm_install_states TO ao_cloud_scm;
GRANT EXECUTE ON FUNCTION ao_current_user_id(), ao_current_org_id(),
    ao_is_org_member(UUID, UUID), ao_can_manage_org(UUID, UUID) TO ao_cloud_scm;
CREATE POLICY ao_scm_installations_definer ON ao_scm_installations
    FOR ALL USING (current_user = 'ao_cloud_scm')
    WITH CHECK (current_user = 'ao_cloud_scm');
CREATE POLICY ao_scm_install_states_definer ON ao_scm_install_states
    FOR ALL USING (current_user = 'ao_cloud_scm')
    WITH CHECK (current_user = 'ao_cloud_scm');

-- Claim one provider installation atomically. A conflict owned by another
-- tenant returns a uniqueness error without exposing that tenant's row.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_upsert_installation(
    candidate_org_id UUID,
    candidate_user_id UUID,
    candidate_external_installation_id BIGINT,
    candidate_account_login TEXT,
    candidate_account_type TEXT,
    candidate_app_slug TEXT,
    candidate_repository_selection TEXT,
    candidate_status TEXT
) RETURNS TABLE (
    id UUID,
    org_id UUID,
    provider TEXT,
    external_installation_id BIGINT,
    account_login TEXT,
    account_type TEXT,
    app_slug TEXT,
    repository_selection TEXT,
    status TEXT,
    linked_by_user_id UUID,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF candidate_org_id IS DISTINCT FROM public.ao_current_org_id()
       OR candidate_user_id IS DISTINCT FROM public.ao_current_user_id()
       OR NOT public.ao_can_manage_org(candidate_org_id, candidate_user_id) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SCM installation claim is not authorized';
    END IF;

    RETURN QUERY
    INSERT INTO public.ao_scm_installations AS installation (
        org_id, provider, external_installation_id, account_login,
        account_type, app_slug, repository_selection, status, linked_by_user_id
    ) VALUES (
        candidate_org_id, 'github', candidate_external_installation_id,
        candidate_account_login, candidate_account_type, candidate_app_slug,
        candidate_repository_selection, candidate_status, candidate_user_id
    )
    ON CONFLICT ON CONSTRAINT ao_scm_installations_provider_external_installation_id_key DO UPDATE SET
        account_login = EXCLUDED.account_login,
        account_type = EXCLUDED.account_type,
        app_slug = EXCLUDED.app_slug,
        repository_selection = EXCLUDED.repository_selection,
        status = EXCLUDED.status,
        linked_by_user_id = EXCLUDED.linked_by_user_id,
        updated_at = clock_timestamp()
    WHERE installation.org_id = EXCLUDED.org_id
    RETURNING installation.id, installation.org_id, installation.provider,
        installation.external_installation_id, installation.account_login,
        installation.account_type, installation.app_slug,
        installation.repository_selection, installation.status,
        installation.linked_by_user_id, installation.created_at,
        installation.updated_at;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            CONSTRAINT = 'ao_scm_installations_provider_external_installation_id_key',
            MESSAGE = 'SCM installation is already claimed';
    END IF;
END
$$;
-- +goose StatementEnd
GRANT CREATE ON SCHEMA public TO ao_cloud_scm;
ALTER FUNCTION ao_scm_upsert_installation(UUID, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) OWNER TO ao_cloud_scm;
REVOKE ALL ON FUNCTION ao_scm_upsert_installation(UUID, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION ao_scm_consume_install_state(candidate_hash BYTEA)
RETURNS TABLE (org_id UUID, user_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    DELETE FROM public.ao_scm_install_states state
    WHERE state.state_hash = candidate_hash
      AND state.expires_at > clock_timestamp()
    RETURNING state.org_id, state.user_id
$$;
-- +goose StatementEnd
ALTER FUNCTION ao_scm_consume_install_state(BYTEA) OWNER TO ao_cloud_scm;
REVOKE CREATE ON SCHEMA public FROM ao_cloud_scm;
REVOKE ALL ON FUNCTION ao_scm_consume_install_state(BYTEA) FROM PUBLIC;

-- +goose Down
DROP FUNCTION IF EXISTS ao_scm_consume_install_state(BYTEA);
DROP FUNCTION IF EXISTS ao_scm_upsert_installation(UUID, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP POLICY IF EXISTS ao_scm_install_states_definer ON ao_scm_install_states;
DROP POLICY IF EXISTS ao_scm_installations_definer ON ao_scm_installations;
DROP POLICY IF EXISTS ao_scm_token_grants_insert ON ao_scm_token_grants;
DROP POLICY IF EXISTS ao_scm_token_grants_select ON ao_scm_token_grants;
DROP POLICY IF EXISTS ao_scm_install_states_admin_insert ON ao_scm_install_states;
DROP POLICY IF EXISTS ao_scm_repositories_admin_delete ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_repositories_admin_update ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_repositories_admin_insert ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_repositories_select ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_installations_admin_delete ON ao_scm_installations;
DROP POLICY IF EXISTS ao_scm_installations_admin_update ON ao_scm_installations;
DROP POLICY IF EXISTS ao_scm_installations_admin_insert ON ao_scm_installations;
DROP POLICY IF EXISTS ao_scm_installations_select ON ao_scm_installations;
DROP TABLE IF EXISTS ao_scm_token_grants;
DROP TABLE IF EXISTS ao_scm_install_states;
DROP TABLE IF EXISTS ao_scm_repositories;
DROP TABLE IF EXISTS ao_scm_installations;
