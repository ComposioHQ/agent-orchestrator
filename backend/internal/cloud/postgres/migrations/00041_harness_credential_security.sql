-- +goose Up
-- A NOLOGIN, non-BYPASSRLS role owns the narrow SECURITY DEFINER functions.
-- The runtime role receives EXECUTE privileges only during central integration;
-- this migration never broadens the central runtime table/grant registries.
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

GRANT USAGE ON SCHEMA public TO ao_cloud_credentials;
GRANT SELECT, INSERT, UPDATE ON ao_harness_credentials, ao_harness_credential_deliveries TO ao_cloud_credentials;
GRANT SELECT ON ao_harness_credential_audit, ao_cloud_workspaces, ao_cloud_session_runtimes TO ao_cloud_credentials;
GRANT INSERT ON ao_harness_credential_audit TO ao_cloud_credentials;
GRANT USAGE, SELECT ON SEQUENCE ao_harness_credential_audit_id_seq TO ao_cloud_credentials;
GRANT EXECUTE ON FUNCTION ao_current_user_id(), ao_current_org_id(), ao_current_workspace_id(), ao_is_org_member(UUID, UUID)
    TO ao_cloud_credentials;

CREATE POLICY ao_harness_credentials_definer ON ao_harness_credentials
    FOR ALL USING (current_user = 'ao_cloud_credentials')
    WITH CHECK (current_user = 'ao_cloud_credentials');
CREATE POLICY ao_harness_credential_deliveries_definer ON ao_harness_credential_deliveries
    FOR ALL USING (current_user = 'ao_cloud_credentials')
    WITH CHECK (current_user = 'ao_cloud_credentials');
CREATE POLICY ao_harness_credential_audit_definer ON ao_harness_credential_audit
    FOR INSERT WITH CHECK (current_user = 'ao_cloud_credentials');
CREATE POLICY ao_cloud_workspaces_credential_definer ON ao_cloud_workspaces
    FOR SELECT USING (current_user = 'ao_cloud_credentials');
CREATE POLICY ao_cloud_session_runtimes_credential_definer ON ao_cloud_session_runtimes
    FOR SELECT USING (current_user = 'ao_cloud_credentials');

-- +goose StatementBegin
CREATE FUNCTION ao_put_harness_credential(
    candidate_id UUID, candidate_name TEXT, candidate_provider TEXT, candidate_metadata JSONB,
    candidate_ciphertext BYTEA, candidate_encrypted_data_key BYTEA, candidate_nonce BYTEA,
    candidate_key_id TEXT, candidate_plaintext_bytes BIGINT, candidate_version BIGINT,
    candidate_expected_version BIGINT, candidate_max_user_bytes BIGINT, candidate_max_org_bytes BIGINT
) RETURNS SETOF ao_harness_credentials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    scoped_org_id UUID := public.ao_current_org_id();
    scoped_user_id UUID := public.ao_current_user_id();
    existing_id UUID;
    existing_version BIGINT;
    current_user_bytes BIGINT;
    current_org_bytes BIGINT;
    audit_event TEXT;
BEGIN
    IF scoped_org_id IS NULL OR scoped_user_id IS NULL OR
       NOT public.ao_is_org_member(scoped_org_id, scoped_user_id) OR
       candidate_provider <> 'claude-code' THEN
        RAISE EXCEPTION USING ERRCODE = 'AO401', MESSAGE = 'credential scope denied';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(scoped_org_id::TEXT, 401));
    PERFORM pg_advisory_xact_lock(hashtextextended(scoped_user_id::TEXT, 402));

    SELECT id, version INTO existing_id, existing_version
      FROM public.ao_harness_credentials
     WHERE org_id = scoped_org_id AND owner_user_id = scoped_user_id AND provider = candidate_provider;
    IF candidate_expected_version = 0 THEN
        IF existing_id IS NOT NULL OR candidate_version <> 1 THEN
            RAISE EXCEPTION USING ERRCODE = 'AO409', MESSAGE = 'credential version conflict';
        END IF;
        audit_event := 'credential.created';
    ELSIF existing_id IS NULL OR existing_id <> candidate_id OR existing_version <> candidate_expected_version OR
          candidate_version <> candidate_expected_version + 1 OR EXISTS (
              SELECT 1 FROM public.ao_harness_credentials WHERE id = candidate_id AND revoked_at IS NOT NULL
          ) THEN
        RAISE EXCEPTION USING ERRCODE = 'AO409', MESSAGE = 'credential version conflict';
    ELSE
        audit_event := 'credential.rotated';
    END IF;

    SELECT COALESCE(sum(plaintext_bytes), 0) INTO current_user_bytes
      FROM public.ao_harness_credentials
     WHERE org_id = scoped_org_id AND owner_user_id = scoped_user_id AND id <> candidate_id AND revoked_at IS NULL;
    SELECT COALESCE(sum(plaintext_bytes), 0) INTO current_org_bytes
      FROM public.ao_harness_credentials
     WHERE org_id = scoped_org_id AND id <> candidate_id AND revoked_at IS NULL;
    IF current_user_bytes + candidate_plaintext_bytes > candidate_max_user_bytes OR
       current_org_bytes + candidate_plaintext_bytes > candidate_max_org_bytes THEN
        RAISE EXCEPTION USING ERRCODE = 'AO429', MESSAGE = 'credential aggregate limit exceeded';
    END IF;

    INSERT INTO public.ao_harness_credentials (
        id, org_id, owner_user_id, name, provider, metadata, ciphertext,
        encrypted_data_key, nonce, key_id, plaintext_bytes, version
    ) VALUES (
        candidate_id, scoped_org_id, scoped_user_id, candidate_name, candidate_provider,
        candidate_metadata, candidate_ciphertext, candidate_encrypted_data_key, candidate_nonce,
        candidate_key_id, candidate_plaintext_bytes, candidate_version
    )
    ON CONFLICT (org_id, owner_user_id, provider) DO UPDATE SET
        name = EXCLUDED.name, metadata = EXCLUDED.metadata, ciphertext = EXCLUDED.ciphertext,
        encrypted_data_key = EXCLUDED.encrypted_data_key, nonce = EXCLUDED.nonce,
        key_id = EXCLUDED.key_id, plaintext_bytes = EXCLUDED.plaintext_bytes,
        version = EXCLUDED.version, updated_at = now()
    WHERE ao_harness_credentials.id = candidate_id
      AND ao_harness_credentials.version = candidate_expected_version
      AND ao_harness_credentials.revoked_at IS NULL;

    INSERT INTO public.ao_harness_credential_audit (
        org_id, owner_user_id, credential_id, credential_version, provider, event
    ) VALUES (scoped_org_id, scoped_user_id, candidate_id, candidate_version, candidate_provider, audit_event);
    RETURN QUERY SELECT * FROM public.ao_harness_credentials WHERE id = candidate_id;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_revoke_harness_credential(candidate_provider TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    scoped_org_id UUID := public.ao_current_org_id();
    scoped_user_id UUID := public.ao_current_user_id();
    revoked_id UUID;
    revoked_version BIGINT;
BEGIN
    UPDATE public.ao_harness_credentials
       SET revoked_at = now(), updated_at = now()
     WHERE org_id = scoped_org_id AND owner_user_id = scoped_user_id
       AND provider = candidate_provider AND revoked_at IS NULL
     RETURNING id, version INTO revoked_id, revoked_version;
    IF revoked_id IS NOT NULL THEN
        INSERT INTO public.ao_harness_credential_audit (
            org_id, owner_user_id, credential_id, credential_version, provider, event
        ) VALUES (scoped_org_id, scoped_user_id, revoked_id, revoked_version, candidate_provider, 'credential.revoked');
    END IF;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_claim_harness_credential_delivery(
    candidate_grant_id TEXT, candidate_org_id UUID, candidate_workspace_id UUID,
    candidate_session_id TEXT, candidate_role TEXT, candidate_provider TEXT,
    candidate_idempotency_key TEXT, max_inflight_sandbox INTEGER,
    max_inflight_user INTEGER, max_inflight_org INTEGER, max_sandbox_bytes BIGINT
) RETURNS TABLE (
    delivery_id UUID, delivery_state TEXT, sandbox_id TEXT,
    credential_id UUID, org_id UUID, owner_user_id UUID, credential_name TEXT,
    provider TEXT, metadata JSONB, ciphertext BYTEA, encrypted_data_key BYTEA,
    nonce BYTEA, key_id TEXT, plaintext_bytes BIGINT, credential_version BIGINT,
    credential_created_at TIMESTAMPTZ, credential_updated_at TIMESTAMPTZ,
    credential_revoked_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ, harness_receipt TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    resolved_runtime public.ao_cloud_session_runtimes%ROWTYPE;
    resolved_owner_id UUID;
    resolved_credential public.ao_harness_credentials%ROWTYPE;
    existing_delivery public.ao_harness_credential_deliveries%ROWTYPE;
BEGIN
    IF candidate_role <> 'worker' OR candidate_provider <> 'claude-code' OR
       btrim(coalesce(candidate_grant_id, '')) = '' OR btrim(coalesce(candidate_idempotency_key, '')) = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'AO401', MESSAGE = 'credential capability scope denied';
    END IF;
    SELECT runtime.* INTO resolved_runtime
      FROM public.ao_cloud_session_runtimes runtime
      JOIN public.ao_cloud_workspaces workspace
        ON workspace.id = runtime.workspace_id AND workspace.org_id = runtime.org_id
     WHERE runtime.org_id = candidate_org_id
       AND runtime.workspace_id = candidate_workspace_id
       AND runtime.session_id = candidate_session_id
       AND runtime.state = 'running'
       AND btrim(runtime.sandbox_id) <> '';
    IF resolved_runtime.id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'AO401', MESSAGE = 'credential runtime scope denied';
    END IF;
    SELECT workspace.owner_user_id INTO resolved_owner_id FROM public.ao_cloud_workspaces workspace
     WHERE workspace.id = candidate_workspace_id AND workspace.org_id = candidate_org_id;
    SELECT credential.* INTO resolved_credential
      FROM public.ao_harness_credentials credential
     WHERE credential.org_id = candidate_org_id
       AND credential.owner_user_id = resolved_owner_id
       AND credential.provider = candidate_provider
       AND credential.revoked_at IS NULL;
    IF resolved_credential.id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'AO401', MESSAGE = 'credential not authorized';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(candidate_org_id::TEXT || ':' || resolved_runtime.sandbox_id || ':' || candidate_idempotency_key, 410));
    SELECT candidate_delivery.* INTO existing_delivery FROM public.ao_harness_credential_deliveries candidate_delivery
     WHERE candidate_delivery.org_id = candidate_org_id AND candidate_delivery.sandbox_id = resolved_runtime.sandbox_id
       AND candidate_delivery.idempotency_key = candidate_idempotency_key;
    IF existing_delivery.id IS NOT NULL THEN
        IF existing_delivery.grant_id <> candidate_grant_id OR
           existing_delivery.workspace_id <> candidate_workspace_id OR
           existing_delivery.runtime_id <> resolved_runtime.id OR
           existing_delivery.credential_id <> resolved_credential.id OR
           existing_delivery.credential_version <> resolved_credential.version THEN
            RAISE EXCEPTION USING ERRCODE = 'AO401', MESSAGE = 'idempotency scope mismatch';
        END IF;
        IF existing_delivery.state = 'loading' AND existing_delivery.lease_expires_at > now() THEN
            RAISE EXCEPTION USING ERRCODE = 'AO409', MESSAGE = 'credential delivery in flight';
        ELSIF existing_delivery.state IN ('loaded', 'purged') THEN
            RETURN QUERY SELECT existing_delivery.id, 'loaded'::TEXT, existing_delivery.sandbox_id,
                resolved_credential.id, resolved_credential.org_id, resolved_credential.owner_user_id,
                resolved_credential.name, resolved_credential.provider, resolved_credential.metadata,
                resolved_credential.ciphertext, resolved_credential.encrypted_data_key, resolved_credential.nonce,
                resolved_credential.key_id, resolved_credential.plaintext_bytes, resolved_credential.version,
                resolved_credential.created_at, resolved_credential.updated_at, resolved_credential.revoked_at,
                existing_delivery.acknowledged_at, existing_delivery.harness_receipt;
            RETURN;
        ELSE
            UPDATE public.ao_harness_credential_deliveries SET state = 'loading', failure_code = NULL,
                lease_expires_at = now() + interval '30 seconds', updated_at = now()
             WHERE id = existing_delivery.id;
        END IF;
    ELSE
        IF (SELECT count(*) FROM public.ao_harness_credential_deliveries inflight
             WHERE inflight.sandbox_id = resolved_runtime.sandbox_id AND inflight.state = 'loading' AND inflight.lease_expires_at > now()) >= max_inflight_sandbox OR
           (SELECT count(*) FROM public.ao_harness_credential_deliveries inflight
             WHERE inflight.owner_user_id = resolved_owner_id AND inflight.state = 'loading' AND inflight.lease_expires_at > now()) >= max_inflight_user OR
           (SELECT count(*) FROM public.ao_harness_credential_deliveries inflight
             WHERE inflight.org_id = candidate_org_id AND inflight.state = 'loading' AND inflight.lease_expires_at > now()) >= max_inflight_org OR
           (SELECT COALESCE(sum(inflight.plaintext_bytes), 0) FROM public.ao_harness_credential_deliveries inflight
             WHERE inflight.sandbox_id = resolved_runtime.sandbox_id AND inflight.state = 'loading' AND inflight.lease_expires_at > now()) + resolved_credential.plaintext_bytes > max_sandbox_bytes THEN
            RAISE EXCEPTION USING ERRCODE = 'AO429', MESSAGE = 'credential delivery limit exceeded';
        END IF;
        INSERT INTO public.ao_harness_credential_deliveries (
            org_id, owner_user_id, workspace_id, runtime_id, session_id, sandbox_id,
            grant_id, credential_id, credential_version, provider, plaintext_bytes,
            idempotency_key, state, lease_expires_at
        ) VALUES (
            candidate_org_id, resolved_owner_id, candidate_workspace_id, resolved_runtime.id,
            candidate_session_id, resolved_runtime.sandbox_id, candidate_grant_id,
            resolved_credential.id, resolved_credential.version, candidate_provider,
            resolved_credential.plaintext_bytes, candidate_idempotency_key, 'loading', now() + interval '30 seconds'
        ) RETURNING id INTO existing_delivery.id;
    END IF;
    RETURN QUERY SELECT existing_delivery.id, 'claimed'::TEXT, resolved_runtime.sandbox_id,
        resolved_credential.id, resolved_credential.org_id, resolved_credential.owner_user_id,
        resolved_credential.name, resolved_credential.provider, resolved_credential.metadata,
        resolved_credential.ciphertext, resolved_credential.encrypted_data_key, resolved_credential.nonce,
        resolved_credential.key_id, resolved_credential.plaintext_bytes, resolved_credential.version,
        resolved_credential.created_at, resolved_credential.updated_at, resolved_credential.revoked_at,
        NULL::TIMESTAMPTZ, NULL::TEXT;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_acknowledge_harness_credential_delivery(
    candidate_delivery_id UUID, candidate_idempotency_key TEXT, candidate_provider TEXT,
    candidate_loaded_at TIMESTAMPTZ, candidate_receipt TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE delivery public.ao_harness_credential_deliveries%ROWTYPE;
BEGIN
    SELECT * INTO delivery FROM public.ao_harness_credential_deliveries WHERE id = candidate_delivery_id FOR UPDATE;
    IF delivery.id IS NULL OR delivery.idempotency_key <> candidate_idempotency_key OR
       delivery.provider <> candidate_provider OR delivery.state <> 'loading' OR
       candidate_loaded_at IS NULL OR btrim(coalesce(candidate_receipt, '')) = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'AO401', MESSAGE = 'invalid harness load acknowledgement';
    END IF;
    UPDATE public.ao_harness_credential_deliveries SET state = 'loaded', acknowledged_at = candidate_loaded_at,
        harness_receipt = candidate_receipt, updated_at = now() WHERE id = candidate_delivery_id;
    INSERT INTO public.ao_harness_credential_audit (
        org_id, owner_user_id, credential_id, credential_version, provider, event,
        delivery_id, workspace_id, runtime_id, sandbox_id, grant_id
    ) VALUES (delivery.org_id, delivery.owner_user_id, delivery.credential_id,
        delivery.credential_version, delivery.provider, 'credential.load_acknowledged', delivery.id,
        delivery.workspace_id, delivery.runtime_id, delivery.sandbox_id, delivery.grant_id)
    ON CONFLICT DO NOTHING;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_record_harness_credential_purge(candidate_delivery_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE delivery public.ao_harness_credential_deliveries%ROWTYPE;
BEGIN
    SELECT * INTO delivery FROM public.ao_harness_credential_deliveries WHERE id = candidate_delivery_id FOR UPDATE;
    IF delivery.id IS NULL OR delivery.state NOT IN ('loaded', 'purged') THEN
        RAISE EXCEPTION USING ERRCODE = 'AO401', MESSAGE = 'credential purge without acknowledgement';
    END IF;
    UPDATE public.ao_harness_credential_deliveries SET state = 'purged', purged_at = COALESCE(purged_at, now()),
        updated_at = now() WHERE id = candidate_delivery_id;
    INSERT INTO public.ao_harness_credential_audit (
        org_id, owner_user_id, credential_id, credential_version, provider, event,
        delivery_id, workspace_id, runtime_id, sandbox_id, grant_id
    ) VALUES (delivery.org_id, delivery.owner_user_id, delivery.credential_id,
        delivery.credential_version, delivery.provider, 'credential.purged', delivery.id,
        delivery.workspace_id, delivery.runtime_id, delivery.sandbox_id, delivery.grant_id)
    ON CONFLICT DO NOTHING;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_record_harness_credential_failure(candidate_delivery_id UUID, candidate_failure_code TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE delivery public.ao_harness_credential_deliveries%ROWTYPE;
BEGIN
    SELECT * INTO delivery FROM public.ao_harness_credential_deliveries WHERE id = candidate_delivery_id FOR UPDATE;
    IF delivery.id IS NULL OR candidate_failure_code NOT IN ('validation', 'load', 'missing_ack', 'cancelled', 'audit') THEN
        RETURN;
    END IF;
    IF delivery.state = 'loading' THEN
        UPDATE public.ao_harness_credential_deliveries SET state = 'failed', failure_code = candidate_failure_code,
            updated_at = now() WHERE id = candidate_delivery_id;
        INSERT INTO public.ao_harness_credential_audit (
            org_id, owner_user_id, credential_id, credential_version, provider, event,
            delivery_id, workspace_id, runtime_id, sandbox_id, grant_id, failure_code
        ) VALUES (delivery.org_id, delivery.owner_user_id, delivery.credential_id,
            delivery.credential_version, delivery.provider, 'credential.delivery_failed', delivery.id,
            delivery.workspace_id, delivery.runtime_id, delivery.sandbox_id, delivery.grant_id, candidate_failure_code)
        ON CONFLICT DO NOTHING;
    END IF;
END
$$;
-- +goose StatementEnd

ALTER FUNCTION ao_put_harness_credential(UUID, TEXT, TEXT, JSONB, BYTEA, BYTEA, BYTEA, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) OWNER TO ao_cloud_credentials;
ALTER FUNCTION ao_revoke_harness_credential(TEXT) OWNER TO ao_cloud_credentials;
ALTER FUNCTION ao_claim_harness_credential_delivery(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, BIGINT) OWNER TO ao_cloud_credentials;
ALTER FUNCTION ao_acknowledge_harness_credential_delivery(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) OWNER TO ao_cloud_credentials;
ALTER FUNCTION ao_record_harness_credential_purge(UUID) OWNER TO ao_cloud_credentials;
ALTER FUNCTION ao_record_harness_credential_failure(UUID, TEXT) OWNER TO ao_cloud_credentials;
REVOKE ALL ON FUNCTION ao_put_harness_credential(UUID, TEXT, TEXT, JSONB, BYTEA, BYTEA, BYTEA, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_revoke_harness_credential(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_claim_harness_credential_delivery(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_acknowledge_harness_credential_delivery(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_record_harness_credential_purge(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_record_harness_credential_failure(UUID, TEXT) FROM PUBLIC;

-- +goose Down
DROP FUNCTION IF EXISTS ao_record_harness_credential_failure(UUID, TEXT);
DROP FUNCTION IF EXISTS ao_record_harness_credential_purge(UUID);
DROP FUNCTION IF EXISTS ao_acknowledge_harness_credential_delivery(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS ao_claim_harness_credential_delivery(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, BIGINT);
DROP FUNCTION IF EXISTS ao_revoke_harness_credential(TEXT);
DROP FUNCTION IF EXISTS ao_put_harness_credential(UUID, TEXT, TEXT, JSONB, BYTEA, BYTEA, BYTEA, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT);
DROP POLICY IF EXISTS ao_cloud_session_runtimes_credential_definer ON ao_cloud_session_runtimes;
DROP POLICY IF EXISTS ao_cloud_workspaces_credential_definer ON ao_cloud_workspaces;
DROP POLICY IF EXISTS ao_harness_credential_audit_definer ON ao_harness_credential_audit;
DROP POLICY IF EXISTS ao_harness_credential_deliveries_definer ON ao_harness_credential_deliveries;
DROP POLICY IF EXISTS ao_harness_credentials_definer ON ao_harness_credentials;
