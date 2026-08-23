-- +goose Up
-- FORCE RLS applies even to the table owner. Pre-authentication functions run
-- as one purpose-built NOLOGIN role instead of the broad migration role. The
-- role has DML only on the four tables needed to establish identity and
-- personal-org membership; explicit policies admit that role through RLS.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_cloud_auth') THEN
        CREATE ROLE ao_cloud_auth NOLOGIN;
        EXECUTE format('GRANT ao_cloud_auth TO %I WITH SET TRUE', current_user);
    ELSIF NOT pg_has_role(current_user, 'ao_cloud_auth', 'SET') THEN
        RAISE EXCEPTION 'migration role % must be able to SET ROLE ao_cloud_auth', current_user;
    END IF;
END
$$;
-- +goose StatementEnd

GRANT USAGE, CREATE ON SCHEMA public TO ao_cloud_auth;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON ao_users, ao_auth_sessions, ao_organizations, ao_org_memberships
    TO ao_cloud_auth;
GRANT EXECUTE ON FUNCTION
    ao_current_user_id(), ao_current_org_id(),
    ao_is_org_member(UUID, UUID), ao_can_manage_org(UUID, UUID)
    TO ao_cloud_auth;
ALTER FUNCTION ao_upsert_google_user(TEXT, TEXT, TEXT) OWNER TO ao_cloud_auth;
ALTER FUNCTION ao_rotate_refresh_session(BYTEA, BYTEA) OWNER TO ao_cloud_auth;
ALTER FUNCTION ao_revoke_refresh_session(BYTEA) OWNER TO ao_cloud_auth;

CREATE POLICY ao_users_auth_definer ON ao_users
    FOR ALL USING (current_user = 'ao_cloud_auth')
    WITH CHECK (current_user = 'ao_cloud_auth');
CREATE POLICY ao_auth_sessions_auth_definer ON ao_auth_sessions
    FOR ALL USING (current_user = 'ao_cloud_auth')
    WITH CHECK (current_user = 'ao_cloud_auth');
CREATE POLICY ao_organizations_auth_definer ON ao_organizations
    FOR ALL USING (current_user = 'ao_cloud_auth')
    WITH CHECK (current_user = 'ao_cloud_auth');
CREATE POLICY ao_org_memberships_auth_definer ON ao_org_memberships
    FOR ALL USING (current_user = 'ao_cloud_auth')
    WITH CHECK (current_user = 'ao_cloud_auth');

-- Account bootstrap no longer needs the self-insert exception. Leaving it in
-- the runtime policy would let callers grant themselves membership.
DROP POLICY ao_org_memberships_insert ON ao_org_memberships;
CREATE POLICY ao_org_memberships_insert ON ao_org_memberships
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_can_manage_org(org_id, ao_current_user_id())
    );

-- +goose Down
DROP POLICY IF EXISTS ao_org_memberships_insert ON ao_org_memberships;
CREATE POLICY ao_org_memberships_insert ON ao_org_memberships
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND (
            user_id = ao_current_user_id()
            OR ao_can_manage_org(org_id, ao_current_user_id())
        )
    );
DROP POLICY IF EXISTS ao_org_memberships_auth_definer ON ao_org_memberships;
DROP POLICY IF EXISTS ao_organizations_auth_definer ON ao_organizations;
DROP POLICY IF EXISTS ao_auth_sessions_auth_definer ON ao_auth_sessions;
DROP POLICY IF EXISTS ao_users_auth_definer ON ao_users;
ALTER FUNCTION ao_revoke_refresh_session(BYTEA) OWNER TO CURRENT_USER;
ALTER FUNCTION ao_rotate_refresh_session(BYTEA, BYTEA) OWNER TO CURRENT_USER;
ALTER FUNCTION ao_upsert_google_user(TEXT, TEXT, TEXT) OWNER TO CURRENT_USER;
