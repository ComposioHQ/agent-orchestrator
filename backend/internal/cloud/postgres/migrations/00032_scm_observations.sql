-- +goose Up
-- Durable downstream observation hints. delivery_id is the idempotency key:
-- replay after sink success but before webhook completion cannot duplicate a
-- downstream write.

CREATE TABLE ao_scm_observations (
    provider TEXT NOT NULL CHECK (provider = 'github'),
    delivery_id TEXT NOT NULL CHECK (btrim(delivery_id) <> '' AND length(delivery_id) <= 255),
    external_installation_id BIGINT NOT NULL CHECK (external_installation_id > 0),
    repository TEXT NOT NULL CHECK (
        repository = lower(repository)
        AND length(repository) <= 255
        AND repository ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'
    ),
    event TEXT NOT NULL CHECK (btrim(event) <> '' AND length(event) <= 128),
    action TEXT NOT NULL CHECK (length(action) <= 128),
    pull_request_number INTEGER NOT NULL DEFAULT 0 CHECK (pull_request_number >= 0),
    pull_request_url TEXT NOT NULL DEFAULT '' CHECK (length(pull_request_url) <= 2048),
    head_sha TEXT NOT NULL DEFAULT '' CHECK (length(head_sha) <= 128),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider, delivery_id)
);
CREATE INDEX ao_scm_observations_pending_idx ON ao_scm_observations(observed_at, delivery_id);

ALTER TABLE ao_scm_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_scm_observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ao_scm_observations FROM PUBLIC;
GRANT SELECT, INSERT ON ao_scm_observations TO ao_cloud_scm;
CREATE POLICY ao_scm_observations_definer ON ao_scm_observations
    FOR ALL USING (current_user = 'ao_cloud_scm')
    WITH CHECK (current_user = 'ao_cloud_scm');

-- PostgreSQL requires the prospective function owner to have CREATE on the
-- containing schema. Grant it only for the ownership transfer below.
GRANT CREATE ON SCHEMA public TO ao_cloud_scm;

-- +goose StatementBegin
CREATE FUNCTION ao_scm_record_observation(
    candidate_delivery_id TEXT,
    candidate_installation_id BIGINT,
    candidate_repository TEXT,
    candidate_event TEXT,
    candidate_action TEXT,
    candidate_pull_request_number INTEGER,
    candidate_pull_request_url TEXT,
    candidate_head_sha TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO public.ao_scm_observations (
        provider, delivery_id, external_installation_id, repository, event,
        action, pull_request_number, pull_request_url, head_sha
    ) VALUES (
        'github', candidate_delivery_id, candidate_installation_id,
        candidate_repository, candidate_event, candidate_action,
        candidate_pull_request_number, candidate_pull_request_url,
        candidate_head_sha
    ) ON CONFLICT (provider, delivery_id) DO NOTHING;
    RETURN FOUND;
END
$$;
-- +goose StatementEnd
ALTER FUNCTION ao_scm_record_observation(TEXT, BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) OWNER TO ao_cloud_scm;
REVOKE CREATE ON SCHEMA public FROM ao_cloud_scm;
REVOKE ALL ON FUNCTION ao_scm_record_observation(TEXT, BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;

-- +goose Down
DROP FUNCTION IF EXISTS ao_scm_record_observation(TEXT, BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT);
DROP POLICY IF EXISTS ao_scm_observations_definer ON ao_scm_observations;
DROP TABLE IF EXISTS ao_scm_observations;
