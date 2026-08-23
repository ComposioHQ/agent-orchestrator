-- +goose Up
CREATE TABLE ao_review_runs (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (btrim(id) <> ''),
    review_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    batch_id TEXT NOT NULL DEFAULT '',
    harness TEXT NOT NULL CHECK (btrim(harness) <> ''),
    trigger_source TEXT NOT NULL DEFAULT 'manual'
        CHECK (trigger_source IN ('manual', 'auto')),
    pr_url TEXT NOT NULL DEFAULT '',
    target_sha TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'complete', 'delivered', 'failed', 'cancelled')),
    verdict TEXT NOT NULL DEFAULT ''
        CHECK (verdict IN ('', 'approved', 'changes_requested')),
    body TEXT NOT NULL DEFAULT '',
    github_review_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,
    auto_inject_review BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (org_id, owner_user_id, id),
    FOREIGN KEY (org_id, owner_user_id, review_id)
        REFERENCES ao_reviews(org_id, owner_user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, owner_user_id, session_id)
        REFERENCES ao_sessions(org_id, owner_user_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ao_review_runs_active_target_idx
    ON ao_review_runs(org_id, owner_user_id, session_id, pr_url, target_sha, harness)
    WHERE target_sha <> ''
        AND status NOT IN ('failed', 'cancelled')
        AND (status = 'running' OR verdict NOT IN ('', 'changes_requested'));
CREATE INDEX ao_review_runs_session_idx
    ON ao_review_runs(org_id, owner_user_id, session_id, created_at DESC, id DESC);
CREATE INDEX ao_review_runs_batch_idx
    ON ao_review_runs(org_id, owner_user_id, session_id, batch_id, created_at, id)
    WHERE batch_id <> '';

ALTER TABLE ao_review_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_review_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_review_runs_tenant ON ao_review_runs FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
REVOKE ALL ON TABLE ao_review_runs FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_review_runs;
