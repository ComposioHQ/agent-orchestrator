-- +goose Up
CREATE TABLE ao_reviews (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (btrim(id) <> ''),
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    harness TEXT NOT NULL CHECK (btrim(harness) <> ''),
    pr_url TEXT NOT NULL DEFAULT '',
    reviewer_handle_id TEXT NOT NULL DEFAULT '',
    agent_session_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, id),
    UNIQUE (org_id, owner_user_id, session_id, harness),
    FOREIGN KEY (org_id, owner_user_id, session_id)
        REFERENCES ao_sessions(org_id, owner_user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, owner_user_id, project_id)
        REFERENCES ao_projects(org_id, owner_user_id, id) ON DELETE CASCADE
);
CREATE INDEX ao_reviews_session_idx
    ON ao_reviews(org_id, owner_user_id, session_id, updated_at DESC, created_at DESC, id DESC);

ALTER TABLE ao_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_reviews_tenant ON ao_reviews FOR ALL
    USING (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()))
    WITH CHECK (org_id = ao_current_org_id() AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id()));
REVOKE ALL ON TABLE ao_reviews FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_reviews;
