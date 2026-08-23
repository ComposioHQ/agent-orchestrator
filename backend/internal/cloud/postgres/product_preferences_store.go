package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

var (
	_ ports.SettingsStore       = (*Store)(nil)
	_ ports.AgentInventoryCache = (*Store)(nil)
)

// GetAppSettings reads the tenant preference row. A tenant with no row yet
// receives the compatibility default without turning a read into a write.
func (s *Store) GetAppSettings(ctx context.Context) (ports.AppSettings, error) {
	settings := ports.AppSettings{DefaultSessionMode: domain.DefaultSessionMode}
	err := s.withProductTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, identity tenant.Identity) error {
		err := tx.QueryRow(ctx,
			`SELECT default_session_mode, updated_at
			 FROM ao_app_settings
			 WHERE org_id = $1`,
			identity.OrgID,
		).Scan(&settings.DefaultSessionMode, &settings.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	settings.DefaultSessionMode = domain.NormalizeSessionMode(settings.DefaultSessionMode)
	return settings, err
}

// SetDefaultSessionMode upserts the selected default for this tenant.
func (s *Store) SetDefaultSessionMode(ctx context.Context, mode domain.SessionMode, now time.Time) error {
	if !mode.Valid() {
		return fmt.Errorf("invalid session mode %q", mode)
	}
	return s.withProductTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO ao_app_settings (org_id, default_session_mode, updated_at)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (org_id) DO UPDATE
			 SET default_session_mode = EXCLUDED.default_session_mode,
			     updated_at = EXCLUDED.updated_at
			 WHERE ao_app_settings.org_id = $1`,
			identity.OrgID, mode, now.UTC(),
		)
		return err
	})
}

// GetAgentInventoryCache loads the tenant's last successful advisory agent
// inventory observation.
func (s *Store) GetAgentInventoryCache(ctx context.Context) (string, time.Time, bool, error) {
	var inventory string
	var observedAt time.Time
	err := s.withProductTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, identity tenant.Identity) error {
		return tx.QueryRow(ctx,
			`SELECT inventory_json::text, observed_at
			 FROM ao_agent_inventory_cache
			 WHERE org_id = $1`,
			identity.OrgID,
		).Scan(&inventory, &observedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, fmt.Errorf("get agent inventory cache: %w", err)
	}
	return inventory, observedAt, true, nil
}

// UpsertAgentInventoryCache atomically replaces the tenant inventory snapshot.
func (s *Store) UpsertAgentInventoryCache(ctx context.Context, inventoryJSON string, observedAt time.Time) error {
	inventoryJSON = strings.TrimSpace(inventoryJSON)
	if !json.Valid([]byte(inventoryJSON)) {
		return errors.New("upsert agent inventory cache: inventory is not valid JSON")
	}
	return s.withProductTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO ao_agent_inventory_cache (org_id, inventory_json, observed_at)
			 VALUES ($1, $2::jsonb, $3)
			 ON CONFLICT (org_id) DO UPDATE
			 SET inventory_json = EXCLUDED.inventory_json,
			     observed_at = EXCLUDED.observed_at
			 WHERE ao_agent_inventory_cache.org_id = $1`,
			identity.OrgID, inventoryJSON, observedAt.UTC(),
		)
		return err
	})
}
