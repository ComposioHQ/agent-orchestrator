-- +goose Up
CREATE TABLE ao_agent_inventory_cache (
    org_id UUID PRIMARY KEY REFERENCES ao_organizations(id) ON DELETE CASCADE,
    inventory_json JSONB NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE ao_agent_inventory_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_agent_inventory_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_agent_inventory_cache_tenant ON ao_agent_inventory_cache
    USING (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    )
    WITH CHECK (
        org_id = ao_current_org_id()
        AND ao_is_org_member(org_id, ao_current_user_id())
    );

-- +goose Down
DROP TABLE IF EXISTS ao_agent_inventory_cache;
