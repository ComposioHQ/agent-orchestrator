-- +goose Up
-- Sandbox bootstrap resolves a workspace owner inside PostgreSQL. A sandbox
-- capability never supplies an owner user id and therefore cannot choose
-- another member's credential.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_cloud_credentials') THEN
        CREATE ROLE ao_cloud_credentials NOLOGIN NOBYPASSRLS;
        EXECUTE format('GRANT ao_cloud_credentials TO %I WITH SET TRUE', current_user);
    ELSIF NOT pg_has_role(current_user, 'ao_cloud_credentials', 'SET') THEN
        RAISE EXCEPTION 'migration role % must be able to SET ROLE ao_cloud_credentials', current_user;
    END IF;
END
$$;
-- +goose StatementEnd

ALTER ROLE ao_cloud_credentials NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO ao_cloud_credentials;
GRANT SELECT ON ao_harness_credentials, ao_cloud_workspaces TO ao_cloud_credentials;
GRANT INSERT ON ao_harness_credential_audit TO ao_cloud_credentials;
GRANT USAGE, SELECT ON SEQUENCE ao_harness_credential_audit_id_seq TO ao_cloud_credentials;

CREATE POLICY ao_harness_credentials_bootstrap ON ao_harness_credentials
    FOR SELECT USING (current_user = 'ao_cloud_credentials');
CREATE POLICY ao_cloud_workspaces_credential_bootstrap ON ao_cloud_workspaces
    FOR SELECT USING (current_user = 'ao_cloud_credentials');
CREATE POLICY ao_harness_credential_audit_bootstrap ON ao_harness_credential_audit
    FOR INSERT WITH CHECK (current_user = 'ao_cloud_credentials');

-- +goose StatementBegin
CREATE FUNCTION ao_harness_credential_for_workspace(
    candidate_org_id UUID,
    candidate_workspace_id UUID,
    candidate_provider TEXT,
    candidate_sandbox_id TEXT
) RETURNS TABLE (
    id UUID, org_id UUID, owner_user_id UUID, provider TEXT, credential_type TEXT,
    ciphertext BYTEA, encrypted_data_key BYTEA, nonce BYTEA, key_id TEXT,
    version BIGINT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, rotated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    resolved_owner_id UUID;
    resolved_credential_id UUID;
    resolved_version BIGINT;
BEGIN
    IF btrim(coalesce(candidate_sandbox_id, '')) = '' THEN
        RAISE EXCEPTION 'sandbox id is required';
    END IF;
    SELECT workspace.owner_user_id INTO resolved_owner_id
      FROM public.ao_cloud_workspaces workspace
     WHERE workspace.id = candidate_workspace_id
       AND workspace.org_id = candidate_org_id;
    IF resolved_owner_id IS NULL THEN
        RETURN;
    END IF;
    SELECT credential.id, credential.version
      INTO resolved_credential_id, resolved_version
      FROM public.ao_harness_credentials credential
     WHERE credential.org_id = candidate_org_id
       AND credential.owner_user_id = resolved_owner_id
       AND credential.provider = candidate_provider;
    IF resolved_credential_id IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO public.ao_harness_credential_audit (
        org_id, owner_user_id, actor_user_id, credential_id, provider, event,
        credential_version, sandbox_id, workspace_id
    ) VALUES (
        candidate_org_id, resolved_owner_id, NULL, resolved_credential_id,
        candidate_provider, 'credential.decrypted', resolved_version,
        candidate_sandbox_id, candidate_workspace_id
    );
    RETURN QUERY
    SELECT credential.id, credential.org_id, credential.owner_user_id,
           credential.provider, credential.credential_type, credential.ciphertext,
           credential.encrypted_data_key, credential.nonce, credential.key_id,
           credential.version, credential.created_at, credential.updated_at,
           credential.rotated_at
      FROM public.ao_harness_credentials credential
     WHERE credential.id = resolved_credential_id;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_audit_harness_credential_workspace(
    candidate_org_id UUID,
    candidate_workspace_id UUID,
    candidate_provider TEXT,
    candidate_sandbox_id TEXT,
    candidate_event TEXT,
    candidate_version BIGINT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    resolved_owner_id UUID;
    resolved_credential_id UUID;
BEGIN
    IF candidate_event NOT IN ('credential.materialized', 'credential.purged') THEN
        RAISE EXCEPTION 'invalid bootstrap credential event';
    END IF;
    SELECT workspace.owner_user_id INTO resolved_owner_id
      FROM public.ao_cloud_workspaces workspace
     WHERE workspace.id = candidate_workspace_id
       AND workspace.org_id = candidate_org_id;
    SELECT credential.id INTO resolved_credential_id
      FROM public.ao_harness_credentials credential
     WHERE credential.org_id = candidate_org_id
       AND credential.owner_user_id = resolved_owner_id
       AND credential.provider = candidate_provider
       AND credential.version = candidate_version;
    IF resolved_credential_id IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO public.ao_harness_credential_audit (
        org_id, owner_user_id, actor_user_id, credential_id, provider, event,
        credential_version, sandbox_id, workspace_id
    ) VALUES (
        candidate_org_id, resolved_owner_id, NULL, resolved_credential_id,
        candidate_provider, candidate_event, candidate_version,
        candidate_sandbox_id, candidate_workspace_id
    );
END
$$;
-- +goose StatementEnd

ALTER FUNCTION ao_harness_credential_for_workspace(UUID, UUID, TEXT, TEXT)
    OWNER TO ao_cloud_credentials;
ALTER FUNCTION ao_audit_harness_credential_workspace(UUID, UUID, TEXT, TEXT, TEXT, BIGINT)
    OWNER TO ao_cloud_credentials;
REVOKE ALL ON FUNCTION ao_harness_credential_for_workspace(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_audit_harness_credential_workspace(UUID, UUID, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC;

-- +goose Down
DROP FUNCTION IF EXISTS ao_audit_harness_credential_workspace(UUID, UUID, TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS ao_harness_credential_for_workspace(UUID, UUID, TEXT, TEXT);
DROP POLICY IF EXISTS ao_harness_credential_audit_bootstrap ON ao_harness_credential_audit;
DROP POLICY IF EXISTS ao_cloud_workspaces_credential_bootstrap ON ao_cloud_workspaces;
DROP POLICY IF EXISTS ao_harness_credentials_bootstrap ON ao_harness_credentials;
