-- +goose Up
-- Webhook ingest and install-callback completion run without an authenticated
-- principal, so they cannot rely on the ao.user_id/ao.org_id RLS context. They
-- get one purpose-built NOLOGIN role that owns a small set of SECURITY DEFINER
-- functions instead. The role can only touch SCM tables, and the webhook
-- functions are deliberately one-directional: they may suspend an installation
-- or drop a repository from the allowlist, but they can never mark a
-- repository allowed. Widening access always requires an org admin.

CREATE TABLE ao_scm_webhook_deliveries (
    provider TEXT NOT NULL CHECK (provider = 'github'),
    delivery_id TEXT NOT NULL CHECK (btrim(delivery_id) <> ''),
    event TEXT NOT NULL DEFAULT '',
    external_installation_id BIGINT NOT NULL DEFAULT 0,
    body BYTEA NOT NULL DEFAULT ''::BYTEA CHECK (octet_length(body) <= 2097152),
    processing_state TEXT NOT NULL DEFAULT 'received'
        CHECK (processing_state IN ('received', 'processing', 'retry', 'complete')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 128),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, delivery_id)
);
CREATE INDEX ao_scm_webhook_deliveries_received_idx
    ON ao_scm_webhook_deliveries(received_at);
CREATE INDEX ao_scm_webhook_deliveries_retry_idx
    ON ao_scm_webhook_deliveries(processing_state, next_attempt_at)
    WHERE processing_state IN ('received', 'processing', 'retry');

ALTER TABLE ao_scm_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_webhook_deliveries FORCE ROW LEVEL SECURITY;

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_cloud_scm') THEN
        CREATE ROLE ao_cloud_scm NOLOGIN;
    END IF;
    IF NOT pg_has_role(current_user, 'ao_cloud_scm', 'SET') THEN
        EXECUTE format('GRANT ao_cloud_scm TO %I WITH SET TRUE', current_user);
    END IF;
END
$$;
-- +goose StatementEnd

GRANT USAGE ON SCHEMA public TO ao_cloud_scm;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    ao_scm_installations, ao_scm_repositories,
    ao_scm_install_states, ao_scm_webhook_deliveries
    TO ao_cloud_scm;
-- Postgres checks EXECUTE permission on every policy expression it plans, not
-- only the ones that decide the row. The definer role therefore needs the
-- tenant helpers even though its own policy never calls them.
GRANT EXECUTE ON FUNCTION
    ao_current_user_id(), ao_current_org_id(),
    ao_is_org_member(UUID, UUID), ao_can_manage_org(UUID, UUID)
    TO ao_cloud_scm;

CREATE POLICY ao_scm_installations_scm_definer ON ao_scm_installations
    FOR ALL USING (current_user = 'ao_cloud_scm')
    WITH CHECK (current_user = 'ao_cloud_scm');
CREATE POLICY ao_scm_repositories_scm_definer ON ao_scm_repositories
    FOR ALL USING (current_user = 'ao_cloud_scm')
    WITH CHECK (current_user = 'ao_cloud_scm');
CREATE POLICY ao_scm_install_states_scm_definer ON ao_scm_install_states
    FOR ALL USING (current_user = 'ao_cloud_scm')
    WITH CHECK (current_user = 'ao_cloud_scm');
CREATE POLICY ao_scm_webhook_deliveries_scm_definer ON ao_scm_webhook_deliveries
    FOR ALL USING (current_user = 'ao_cloud_scm')
    WITH CHECK (current_user = 'ao_cloud_scm');

-- Single-use consumption of an install-redirect state. Expired states are
-- swept on the same call so a failed link cannot linger as a replay target.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_consume_install_state(candidate_hash BYTEA)
RETURNS TABLE (org_id UUID, user_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    DELETE FROM public.ao_scm_install_states WHERE expires_at <= now();
    RETURN QUERY
    DELETE FROM public.ao_scm_install_states pending
    WHERE pending.state_hash = candidate_hash
      AND pending.expires_at > now()
    RETURNING pending.org_id, pending.user_id;
END
$$;
-- +goose StatementEnd

-- Delivery-id dedup. Returns TRUE only for the first delivery observed, so a
-- redelivery of the same event never re-applies a side effect.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_record_webhook_delivery(
    candidate_provider TEXT,
    candidate_delivery_id TEXT,
    candidate_event TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected INTEGER;
BEGIN
    INSERT INTO public.ao_scm_webhook_deliveries (
        provider, delivery_id, event
    ) VALUES (
        candidate_provider,
        candidate_delivery_id,
        coalesce(candidate_event, '')
    )
    ON CONFLICT (provider, delivery_id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected > 0;
END
$$;
-- +goose StatementEnd

-- Persist the verified raw body and acquire the initial processing lease
-- before JSON parsing. A duplicate may acquire a still-received delivery, so
-- an interruption between delivery-id dedup and body persistence cannot let a
-- redelivery suppress unfinished work.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_prepare_webhook_delivery(
    candidate_provider TEXT,
    candidate_delivery_id TEXT,
    candidate_body BYTEA
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected INTEGER;
BEGIN
    UPDATE public.ao_scm_webhook_deliveries
    SET body = candidate_body,
        processing_state = 'processing',
        attempts = attempts + 1,
        next_attempt_at = now() + interval '5 minutes',
        last_error = '',
        updated_at = now()
    WHERE provider = candidate_provider
      AND delivery_id = candidate_delivery_id
      AND processing_state = 'received';
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected > 0;
END
$$;
-- +goose StatementEnd

-- Record only a stable, sanitized error code. Provider payloads, database
-- errors, and credential material must never enter the error ledger.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_finish_webhook_delivery(
    candidate_provider TEXT,
    candidate_delivery_id TEXT,
    candidate_state TEXT,
    candidate_error TEXT,
    candidate_external_installation_id BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected INTEGER;
    already_complete BOOLEAN;
BEGIN
    IF candidate_state NOT IN ('complete', 'retry') THEN
        RAISE EXCEPTION 'unsupported webhook processing state';
    END IF;
    UPDATE public.ao_scm_webhook_deliveries
    SET processing_state = candidate_state,
        next_attempt_at = CASE
            WHEN candidate_state = 'retry' THEN
                now() + make_interval(secs => least(
                    3600,
                    power(2::NUMERIC, least(greatest(attempts - 1, 0), 12))::INTEGER
                ))
            ELSE now()
        END,
        last_error = left(coalesce(candidate_error, ''), 128),
        external_installation_id = coalesce(candidate_external_installation_id, 0),
        updated_at = now()
    WHERE provider = candidate_provider
      AND delivery_id = candidate_delivery_id
      AND processing_state = 'processing';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected > 0 THEN
        RETURN TRUE;
    END IF;
    IF candidate_state = 'complete' THEN
        SELECT EXISTS (
            SELECT 1
            FROM public.ao_scm_webhook_deliveries delivery
            WHERE delivery.provider = candidate_provider
              AND delivery.delivery_id = candidate_delivery_id
              AND delivery.processing_state = 'complete'
        ) INTO already_complete;
        RETURN already_complete;
    END IF;
    RETURN FALSE;
END
$$;
-- +goose StatementEnd

-- Atomically claim bounded retry work. SKIP LOCKED permits multiple control
-- plane replicas without processing one delivery concurrently.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_claim_webhook_retries(
    candidate_provider TEXT,
    candidate_limit INTEGER
) RETURNS TABLE (delivery_id TEXT, event TEXT, body BYTEA)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT pending.provider, pending.delivery_id
        FROM public.ao_scm_webhook_deliveries pending
        WHERE pending.provider = candidate_provider
          AND pending.processing_state IN ('processing', 'retry')
          AND pending.next_attempt_at <= now()
          AND pending.body <> ''::BYTEA
        ORDER BY pending.next_attempt_at, pending.delivery_id
        FOR UPDATE SKIP LOCKED
        LIMIT greatest(0, least(candidate_limit, 100))
    )
    UPDATE public.ao_scm_webhook_deliveries claimed
    SET processing_state = 'processing',
        attempts = claimed.attempts + 1,
        next_attempt_at = now() + interval '5 minutes',
        updated_at = now()
    FROM candidates
    WHERE claimed.provider = candidates.provider
      AND claimed.delivery_id = candidates.delivery_id
    RETURNING claimed.delivery_id, claimed.event, claimed.body;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_scm_prune_webhook_deliveries(retain INTERVAL)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    removed BIGINT;
BEGIN
    DELETE FROM public.ao_scm_webhook_deliveries
    WHERE processing_state = 'complete'
      AND updated_at < now() - retain;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_scm_installation_context(
    candidate_provider TEXT,
    candidate_external_installation_id BIGINT
) RETURNS TABLE (
    installation_id UUID,
    org_id UUID,
    account_login TEXT,
    status TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT installation.id, installation.org_id,
           installation.account_login, installation.status
    FROM public.ao_scm_installations installation
    WHERE installation.provider = candidate_provider
      AND installation.external_installation_id = candidate_external_installation_id
$$;
-- +goose StatementEnd

-- Webhooks may only narrow: 'suspended' and 'removed' are reachable, and
-- reactivation is deliberately included because GitHub's unsuspend event is
-- the org owner's own action on the same installation record.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_set_installation_status(
    candidate_provider TEXT,
    candidate_external_installation_id BIGINT,
    candidate_status TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected INTEGER;
BEGIN
    IF candidate_status NOT IN ('active', 'suspended', 'removed') THEN
        RAISE EXCEPTION 'unsupported installation status';
    END IF;
    UPDATE public.ao_scm_installations
    SET status = candidate_status, updated_at = now()
    WHERE provider = candidate_provider
      AND external_installation_id = candidate_external_installation_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected > 0;
END
$$;
-- +goose StatementEnd

-- Repository add events record visibility only. `allowed` is never written
-- here, and an existing allowlist decision is left untouched.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_webhook_upsert_repository(
    candidate_provider TEXT,
    candidate_external_installation_id BIGINT,
    candidate_external_repository_id BIGINT,
    candidate_full_name TEXT,
    candidate_private BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    target_installation_id UUID;
    target_org_id UUID;
    affected INTEGER;
BEGIN
    SELECT id, org_id INTO target_installation_id, target_org_id
    FROM public.ao_scm_installations
    WHERE provider = candidate_provider
      AND external_installation_id = candidate_external_installation_id;
    IF target_installation_id IS NULL THEN
        RETURN FALSE;
    END IF;
    INSERT INTO public.ao_scm_repositories (
        installation_id, org_id, external_repository_id, full_name, private, allowed
    ) VALUES (
        target_installation_id,
        target_org_id,
        candidate_external_repository_id,
        lower(btrim(candidate_full_name)),
        coalesce(candidate_private, TRUE),
        FALSE
    )
    ON CONFLICT (installation_id, external_repository_id)
    DO UPDATE SET full_name = EXCLUDED.full_name,
                  private = EXCLUDED.private,
                  updated_at = now();
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected > 0;
EXCEPTION
    -- The same repository name already resolves to a different installation in
    -- this organization. Refuse rather than let a webhook repoint the name.
    WHEN unique_violation THEN
        RETURN FALSE;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_scm_webhook_remove_repository(
    candidate_provider TEXT,
    candidate_external_installation_id BIGINT,
    candidate_external_repository_id BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected INTEGER;
BEGIN
    DELETE FROM public.ao_scm_repositories repository
    USING public.ao_scm_installations installation
    WHERE repository.installation_id = installation.id
      AND installation.provider = candidate_provider
      AND installation.external_installation_id = candidate_external_installation_id
      AND repository.external_repository_id = candidate_external_repository_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected > 0;
END
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION ao_scm_consume_install_state(BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_record_webhook_delivery(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_prepare_webhook_delivery(TEXT, TEXT, BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_finish_webhook_delivery(TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_claim_webhook_retries(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_prune_webhook_deliveries(INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_installation_context(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_set_installation_status(TEXT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_webhook_upsert_repository(TEXT, BIGINT, BIGINT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_webhook_remove_repository(TEXT, BIGINT, BIGINT) FROM PUBLIC;

ALTER FUNCTION ao_scm_consume_install_state(BYTEA) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_record_webhook_delivery(TEXT, TEXT, TEXT) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_prepare_webhook_delivery(TEXT, TEXT, BYTEA) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_finish_webhook_delivery(TEXT, TEXT, TEXT, TEXT, BIGINT) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_claim_webhook_retries(TEXT, INTEGER) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_prune_webhook_deliveries(INTERVAL) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_installation_context(TEXT, BIGINT) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_set_installation_status(TEXT, BIGINT, TEXT) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_webhook_upsert_repository(TEXT, BIGINT, BIGINT, TEXT, BOOLEAN) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_webhook_remove_repository(TEXT, BIGINT, BIGINT) OWNER TO ao_cloud_scm;

REVOKE ALL ON TABLE ao_scm_webhook_deliveries FROM PUBLIC;

-- Drift guard: every SCM table must keep RLS forced, including for its owner.
-- +goose StatementBegin
DO $$
DECLARE
    unforced TEXT;
BEGIN
    SELECT string_agg(relation.relname, ', ')
    INTO unforced
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind = 'r'
      AND relation.relname LIKE 'ao\_scm\_%'
      AND NOT (relation.relrowsecurity AND relation.relforcerowsecurity);
    IF unforced IS NOT NULL THEN
        RAISE EXCEPTION 'SCM tables without forced row-level security: %', unforced;
    END IF;
END
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION IF EXISTS ao_scm_webhook_remove_repository(TEXT, BIGINT, BIGINT);
DROP FUNCTION IF EXISTS ao_scm_webhook_upsert_repository(TEXT, BIGINT, BIGINT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS ao_scm_set_installation_status(TEXT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS ao_scm_installation_context(TEXT, BIGINT);
DROP FUNCTION IF EXISTS ao_scm_prune_webhook_deliveries(INTERVAL);
DROP FUNCTION IF EXISTS ao_scm_claim_webhook_retries(TEXT, INTEGER);
DROP FUNCTION IF EXISTS ao_scm_finish_webhook_delivery(TEXT, TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS ao_scm_prepare_webhook_delivery(TEXT, TEXT, BYTEA);
DROP FUNCTION IF EXISTS ao_scm_record_webhook_delivery(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS ao_scm_consume_install_state(BYTEA);
DROP POLICY IF EXISTS ao_scm_webhook_deliveries_scm_definer ON ao_scm_webhook_deliveries;
DROP POLICY IF EXISTS ao_scm_install_states_scm_definer ON ao_scm_install_states;
DROP POLICY IF EXISTS ao_scm_repositories_scm_definer ON ao_scm_repositories;
DROP POLICY IF EXISTS ao_scm_installations_scm_definer ON ao_scm_installations;
DROP TABLE IF EXISTS ao_scm_webhook_deliveries;
