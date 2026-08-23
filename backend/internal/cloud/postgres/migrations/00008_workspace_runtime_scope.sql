-- +goose Up
CREATE FUNCTION ao_current_workspace_id() RETURNS UUID
LANGUAGE sql STABLE
AS $$
    SELECT NULLIF(current_setting('ao.workspace_id', true), '')::UUID
$$;

DROP POLICY IF EXISTS ao_cloud_session_runtimes_all ON ao_cloud_session_runtimes;
CREATE POLICY ao_cloud_session_runtimes_workspace ON ao_cloud_session_runtimes
    FOR ALL
    USING (
        workspace_id = ao_current_workspace_id()
        AND org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
        AND EXISTS (
            SELECT 1
            FROM ao_cloud_workspaces workspace
            WHERE workspace.id = ao_cloud_session_runtimes.workspace_id
              AND workspace.org_id = ao_cloud_session_runtimes.org_id
              AND workspace.owner_user_id = ao_current_user_id()
        )
    )
    WITH CHECK (
        workspace_id = ao_current_workspace_id()
        AND org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
        AND EXISTS (
            SELECT 1
            FROM ao_cloud_workspaces workspace
            WHERE workspace.id = ao_cloud_session_runtimes.workspace_id
              AND workspace.org_id = ao_cloud_session_runtimes.org_id
              AND workspace.owner_user_id = ao_current_user_id()
        )
    );

REVOKE ALL ON FUNCTION ao_current_workspace_id() FROM PUBLIC;

-- +goose Down
DROP POLICY IF EXISTS ao_cloud_session_runtimes_workspace ON ao_cloud_session_runtimes;
CREATE POLICY ao_cloud_session_runtimes_all ON ao_cloud_session_runtimes
    FOR ALL
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
DROP FUNCTION IF EXISTS ao_current_workspace_id();
