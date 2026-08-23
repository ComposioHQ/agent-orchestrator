package postgres

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

// TestSCMMigrationsEnforceTheCredentialBoundary asserts the load-bearing
// properties of the SCM schema at the text level, so a later edit that quietly
// drops one is caught without a database.
func TestSCMMigrationsEnforceTheCredentialBoundary(t *testing.T) {
	goose.SetBaseFS(migrationFS)
	migrations, err := goose.CollectMigrations("migrations", 0, goose.MaxVersion)
	if err != nil {
		t.Fatal(err)
	}
	versions := map[int64]bool{}
	for _, migration := range migrations {
		versions[migration.Version] = true
	}
	// Numbered above the other cloud slices so parallel work cannot collide.
	for _, version := range []int64{30, 31} {
		if !versions[version] {
			t.Fatalf("SCM migration %d is missing", version)
		}
	}

	installations, err := migrationFS.ReadFile("migrations/00030_scm_installations.sql")
	if err != nil {
		t.Fatal(err)
	}
	installationsSQL := string(installations)
	for _, required := range []string{
		"CREATE TABLE ao_scm_installations",
		"CREATE TABLE ao_scm_repositories",
		"CREATE TABLE ao_scm_install_states",
		"CREATE TABLE ao_scm_token_grants",
		// One installation may belong to exactly one organization.
		"UNIQUE (provider, external_installation_id)",
		// The allowlist is default-deny.
		"allowed BOOLEAN NOT NULL DEFAULT FALSE",
		// Only an org admin may link or allowlist.
		"ao_can_manage_org(org_id, ao_current_user_id())",
		"ALTER TABLE ao_scm_installations FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_scm_repositories FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_scm_install_states FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_scm_token_grants FORCE ROW LEVEL SECURITY",
		"REVOKE ALL ON TABLE",
	} {
		if !strings.Contains(installationsSQL, required) {
			t.Fatalf("SCM installations migration does not contain %q", required)
		}
	}
	// The audit ledger must never gain a column that could hold a credential.
	for _, forbidden := range []string{"token TEXT", "token_hash", "access_token", "private_key"} {
		if strings.Contains(installationsSQL, forbidden) {
			t.Fatalf("SCM installations migration persists credential material: %q", forbidden)
		}
	}

	webhooks, err := migrationFS.ReadFile("migrations/00031_scm_webhooks.sql")
	if err != nil {
		t.Fatal(err)
	}
	webhooksSQL := string(webhooks)
	for _, required := range []string{
		"CREATE TABLE ao_scm_webhook_deliveries",
		"PRIMARY KEY (provider, delivery_id)",
		"CREATE ROLE ao_cloud_scm NOLOGIN",
		"current_user = 'ao_cloud_scm'",
		"SECURITY DEFINER",
		"SET search_path = pg_catalog, public",
		"CREATE FUNCTION ao_scm_record_webhook_delivery",
		"CREATE FUNCTION ao_scm_prepare_webhook_delivery",
		"CREATE FUNCTION ao_scm_finish_webhook_delivery",
		"CREATE FUNCTION ao_scm_claim_webhook_retries",
		"CREATE FUNCTION ao_scm_consume_install_state",
		"ALTER FUNCTION ao_scm_record_webhook_delivery(TEXT, TEXT, TEXT) OWNER TO ao_cloud_scm",
		"processing_state TEXT NOT NULL DEFAULT 'received'",
		"CHECK (processing_state IN ('received', 'processing', 'retry', 'complete'))",
		"attempts INTEGER NOT NULL DEFAULT 0",
		"next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()",
		"last_error TEXT NOT NULL DEFAULT ''",
		"REVOKE ALL ON FUNCTION ao_scm_consume_install_state(BYTEA) FROM PUBLIC",
		"ALTER TABLE ao_scm_webhook_deliveries FORCE ROW LEVEL SECURITY",
		"forced row-level security",
	} {
		if !strings.Contains(webhooksSQL, required) {
			t.Fatalf("SCM webhook migration does not contain %q", required)
		}
	}
	// The webhook upsert must hard-code a denied repository. If this ever
	// becomes a parameter, a forged-but-signed delivery could widen access.
	upsert := webhooksSQL[strings.Index(webhooksSQL, "CREATE FUNCTION ao_scm_webhook_upsert_repository"):]
	upsert = upsert[:strings.Index(upsert, "-- +goose StatementEnd")]
	if !strings.Contains(upsert, "FALSE\n    )") {
		t.Fatal("the webhook repository upsert no longer hard-codes allowed = FALSE")
	}
	if strings.Contains(upsert, "allowed = EXCLUDED.allowed") || strings.Contains(upsert, "candidate_allowed") {
		t.Fatal("the webhook repository upsert can now set the allowlist flag")
	}
}
