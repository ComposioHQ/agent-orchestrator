-- +goose Up
CREATE TABLE ao_pull_request_comments (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL,
    pr_url TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    file TEXT NOT NULL DEFAULT '',
    line BIGINT NOT NULL DEFAULT 0,
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    is_bot BOOLEAN NOT NULL DEFAULT FALSE,
    auto_inject_review BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, pr_url, comment_id),
    FOREIGN KEY (org_id, owner_user_id, pr_url)
        REFERENCES ao_pull_requests(org_id, owner_user_id, url) ON DELETE CASCADE
);
CREATE INDEX ao_pull_request_comments_lookup_idx
    ON ao_pull_request_comments(org_id, owner_user_id, pr_url, created_at, comment_id);
ALTER TABLE ao_pull_request_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pull_request_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_pull_request_comments_tenant ON ao_pull_request_comments FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
REVOKE ALL ON TABLE ao_pull_request_comments FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_pull_request_comments;
