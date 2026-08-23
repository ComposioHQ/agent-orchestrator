-- +goose Up
-- Coding-agent credentials are owned by one user inside one organization.
-- The runtime role can only see the current user's rows in the selected org;
-- even an organization administrator cannot read another member's ciphertext.
CREATE TABLE ao_harness_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex', 'cursor')),
    credential_type TEXT NOT NULL CHECK (credential_type IN ('oauth_token', 'api_key', 'access_token')),
    ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
    encrypted_data_key BYTEA NOT NULL CHECK (octet_length(encrypted_data_key) > 0),
    nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
    key_id TEXT NOT NULL CHECK (btrim(key_id) <> ''),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at TIMESTAMPTZ,
    UNIQUE (org_id, owner_user_id, provider)
);

CREATE TABLE ao_harness_credential_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    credential_id UUID NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex', 'cursor')),
    event TEXT NOT NULL CHECK (event IN (
        'credential.created', 'credential.rotated', 'credential.decrypted',
        'credential.materialized', 'credential.purged', 'credential.revoked'
    )),
    credential_version BIGINT NOT NULL CHECK (credential_version > 0),
    sandbox_id TEXT NOT NULL DEFAULT '',
    workspace_id UUID,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ao_harness_credential_audit_owner_time_idx
    ON ao_harness_credential_audit(org_id, owner_user_id, occurred_at DESC, id DESC);

ALTER TABLE ao_harness_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_harness_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_harness_credentials_owner ON ao_harness_credentials
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

ALTER TABLE ao_harness_credential_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_harness_credential_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_harness_credential_audit_owner_select ON ao_harness_credential_audit
    FOR SELECT
    USING (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE POLICY ao_harness_credential_audit_owner_insert ON ao_harness_credential_audit
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND actor_user_id = ao_current_user_id()
        AND sandbox_id = ''
        AND ao_is_org_member(org_id, ao_current_user_id())
    );

REVOKE ALL ON TABLE ao_harness_credentials, ao_harness_credential_audit FROM PUBLIC;
REVOKE ALL ON SEQUENCE ao_harness_credential_audit_id_seq FROM PUBLIC;

-- +goose Down
DROP POLICY IF EXISTS ao_harness_credential_audit_owner_insert ON ao_harness_credential_audit;
DROP POLICY IF EXISTS ao_harness_credential_audit_owner_select ON ao_harness_credential_audit;
DROP POLICY IF EXISTS ao_harness_credentials_owner ON ao_harness_credentials;
DROP TABLE IF EXISTS ao_harness_credential_audit;
DROP TABLE IF EXISTS ao_harness_credentials;
