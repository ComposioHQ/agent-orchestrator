-- +goose Up
-- Provider credentials are ciphertext-only durable state. There is no
-- plaintext column, generic payload column, argv/env field, or local path.
CREATE TABLE ao_harness_credentials (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 128 AND name = btrim(name)),
    provider TEXT NOT NULL CHECK (provider = 'claude-code' AND octet_length(provider) <= 32),
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (octet_length(metadata::TEXT) <= 4096),
    ciphertext BYTEA NOT NULL
        CHECK (octet_length(ciphertext) BETWEEN 17 AND 65568),
    encrypted_data_key BYTEA NOT NULL
        CHECK (octet_length(encrypted_data_key) BETWEEN 1 AND 16384),
    nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
    key_id TEXT NOT NULL
        CHECK (octet_length(key_id) BETWEEN 1 AND 512 AND key_id = btrim(key_id)),
    plaintext_bytes BIGINT NOT NULL CHECK (plaintext_bytes BETWEEN 1 AND 65536),
    version BIGINT NOT NULL CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    UNIQUE (org_id, owner_user_id, provider)
);
CREATE INDEX ao_harness_credentials_org_owner_idx
    ON ao_harness_credentials(org_id, owner_user_id, provider);

CREATE TABLE ao_harness_credential_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES ao_cloud_workspaces(id) ON DELETE CASCADE,
    runtime_id UUID NOT NULL REFERENCES ao_cloud_session_runtimes(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL CHECK (octet_length(session_id) BETWEEN 1 AND 256),
    sandbox_id TEXT NOT NULL CHECK (octet_length(sandbox_id) BETWEEN 1 AND 256),
    grant_id TEXT NOT NULL CHECK (octet_length(grant_id) BETWEEN 1 AND 256),
    credential_id UUID NOT NULL REFERENCES ao_harness_credentials(id) ON DELETE RESTRICT,
    credential_version BIGINT NOT NULL CHECK (credential_version > 0),
    provider TEXT NOT NULL CHECK (provider = 'claude-code'),
    plaintext_bytes BIGINT NOT NULL CHECK (plaintext_bytes BETWEEN 1 AND 65536),
    idempotency_key TEXT NOT NULL
        CHECK (octet_length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key = btrim(idempotency_key)),
    state TEXT NOT NULL CHECK (state IN ('loading', 'loaded', 'purged', 'failed')),
    lease_expires_at TIMESTAMPTZ NOT NULL,
    acknowledged_at TIMESTAMPTZ,
    harness_receipt TEXT CHECK (harness_receipt IS NULL OR octet_length(harness_receipt) BETWEEN 1 AND 256),
    purged_at TIMESTAMPTZ,
    failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('validation', 'load', 'missing_ack', 'cancelled', 'audit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, sandbox_id, idempotency_key)
);
CREATE INDEX ao_harness_credential_deliveries_inflight_idx
    ON ao_harness_credential_deliveries(org_id, owner_user_id, sandbox_id, lease_expires_at)
    WHERE state = 'loading';

CREATE TABLE ao_harness_credential_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    credential_id UUID NOT NULL REFERENCES ao_harness_credentials(id) ON DELETE RESTRICT,
    credential_version BIGINT NOT NULL CHECK (credential_version > 0),
    provider TEXT NOT NULL CHECK (provider = 'claude-code'),
    event TEXT NOT NULL CHECK (event IN (
        'credential.created', 'credential.rotated', 'credential.revoked',
        'credential.load_acknowledged', 'credential.purged', 'credential.delivery_failed'
    )),
    delivery_id UUID REFERENCES ao_harness_credential_deliveries(id) ON DELETE SET NULL,
    workspace_id UUID,
    runtime_id UUID,
    sandbox_id TEXT NOT NULL DEFAULT '',
    grant_id TEXT NOT NULL DEFAULT '',
    failure_code TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ao_harness_credential_audit_delivery_event_idx
    ON ao_harness_credential_audit(delivery_id, event)
    WHERE delivery_id IS NOT NULL;
CREATE INDEX ao_harness_credential_audit_owner_time_idx
    ON ao_harness_credential_audit(org_id, owner_user_id, occurred_at DESC, id DESC);

ALTER TABLE ao_harness_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_harness_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_harness_credentials_owner ON ao_harness_credentials
    FOR SELECT USING (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, owner_user_id)
    );

ALTER TABLE ao_harness_credential_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_harness_credential_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_harness_credential_deliveries_owner_select ON ao_harness_credential_deliveries
    FOR SELECT USING (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND workspace_id = ao_current_workspace_id()
    );

ALTER TABLE ao_harness_credential_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_harness_credential_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_harness_credential_audit_owner_select ON ao_harness_credential_audit
    FOR SELECT USING (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, owner_user_id)
    );

REVOKE ALL ON TABLE ao_harness_credentials, ao_harness_credential_deliveries, ao_harness_credential_audit FROM PUBLIC;
REVOKE ALL ON SEQUENCE ao_harness_credential_audit_id_seq FROM PUBLIC;

-- +goose Down
DROP POLICY IF EXISTS ao_harness_credential_audit_owner_select ON ao_harness_credential_audit;
DROP POLICY IF EXISTS ao_harness_credential_deliveries_owner_select ON ao_harness_credential_deliveries;
DROP POLICY IF EXISTS ao_harness_credentials_owner ON ao_harness_credentials;
DROP TABLE IF EXISTS ao_harness_credential_audit;
DROP TABLE IF EXISTS ao_harness_credential_deliveries;
DROP TABLE IF EXISTS ao_harness_credentials;

