-- +goose Up
-- Raw provider-event identity is separate from the aggregate so INSERT ON
-- CONFLICT can make redelivery an atomic no-op before projection runs.
CREATE TABLE ao_conversation_provider_events (
    org_id UUID NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    provider_event_id TEXT NOT NULL CHECK (btrim(provider_event_id) <> ''),
    method TEXT NOT NULL DEFAULT '',
    payload_json JSONB,
    observed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, conversation_id, provider_event_id),
    FOREIGN KEY (org_id, owner_user_id, conversation_id)
        REFERENCES ao_conversations(org_id, owner_user_id, id) ON DELETE CASCADE
);
ALTER TABLE ao_conversation_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_conversation_provider_events FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_conversation_provider_events_tenant ON ao_conversation_provider_events
    FOR ALL
    USING (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND owner_user_id = ao_current_user_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );
REVOKE ALL ON TABLE ao_conversation_provider_events FROM PUBLIC;

-- +goose Down
DROP POLICY IF EXISTS ao_conversation_provider_events_tenant ON ao_conversation_provider_events;
DROP TABLE IF EXISTS ao_conversation_provider_events;
