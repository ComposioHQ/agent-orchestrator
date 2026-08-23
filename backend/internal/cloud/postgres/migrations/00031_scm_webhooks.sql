-- +goose Up
-- Verified GitHub deliveries are durable before any side effect. The raw body,
-- classification, terminal decision, and initial lease are written by one
-- function so a caller cannot reserve a delivery id without its payload.

CREATE TABLE ao_scm_webhook_deliveries (
    provider TEXT NOT NULL CHECK (provider = 'github'),
    delivery_id TEXT NOT NULL CHECK (btrim(delivery_id) <> '' AND length(delivery_id) <= 255),
    event TEXT NOT NULL CHECK (btrim(event) <> '' AND length(event) <= 128),
    body BYTEA NOT NULL CHECK (octet_length(body) <= 2097152),
    classification TEXT NOT NULL
        CHECK (classification IN ('observation', 'ignored', 'malformed_json')),
    processing_state TEXT NOT NULL
        CHECK (processing_state IN ('pending', 'processing', 'retry', 'complete', 'dead_letter')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 16),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_id UUID,
    lease_expires_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 128),
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider, delivery_id),
    CHECK ((processing_state = 'processing') = (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK (processing_state <> 'dead_letter' OR last_error <> '')
);

CREATE INDEX ao_scm_webhook_deliveries_due_idx
    ON ao_scm_webhook_deliveries(next_attempt_at, delivery_id)
    WHERE processing_state IN ('pending', 'processing', 'retry');
CREATE INDEX ao_scm_webhook_deliveries_terminal_idx
    ON ao_scm_webhook_deliveries(updated_at)
    WHERE processing_state IN ('complete', 'dead_letter');

ALTER TABLE ao_scm_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_webhook_deliveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ao_scm_webhook_deliveries FROM PUBLIC;

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
GRANT SELECT, INSERT, UPDATE, DELETE ON ao_scm_webhook_deliveries TO ao_cloud_scm;
CREATE POLICY ao_scm_webhook_deliveries_definer ON ao_scm_webhook_deliveries
    FOR ALL USING (current_user = 'ao_cloud_scm')
    WITH CHECK (current_user = 'ao_cloud_scm');

-- The only receipt-ingest entry point. An insert includes the immutable raw
-- body and either an initial lease or a terminal malformed-JSON decision. A
-- duplicate can recover an expired lease, but never replaces the original
-- body, classification, or active lease.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_ingest_and_claim_webhook(
    candidate_provider TEXT,
    candidate_delivery_id TEXT,
    candidate_event TEXT,
    candidate_body BYTEA,
    candidate_classification TEXT,
    candidate_terminal_error TEXT
) RETURNS TABLE (
    provider TEXT,
    delivery_id TEXT,
    event TEXT,
    body BYTEA,
    classification TEXT,
    processing_state TEXT,
    lease_id UUID,
    attempts INTEGER,
    first_receipt BOOLEAN,
    claimed BOOLEAN,
    received_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    delivery public.ao_scm_webhook_deliveries%ROWTYPE;
    inserted BOOLEAN := FALSE;
    reclaimed BOOLEAN := FALSE;
    terminal BOOLEAN := btrim(coalesce(candidate_terminal_error, '')) <> '';
    observed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF candidate_provider <> 'github'
       OR btrim(coalesce(candidate_delivery_id, '')) = ''
       OR btrim(coalesce(candidate_event, '')) = ''
       OR octet_length(candidate_body) > 2097152
       OR candidate_classification NOT IN ('observation', 'ignored', 'malformed_json')
       OR (terminal AND candidate_classification <> 'malformed_json')
       OR (NOT terminal AND candidate_classification = 'malformed_json') THEN
        RAISE EXCEPTION 'invalid webhook receipt';
    END IF;

    INSERT INTO public.ao_scm_webhook_deliveries AS deliveries (
        provider, delivery_id, event, body, classification, processing_state,
        attempts, next_attempt_at, lease_id, lease_expires_at, last_error,
        received_at, updated_at
    ) VALUES (
        candidate_provider, btrim(candidate_delivery_id), btrim(candidate_event),
        candidate_body, candidate_classification,
        CASE WHEN terminal THEN 'dead_letter' ELSE 'processing' END,
        CASE WHEN terminal THEN 0 ELSE 1 END,
        CASE WHEN terminal THEN observed_at ELSE observed_at + interval '5 minutes' END,
        CASE WHEN terminal THEN NULL ELSE gen_random_uuid() END,
        CASE WHEN terminal THEN NULL ELSE observed_at + interval '5 minutes' END,
        CASE WHEN terminal THEN left(btrim(candidate_terminal_error), 128) ELSE '' END,
        observed_at, observed_at
    )
    ON CONFLICT ON CONSTRAINT ao_scm_webhook_deliveries_pkey DO NOTHING
    RETURNING deliveries.* INTO delivery;
    inserted := FOUND;

    IF NOT inserted THEN
        -- A worker that crashed on its final lease is bounded and terminal.
        UPDATE public.ao_scm_webhook_deliveries AS exhausted
        SET processing_state = 'dead_letter',
            lease_id = NULL,
            lease_expires_at = NULL,
            next_attempt_at = observed_at,
            last_error = 'attempts_exhausted',
            updated_at = observed_at
        WHERE exhausted.provider = candidate_provider
          AND exhausted.delivery_id = btrim(candidate_delivery_id)
          AND exhausted.processing_state = 'processing'
          AND exhausted.lease_expires_at <= observed_at
          AND exhausted.attempts >= 16;

        UPDATE public.ao_scm_webhook_deliveries AS recoverable
        SET processing_state = 'processing',
            attempts = recoverable.attempts + 1,
            lease_id = gen_random_uuid(),
            lease_expires_at = observed_at + interval '5 minutes',
            next_attempt_at = observed_at + interval '5 minutes',
            updated_at = observed_at
        WHERE recoverable.provider = candidate_provider
          AND recoverable.delivery_id = btrim(candidate_delivery_id)
          AND recoverable.attempts < 16
          AND (
              (recoverable.processing_state IN ('pending', 'retry') AND recoverable.next_attempt_at <= observed_at)
              OR (recoverable.processing_state = 'processing' AND recoverable.lease_expires_at <= observed_at)
          )
        RETURNING recoverable.* INTO delivery;
        reclaimed := FOUND;

        IF NOT reclaimed THEN
            SELECT existing.* INTO delivery
            FROM public.ao_scm_webhook_deliveries AS existing
            WHERE existing.provider = candidate_provider
              AND existing.delivery_id = btrim(candidate_delivery_id);
        END IF;
    END IF;

    RETURN QUERY SELECT
        delivery.provider, delivery.delivery_id, delivery.event, delivery.body,
        delivery.classification, delivery.processing_state, delivery.lease_id,
        delivery.attempts, inserted,
        delivery.processing_state = 'processing' AND (inserted OR reclaimed),
        delivery.received_at, delivery.next_attempt_at, delivery.lease_expires_at;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_scm_claim_due_webhooks(candidate_provider TEXT, candidate_limit INTEGER)
RETURNS TABLE (
    provider TEXT,
    delivery_id TEXT,
    event TEXT,
    body BYTEA,
    classification TEXT,
    processing_state TEXT,
    lease_id UUID,
    attempts INTEGER,
    first_receipt BOOLEAN,
    claimed BOOLEAN,
    received_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    observed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    UPDATE public.ao_scm_webhook_deliveries AS exhausted
    SET processing_state = 'dead_letter', lease_id = NULL, lease_expires_at = NULL,
        next_attempt_at = observed_at, last_error = 'attempts_exhausted', updated_at = observed_at
    WHERE exhausted.provider = candidate_provider
      AND exhausted.processing_state = 'processing'
      AND exhausted.lease_expires_at <= observed_at
      AND exhausted.attempts >= 16;

    RETURN QUERY
    WITH candidates AS (
        SELECT pending.provider, pending.delivery_id
        FROM public.ao_scm_webhook_deliveries AS pending
        WHERE pending.provider = candidate_provider
          AND pending.attempts < 16
          AND (
              (pending.processing_state IN ('pending', 'retry') AND pending.next_attempt_at <= observed_at)
              OR (pending.processing_state = 'processing' AND pending.lease_expires_at <= observed_at)
          )
        ORDER BY pending.next_attempt_at, pending.delivery_id
        FOR UPDATE SKIP LOCKED
        LIMIT greatest(0, least(candidate_limit, 100))
    )
    UPDATE public.ao_scm_webhook_deliveries AS claimed_delivery
    SET processing_state = 'processing',
        attempts = claimed_delivery.attempts + 1,
        lease_id = gen_random_uuid(),
        lease_expires_at = observed_at + interval '5 minutes',
        next_attempt_at = observed_at + interval '5 minutes',
        updated_at = observed_at
    FROM candidates
    WHERE claimed_delivery.provider = candidates.provider
      AND claimed_delivery.delivery_id = candidates.delivery_id
    RETURNING claimed_delivery.provider, claimed_delivery.delivery_id,
        claimed_delivery.event, claimed_delivery.body, claimed_delivery.classification,
        claimed_delivery.processing_state, claimed_delivery.lease_id,
        claimed_delivery.attempts, FALSE, TRUE, claimed_delivery.received_at,
        claimed_delivery.next_attempt_at, claimed_delivery.lease_expires_at;
END
$$;
-- +goose StatementEnd

-- Completion is idempotent. Every other transition requires the current lease
-- and therefore cannot regress a complete/dead-letter delivery or let a stale
-- worker finish a recovered attempt.
-- +goose StatementBegin
CREATE FUNCTION ao_scm_finish_webhook(
    candidate_provider TEXT,
    candidate_delivery_id TEXT,
    candidate_lease_id UUID,
    candidate_outcome TEXT,
    candidate_error TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected INTEGER;
    observed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF candidate_outcome NOT IN ('complete', 'retry') THEN
        RAISE EXCEPTION 'invalid webhook outcome';
    END IF;

    UPDATE public.ao_scm_webhook_deliveries AS delivery
    SET processing_state = CASE
            WHEN candidate_outcome = 'complete' THEN 'complete'
            WHEN delivery.attempts >= 16 THEN 'dead_letter'
            ELSE 'retry'
        END,
        lease_id = NULL,
        lease_expires_at = NULL,
        next_attempt_at = CASE
            WHEN candidate_outcome = 'retry' AND delivery.attempts < 16 THEN
                observed_at + make_interval(secs => least(
                    3600,
                    power(2::NUMERIC, least(greatest(delivery.attempts - 1, 0), 12))::INTEGER
                ))
            ELSE observed_at
        END,
        last_error = CASE
            WHEN candidate_outcome = 'complete' THEN ''
            WHEN delivery.attempts >= 16 THEN 'attempts_exhausted'
            ELSE left(btrim(coalesce(candidate_error, 'processing_failed')), 128)
        END,
        updated_at = observed_at
    WHERE delivery.provider = candidate_provider
      AND delivery.delivery_id = btrim(candidate_delivery_id)
      AND delivery.processing_state = 'processing'
      AND delivery.lease_id = candidate_lease_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected > 0 THEN
        RETURN TRUE;
    END IF;
    IF candidate_outcome = 'complete' THEN
        RETURN EXISTS (
            SELECT 1 FROM public.ao_scm_webhook_deliveries AS completed
            WHERE completed.provider = candidate_provider
              AND completed.delivery_id = btrim(candidate_delivery_id)
              AND completed.processing_state = 'complete'
        );
    END IF;
    RETURN FALSE;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ao_scm_prune_webhooks(candidate_retention INTERVAL)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    removed BIGINT;
BEGIN
    IF candidate_retention <= interval '0 seconds' THEN
        RAISE EXCEPTION 'retention must be positive';
    END IF;
    DELETE FROM public.ao_scm_webhook_deliveries AS delivery
    WHERE delivery.processing_state IN ('complete', 'dead_letter')
      AND delivery.updated_at < clock_timestamp() - candidate_retention;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION ao_scm_ingest_and_claim_webhook(TEXT, TEXT, TEXT, BYTEA, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_claim_due_webhooks(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_finish_webhook(TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_scm_prune_webhooks(INTERVAL) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO ao_cloud_scm;
ALTER FUNCTION ao_scm_ingest_and_claim_webhook(TEXT, TEXT, TEXT, BYTEA, TEXT, TEXT) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_claim_due_webhooks(TEXT, INTEGER) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_finish_webhook(TEXT, TEXT, UUID, TEXT, TEXT) OWNER TO ao_cloud_scm;
ALTER FUNCTION ao_scm_prune_webhooks(INTERVAL) OWNER TO ao_cloud_scm;
REVOKE CREATE ON SCHEMA public FROM ao_cloud_scm;

-- +goose Down
DROP FUNCTION IF EXISTS ao_scm_prune_webhooks(INTERVAL);
DROP FUNCTION IF EXISTS ao_scm_finish_webhook(TEXT, TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS ao_scm_claim_due_webhooks(TEXT, INTEGER);
DROP FUNCTION IF EXISTS ao_scm_ingest_and_claim_webhook(TEXT, TEXT, TEXT, BYTEA, TEXT, TEXT);
DROP POLICY IF EXISTS ao_scm_webhook_deliveries_definer ON ao_scm_webhook_deliveries;
DROP TABLE IF EXISTS ao_scm_webhook_deliveries;
