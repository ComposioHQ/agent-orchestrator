-- +goose Up
-- Forward repair for staging, where migration 00006 briefly used BYPASSRLS.
-- Fresh databases already have these grants and policies; DROP/CREATE keeps the
-- repair idempotent across both histories and removes the bypass attribute.
ALTER ROLE ao_cloud_auth NOBYPASSRLS;
-- +goose StatementBegin
DO $$
BEGIN
    EXECUTE format('GRANT ao_cloud_auth TO %I WITH SET TRUE', current_user);
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

DROP POLICY IF EXISTS ao_users_auth_definer ON ao_users;
CREATE POLICY ao_users_auth_definer ON ao_users
    FOR ALL USING (current_user = 'ao_cloud_auth')
    WITH CHECK (current_user = 'ao_cloud_auth');
DROP POLICY IF EXISTS ao_auth_sessions_auth_definer ON ao_auth_sessions;
CREATE POLICY ao_auth_sessions_auth_definer ON ao_auth_sessions
    FOR ALL USING (current_user = 'ao_cloud_auth')
    WITH CHECK (current_user = 'ao_cloud_auth');
DROP POLICY IF EXISTS ao_organizations_auth_definer ON ao_organizations;
CREATE POLICY ao_organizations_auth_definer ON ao_organizations
    FOR ALL USING (current_user = 'ao_cloud_auth')
    WITH CHECK (current_user = 'ao_cloud_auth');
DROP POLICY IF EXISTS ao_org_memberships_auth_definer ON ao_org_memberships;
CREATE POLICY ao_org_memberships_auth_definer ON ao_org_memberships
    FOR ALL USING (current_user = 'ao_cloud_auth')
    WITH CHECK (current_user = 'ao_cloud_auth');

-- +goose Down
DROP POLICY IF EXISTS ao_org_memberships_auth_definer ON ao_org_memberships;
DROP POLICY IF EXISTS ao_organizations_auth_definer ON ao_organizations;
DROP POLICY IF EXISTS ao_auth_sessions_auth_definer ON ao_auth_sessions;
DROP POLICY IF EXISTS ao_users_auth_definer ON ao_users;
