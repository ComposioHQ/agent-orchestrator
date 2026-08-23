-- +goose Up
-- Per-organization heads serialize sequence allocation inside the product
-- write transaction. Unlike nextval(), an increment rolls back with the write,
-- and a concurrent writer cannot allocate the next value until the prior
-- writer commits or rolls back.
CREATE TABLE ao_change_heads (
    org_id UUID PRIMARY KEY REFERENCES ao_organizations(id) ON DELETE CASCADE,
    last_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ao_change_log (
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL CHECK (seq > 0),
    project_id TEXT NOT NULL CHECK (btrim(project_id) <> ''),
    session_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL CHECK (btrim(event_type) <> ''),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (org_id, seq)
);
CREATE INDEX ao_change_log_org_project_seq_idx
    ON ao_change_log(org_id, project_id, seq);

-- Durable offsets are for server-side background consumers. Browser clients
-- retain their own cursor via Last-Event-ID and replay ao_change_log directly.
CREATE TABLE ao_change_cursors (
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    consumer TEXT NOT NULL CHECK (btrim(consumer) <> '' AND length(consumer) <= 255),
    last_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, consumer)
);

ALTER TABLE ao_change_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_change_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_change_heads_tenant ON ao_change_heads
    FOR ALL
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );

ALTER TABLE ao_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_change_log FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_change_log_select ON ao_change_log
    FOR SELECT
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
CREATE POLICY ao_change_log_insert ON ao_change_log
    FOR INSERT
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );

ALTER TABLE ao_change_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_change_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_change_cursors_tenant ON ao_change_cursors
    FOR ALL
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );

-- Product-table migrations attach this function as an AFTER ROW trigger. The
-- event type and safe identity columns are trigger arguments, for example:
--
--   EXECUTE FUNCTION ao_capture_change_event(
--       'session_updated', 'project_id', 'id', 'identity'
--   )
--
-- Sequence allocation and the outbox insert happen inside the mutating SQL
-- transaction. A rollback therefore removes both, and a direct SQL write
-- cannot bypass capture by forgetting an application callback.
-- +goose StatementBegin
CREATE FUNCTION ao_capture_change_event() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    record_data JSONB;
    tenant_org_id UUID;
    event_project_id TEXT;
    event_session_id TEXT;
    event_payload JSONB;
    event_seq BIGINT;
    tenant_owner_user_id UUID;
BEGIN
    IF TG_NARGS <> 4 OR btrim(TG_ARGV[0]) = '' THEN
        RAISE EXCEPTION 'ao_capture_change_event requires event type, project column, session column, and payload mode';
    END IF;
    IF TG_OP = 'DELETE' THEN
        record_data := to_jsonb(OLD);
    ELSE
        record_data := to_jsonb(NEW);
    END IF;

    tenant_org_id := NULLIF(record_data ->> 'org_id', '')::UUID;
    IF tenant_org_id IS NULL THEN
        RAISE EXCEPTION 'ao_capture_change_event requires an org_id column on %', TG_TABLE_NAME;
    END IF;
    event_session_id := CASE
        WHEN TG_ARGV[2] = '' THEN ''
        ELSE COALESCE(record_data ->> TG_ARGV[2], '')
    END;
    tenant_owner_user_id := NULLIF(record_data ->> 'owner_user_id', '')::UUID;
    event_project_id := CASE
        WHEN TG_ARGV[1] = '' THEN tenant_org_id::TEXT
        WHEN TG_ARGV[1] = '@session' THEN NULL
        WHEN TG_ARGV[1] = '@pull_request' THEN NULL
        ELSE COALESCE(NULLIF(record_data ->> TG_ARGV[1], ''), tenant_org_id::TEXT)
    END;

    IF TG_ARGV[1] = '@session' THEN
        SELECT project_id INTO event_project_id
        FROM public.ao_sessions
        WHERE org_id = tenant_org_id
          AND owner_user_id = tenant_owner_user_id
          AND id = event_session_id;
    ELSIF TG_ARGV[1] = '@pull_request' THEN
        SELECT p.session_id, s.project_id
        INTO event_session_id, event_project_id
        FROM public.ao_pull_requests p
        JOIN public.ao_sessions s
          ON s.org_id = p.org_id
         AND s.owner_user_id = p.owner_user_id
         AND s.id = p.session_id
        WHERE p.org_id = tenant_org_id
          AND p.owner_user_id = tenant_owner_user_id
          AND p.url = record_data ->> 'pr_url';
    END IF;
    IF event_project_id IS NULL OR btrim(event_project_id) = '' THEN
        RAISE EXCEPTION 'ao_capture_change_event could not resolve project for %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;

    CASE TG_ARGV[3]
    WHEN 'identity' THEN
        event_payload := jsonb_strip_nulls(jsonb_build_object(
            'id', record_data -> 'id',
            'projectId', to_jsonb(event_project_id),
            'sessionId', to_jsonb(event_session_id),
            'name', record_data -> 'name'
        ));
    WHEN 'notification' THEN
        event_payload := jsonb_strip_nulls(jsonb_build_object(
            'ID', record_data -> 'id',
            'SessionID', record_data -> 'session_id',
            'ProjectID', record_data -> 'project_id',
            'PRURL', record_data -> 'pr_url',
            'Type', record_data -> 'type',
            'Title', record_data -> 'title',
            'Body', record_data -> 'body',
            'Status', record_data -> 'status',
            'CreatedAt', record_data -> 'created_at',
            'ResolvedAt', record_data -> 'resolved_at'
        ));
    WHEN 'session' THEN
        event_payload := jsonb_build_object(
            'id', record_data -> 'id',
            'activity', record_data -> 'activity_state',
            'isTerminated', record_data -> 'is_terminated',
            'terminateOnPrMerge', record_data -> 'terminate_on_pr_merge',
            'previewUrl', record_data -> 'preview_url',
            'previewRevision', record_data -> 'preview_revision',
            'isPinned', record_data -> 'is_pinned',
            'mode', record_data -> 'session_mode',
            'autoInjectReview', record_data -> 'auto_inject_review',
            'autoInjectCI', record_data -> 'auto_inject_ci',
            'autoReviewEnabled', record_data -> 'auto_review_enabled'
        );
    WHEN 'pull_request' THEN
        event_payload := jsonb_build_object(
            'url', record_data -> 'url',
            'session', record_data -> 'session_id',
            'state', record_data -> 'pr_state',
            'ci', record_data -> 'ci_state',
            'review', record_data -> 'review_decision',
            'mergeability', record_data -> 'mergeability'
        );
    WHEN 'pull_request_session' THEN
        event_payload := jsonb_build_object(
            'url', record_data -> 'url',
            'fromSession', to_jsonb(COALESCE(OLD.session_id, '')),
            'toSession', record_data -> 'session_id'
        );
    WHEN 'check' THEN
        event_payload := jsonb_build_object(
            'pr', record_data -> 'pr_url',
            'name', record_data -> 'name',
            'commit', record_data -> 'commit_hash',
            'status', record_data -> 'status'
        );
    WHEN 'review_thread' THEN
        event_payload := jsonb_build_object(
            'pr', record_data -> 'pr_url',
            'thread', record_data -> 'thread_id',
            'path', record_data -> 'path',
            'line', record_data -> 'line',
            'resolved', record_data -> 'resolved',
            'isBot', record_data -> 'is_bot'
        );
    WHEN 'review' THEN
        event_payload := jsonb_build_object(
            'id', record_data -> 'review_id',
            'reviewId', record_data -> 'review_id',
            'sessionId', to_jsonb(event_session_id),
            'pr', record_data -> 'pr_url',
            'targetSha', record_data -> 'target_sha',
            'status', record_data -> 'state',
            'verdict', record_data -> 'state',
            'body', record_data -> 'body',
            'githubReviewId', record_data -> 'review_id',
            'autoInjectReview', record_data -> 'auto_inject_review'
        );
    ELSE
        RAISE EXCEPTION 'unsupported ao_capture_change_event payload mode %', TG_ARGV[3];
    END CASE;

    INSERT INTO public.ao_change_heads (org_id, last_seq)
    VALUES (tenant_org_id, 0)
    ON CONFLICT (org_id) DO NOTHING;

    UPDATE public.ao_change_heads
    SET last_seq = last_seq + 1, updated_at = now()
    WHERE org_id = tenant_org_id
    RETURNING last_seq INTO event_seq;

    INSERT INTO public.ao_change_log (
        org_id, seq, project_id, session_id, event_type, payload
    ) VALUES (
        tenant_org_id, event_seq, event_project_id, event_session_id,
        TG_ARGV[0], event_payload
    );

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;
-- +goose StatementEnd

-- PostgreSQL delivers NOTIFY only after commit. The payload is a wake-up hint,
-- never the event itself; every listener catches up from ao_change_log.
-- +goose StatementBegin
CREATE FUNCTION ao_notify_change_event() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM pg_notify('ao_change_events', NEW.org_id::TEXT);
    RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER ao_change_log_notify
AFTER INSERT ON ao_change_log
FOR EACH ROW EXECUTE FUNCTION ao_notify_change_event();

REVOKE ALL ON TABLE ao_change_heads, ao_change_log, ao_change_cursors FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_capture_change_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION ao_notify_change_event() FROM PUBLIC;

-- +goose Down
DROP TRIGGER IF EXISTS ao_change_log_notify ON ao_change_log;
DROP FUNCTION IF EXISTS ao_notify_change_event();
DROP FUNCTION IF EXISTS ao_capture_change_event();
DROP POLICY IF EXISTS ao_change_cursors_tenant ON ao_change_cursors;
DROP TABLE IF EXISTS ao_change_cursors;
DROP POLICY IF EXISTS ao_change_log_insert ON ao_change_log;
DROP POLICY IF EXISTS ao_change_log_select ON ao_change_log;
DROP TABLE IF EXISTS ao_change_log;
DROP POLICY IF EXISTS ao_change_heads_tenant ON ao_change_heads;
DROP TABLE IF EXISTS ao_change_heads;
