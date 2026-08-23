-- +goose Up
CREATE TABLE ao_pull_request_review_threads (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL,
    pr_url TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    line BIGINT NOT NULL DEFAULT 0,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    is_bot BOOLEAN NOT NULL DEFAULT FALSE,
    semantic_hash TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, pr_url, thread_id),
    FOREIGN KEY (org_id, owner_user_id, pr_url)
        REFERENCES ao_pull_requests(org_id, owner_user_id, url) ON DELETE CASCADE
);
CREATE INDEX ao_pull_request_review_threads_lookup_idx
    ON ao_pull_request_review_threads(org_id, owner_user_id, pr_url, updated_at, thread_id);
ALTER TABLE ao_pull_request_review_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pull_request_review_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_pull_request_review_threads_tenant ON ao_pull_request_review_threads FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
REVOKE ALL ON TABLE ao_pull_request_review_threads FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_pull_request_review_threads;
