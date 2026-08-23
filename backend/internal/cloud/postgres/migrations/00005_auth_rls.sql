-- +goose Up
-- Identity and refresh-token rows are tenant data too. Pre-authentication
-- operations use the narrowly-scoped SECURITY DEFINER functions below;
-- authenticated reads and writes remain subject to self-only RLS.
ALTER TABLE ao_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_users FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_users_self ON ao_users
    USING (id = ao_current_user_id())
    WITH CHECK (id = ao_current_user_id());

ALTER TABLE ao_auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_auth_sessions_self ON ao_auth_sessions
    USING (user_id = ao_current_user_id())
    WITH CHECK (user_id = ao_current_user_id());

-- +goose StatementBegin
CREATE FUNCTION ao_upsert_google_user(
    candidate_external_user_id TEXT,
    candidate_email TEXT,
    candidate_display_name TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    result_user_id UUID;
    personal_org_id UUID;
BEGIN
    INSERT INTO public.ao_users (auth_provider, external_user_id, email, display_name)
    VALUES ('google', candidate_external_user_id, candidate_email, candidate_display_name)
    ON CONFLICT (auth_provider, external_user_id)
    DO UPDATE SET email = EXCLUDED.email,
                  display_name = EXCLUDED.display_name,
                  updated_at = now()
    RETURNING id INTO result_user_id;

    PERFORM pg_advisory_xact_lock(hashtextextended(result_user_id::TEXT, 0));
    IF NOT EXISTS (
        SELECT 1 FROM public.ao_org_memberships WHERE user_id = result_user_id
    ) THEN
        personal_org_id := gen_random_uuid();
        INSERT INTO public.ao_organizations (
            id, slug, display_name, kind, owner_user_id, created_by_user_id
        ) VALUES (
            personal_org_id,
            'personal-' || replace(result_user_id::TEXT, '-', ''),
            candidate_display_name || '''s organization',
            'personal',
            result_user_id,
            result_user_id
        );
        INSERT INTO public.ao_org_memberships (org_id, user_id, role)
        VALUES (personal_org_id, result_user_id, 'owner');
    END IF;
    RETURN result_user_id;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_rotate_refresh_session(candidate_old_hash BYTEA, candidate_new_hash BYTEA)
RETURNS TABLE (
    user_id UUID,
    auth_provider TEXT,
    external_user_id TEXT,
    email TEXT,
    display_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    session_user_id UUID;
    session_created_at TIMESTAMPTZ;
    session_expires_at TIMESTAMPTZ;
BEGIN
    DELETE FROM public.ao_auth_sessions
    WHERE token_hash = candidate_old_hash AND expires_at > now()
    RETURNING ao_auth_sessions.user_id, created_at, expires_at
    INTO session_user_id, session_created_at, session_expires_at;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    INSERT INTO public.ao_auth_sessions (user_id, token_hash, created_at, expires_at)
    VALUES (session_user_id, candidate_new_hash, session_created_at, session_expires_at);

    RETURN QUERY
    SELECT u.id, u.auth_provider, u.external_user_id, u.email, u.display_name
    FROM public.ao_users u
    WHERE u.id = session_user_id;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_revoke_refresh_session(candidate_hash BYTEA) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    DELETE FROM public.ao_auth_sessions WHERE token_hash = candidate_hash
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION ao_upsert_google_user(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_rotate_refresh_session(BYTEA, BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_revoke_refresh_session(BYTEA) FROM PUBLIC;

-- Workspace sharing is not a v1 feature. Keep project metadata and the
-- capability-minting GET owner-only even when the user belongs to a team org.
DROP POLICY ao_cloud_workspaces_select ON ao_cloud_workspaces;
CREATE POLICY ao_cloud_workspaces_select ON ao_cloud_workspaces
    FOR SELECT
    USING (
        owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE INDEX ao_cloud_workspaces_owner_created_idx
    ON ao_cloud_workspaces(org_id, owner_user_id, created_at DESC, id DESC);

-- +goose Down
DROP INDEX IF EXISTS ao_cloud_workspaces_owner_created_idx;
DROP POLICY IF EXISTS ao_cloud_workspaces_select ON ao_cloud_workspaces;
CREATE POLICY ao_cloud_workspaces_select ON ao_cloud_workspaces
    FOR SELECT
    USING (ao_is_org_member(org_id, ao_current_user_id()));
DROP FUNCTION IF EXISTS ao_revoke_refresh_session(BYTEA);
DROP FUNCTION IF EXISTS ao_rotate_refresh_session(BYTEA, BYTEA);
DROP FUNCTION IF EXISTS ao_upsert_google_user(TEXT, TEXT, TEXT);
DROP POLICY IF EXISTS ao_auth_sessions_self ON ao_auth_sessions;
ALTER TABLE ao_auth_sessions DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ao_users_self ON ao_users;
ALTER TABLE ao_users DISABLE ROW LEVEL SECURITY;
