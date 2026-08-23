-- +goose Up
CREATE TABLE ao_pull_requests (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    url TEXT NOT NULL CHECK (btrim(url) <> ''),
    session_id TEXT NOT NULL,
    number BIGINT NOT NULL DEFAULT 0,
    pr_state TEXT NOT NULL DEFAULT 'open'
        CHECK (pr_state IN ('draft', 'open', 'merged', 'closed')),
    review_decision TEXT NOT NULL DEFAULT 'none'
        CHECK (review_decision IN ('none', 'approved', 'changes_requested', 'review_required')),
    ci_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (ci_state IN ('unknown', 'pending', 'passing', 'failing')),
    mergeability TEXT NOT NULL DEFAULT 'unknown'
        CHECK (mergeability IN ('unknown', 'mergeable', 'conflicting', 'blocked', 'unstable')),
    updated_at TIMESTAMPTZ NOT NULL,
    state_changed_at TIMESTAMPTZ,
    provider TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT '',
    repo TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    source_branch TEXT NOT NULL DEFAULT '',
    target_branch TEXT NOT NULL DEFAULT '',
    head_sha TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    additions BIGINT NOT NULL DEFAULT 0,
    deletions BIGINT NOT NULL DEFAULT 0,
    changed_files BIGINT NOT NULL DEFAULT 0,
    author TEXT NOT NULL DEFAULT '',
    base_sha TEXT NOT NULL DEFAULT '',
    merge_commit_sha TEXT NOT NULL DEFAULT '',
    provider_state TEXT NOT NULL DEFAULT '',
    provider_mergeable TEXT NOT NULL DEFAULT '',
    provider_merge_state_status TEXT NOT NULL DEFAULT '',
    html_url TEXT NOT NULL DEFAULT '',
    created_at_provider TIMESTAMPTZ,
    updated_at_provider TIMESTAMPTZ,
    merged_at_provider TIMESTAMPTZ,
    closed_at_provider TIMESTAMPTZ,
    metadata_hash TEXT NOT NULL DEFAULT '',
    ci_hash TEXT NOT NULL DEFAULT '',
    review_hash TEXT NOT NULL DEFAULT '',
    observed_at TIMESTAMPTZ,
    ci_observed_at TIMESTAMPTZ,
    review_observed_at TIMESTAMPTZ,
    last_nudge_signature TEXT NOT NULL DEFAULT '',
    auto_inject_ci BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (org_id, owner_user_id, url),
    FOREIGN KEY (org_id, owner_user_id, session_id)
        REFERENCES ao_sessions(org_id, owner_user_id, id) ON DELETE CASCADE
);
CREATE INDEX ao_pull_requests_session_idx
    ON ao_pull_requests(org_id, owner_user_id, session_id, updated_at DESC, url);
CREATE UNIQUE INDEX ao_pull_requests_provider_identity_idx
    ON ao_pull_requests(org_id, owner_user_id, provider, host, provider_id)
    WHERE provider_id <> '';

CREATE TABLE ao_pull_request_url_aliases (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL,
    alias_url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, alias_url),
    FOREIGN KEY (org_id, owner_user_id, canonical_url)
        REFERENCES ao_pull_requests(org_id, owner_user_id, url) ON DELETE CASCADE
);

ALTER TABLE ao_pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pull_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_pull_requests_tenant ON ao_pull_requests FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
ALTER TABLE ao_pull_request_url_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pull_request_url_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_pull_request_url_aliases_tenant ON ao_pull_request_url_aliases FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
REVOKE ALL ON TABLE ao_pull_requests, ao_pull_request_url_aliases FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_pull_request_url_aliases;
DROP TABLE IF EXISTS ao_pull_requests;
