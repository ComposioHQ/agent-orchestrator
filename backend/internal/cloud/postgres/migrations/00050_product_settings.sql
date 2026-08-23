-- +goose Up
CREATE TABLE ao_app_settings (
    org_id UUID PRIMARY KEY REFERENCES ao_organizations(id) ON DELETE CASCADE,
    default_session_mode TEXT NOT NULL DEFAULT 'chat'
        CHECK (default_session_mode IN ('tui', 'chat')),
    updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE ao_app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_app_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_app_settings_tenant ON ao_app_settings
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
REVOKE ALL ON TABLE ao_app_settings FROM PUBLIC;

-- +goose Down
DROP TABLE IF EXISTS ao_app_settings;
