-- +goose Up
CREATE TABLE ao_pull_request_reviews (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL,
    pr_url TEXT NOT NULL,
    review_id TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'none'
        CHECK (state IN ('none', 'approved', 'changes_requested', 'review_required')),
    url TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    is_bot BOOLEAN NOT NULL DEFAULT FALSE,
    target_sha TEXT NOT NULL DEFAULT '',
    submitted_at TIMESTAMPTZ NOT NULL,
    auto_inject_review BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (org_id, owner_user_id, pr_url, review_id),
    FOREIGN KEY (org_id, owner_user_id, pr_url)
        REFERENCES ao_pull_requests(org_id, owner_user_id, url) ON DELETE CASCADE
);
CREATE INDEX ao_pull_request_reviews_lookup_idx
    ON ao_pull_request_reviews(org_id, owner_user_id, pr_url, submitted_at, review_id);
ALTER TABLE ao_pull_request_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pull_request_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_pull_request_reviews_tenant ON ao_pull_request_reviews FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
REVOKE ALL ON TABLE ao_pull_request_reviews FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_pull_request_reviews;
