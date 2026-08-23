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
REVOKE ALL ON FUNCTION ao_notify_change_event() FROM PUBLIC;

-- +goose Down
DROP TRIGGER IF EXISTS ao_change_log_notify ON ao_change_log;
DROP FUNCTION IF EXISTS ao_notify_change_event();
DROP POLICY IF EXISTS ao_change_cursors_tenant ON ao_change_cursors;
DROP TABLE IF EXISTS ao_change_cursors;
DROP POLICY IF EXISTS ao_change_log_insert ON ao_change_log;
DROP POLICY IF EXISTS ao_change_log_select ON ao_change_log;
DROP TABLE IF EXISTS ao_change_log;
DROP POLICY IF EXISTS ao_change_heads_tenant ON ao_change_heads;
DROP TABLE IF EXISTS ao_change_heads;
