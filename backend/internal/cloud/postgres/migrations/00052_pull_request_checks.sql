-- +goose Up
CREATE TABLE ao_pull_request_checks (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL,
    pr_url TEXT NOT NULL,
    name TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown', 'queued', 'in_progress', 'passed', 'failed', 'skipped', 'cancelled')),
    conclusion TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    log_tail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, pr_url, name, commit_hash),
    FOREIGN KEY (org_id, owner_user_id, pr_url)
        REFERENCES ao_pull_requests(org_id, owner_user_id, url) ON DELETE CASCADE
);
CREATE INDEX ao_pull_request_checks_lookup_idx
    ON ao_pull_request_checks(org_id, owner_user_id, pr_url, name, created_at);
ALTER TABLE ao_pull_request_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pull_request_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_pull_request_checks_tenant ON ao_pull_request_checks FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
REVOKE ALL ON TABLE ao_pull_request_checks FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_pull_request_checks;
