package postgres

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestCloudMigrationsAreTenantScoped(t *testing.T) {
	goose.SetBaseFS(migrationFS)
	migrations, err := goose.CollectMigrations("migrations", 0, goose.MaxVersion)
	if err != nil {
		t.Fatal(err)
	}
	wantVersions := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 20, 30, 31, 32}
	if len(migrations) != len(wantVersions) {
		t.Fatalf("migrations = %#v", migrations)
	}
	for index, want := range wantVersions {
		if migrations[index].Version != want {
			t.Fatalf("migration %d version = %d, want %d", index, migrations[index].Version, want)
		}
	}
	migration, err := migrationFS.ReadFile("migrations/00001_auth_foundation.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(migration)
	for _, required := range []string{
		"CREATE TABLE ao_users",
		"CREATE TABLE ao_auth_sessions",
		"CREATE TABLE ao_organizations",
		"CREATE TABLE ao_org_memberships",
		"ALTER TABLE ao_organizations FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_org_memberships FORCE ROW LEVEL SECURITY",
		"SECURITY DEFINER",
		"REVOKE ALL ON TABLE",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration does not contain %q", required)
		}
	}
	for _, deferred := range []string{
		"ao_projects",
		"ao_sessions",
		"ao_sandboxes",
		"ao_events",
		"ao_github",
	} {
		if strings.Contains(sql, deferred) {
			t.Fatalf("foundation unexpectedly contains deferred table %q", deferred)
		}
	}
	workspaceMigration, err := migrationFS.ReadFile("migrations/00002_cloud_workspaces.sql")
	if err != nil {
		t.Fatal(err)
	}
	workspaceSQL := string(workspaceMigration)
	for _, required := range []string{
		"CREATE TABLE ao_cloud_workspaces",
		"ALTER TABLE ao_cloud_workspaces FORCE ROW LEVEL SECURITY",
		"ao_cloud_workspaces_insert",
	} {
		if !strings.Contains(workspaceSQL, required) {
			t.Fatalf("workspace migration does not contain %q", required)
		}
	}
	runtimeMigration, err := migrationFS.ReadFile("migrations/00003_session_runtimes.sql")
	if err != nil {
		t.Fatal(err)
	}
	runtimeSQL := string(runtimeMigration)
	for _, required := range []string{"CREATE TABLE ao_cloud_session_runtimes", "UNIQUE (workspace_id, session_id)", "ALTER TABLE ao_cloud_session_runtimes FORCE ROW LEVEL SECURITY"} {
		if !strings.Contains(runtimeSQL, required) {
			t.Fatalf("runtime migration does not contain %q", required)
		}
	}
	generationMigration, err := migrationFS.ReadFile("migrations/00004_session_runtime_generation.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(generationMigration), "ADD COLUMN generation BIGINT NOT NULL DEFAULT 1") {
		t.Fatal("runtime generation migration does not add the concurrency guard")
	}
	installationMigration, err := migrationFS.ReadFile("migrations/00030_scm_installations.sql")
	if err != nil {
		t.Fatal(err)
	}
	installationSQL := string(installationMigration)
	for _, required := range []string{
		"CREATE TABLE ao_scm_installations",
		"CREATE TABLE ao_scm_repositories",
		"CREATE TABLE ao_scm_install_states",
		"CREATE TABLE ao_scm_token_grants",
		"allowed BOOLEAN NOT NULL DEFAULT FALSE",
		"UNIQUE (provider, external_installation_id)",
		"ALTER TABLE ao_scm_token_grants FORCE ROW LEVEL SECURITY",
		"CREATE FUNCTION ao_scm_upsert_installation",
		"CREATE FUNCTION ao_scm_claim_install_state",
		"CREATE FUNCTION ao_scm_get_install_claim",
		"CREATE FUNCTION ao_scm_release_install_claim",
		"CREATE FUNCTION ao_scm_finalize_install_state",
	} {
		if !strings.Contains(installationSQL, required) {
			t.Fatalf("SCM installation migration does not contain %q", required)
		}
	}
	webhookMigration, err := migrationFS.ReadFile("migrations/00031_scm_webhooks.sql")
	if err != nil {
		t.Fatal(err)
	}
	webhookSQL := string(webhookMigration)
	for _, required := range []string{
		"CREATE TABLE ao_scm_webhook_deliveries",
		"ALTER TABLE ao_scm_webhook_deliveries FORCE ROW LEVEL SECURITY",
		"CREATE FUNCTION ao_scm_ingest_and_claim_webhook",
		"processing_state IN ('complete', 'dead_letter')",
		"FOR UPDATE SKIP LOCKED",
	} {
		if !strings.Contains(webhookSQL, required) {
			t.Fatalf("SCM webhook migration does not contain %q", required)
		}
	}
	observationMigration, err := migrationFS.ReadFile("migrations/00032_scm_observations.sql")
	if err != nil {
		t.Fatal(err)
	}
	observationSQL := string(observationMigration)
	for _, required := range []string{
		"CREATE TABLE ao_scm_observations",
		"PRIMARY KEY (provider, delivery_id)",
		"ALTER TABLE ao_scm_observations FORCE ROW LEVEL SECURITY",
		"CREATE FUNCTION ao_scm_record_observation",
		"ON CONFLICT (provider, delivery_id) DO NOTHING",
	} {
		if !strings.Contains(observationSQL, required) {
			t.Fatalf("SCM observation migration does not contain %q", required)
		}
	}
	for name, migrationSQL := range map[string]string{
		"00030": installationSQL,
		"00031": webhookSQL,
		"00032": observationSQL,
	} {
		grant := "GRANT CREATE ON SCHEMA public TO ao_cloud_scm"
		revoke := "REVOKE CREATE ON SCHEMA public FROM ao_cloud_scm"
		if strings.Count(migrationSQL, grant) != 1 || strings.Count(migrationSQL, revoke) != 1 ||
			strings.Index(migrationSQL, grant) >= strings.Index(migrationSQL, revoke) {
			t.Fatalf("SCM migration %s does not scope schema CREATE to one ownership transfer", name)
		}
		if strings.Contains(migrationSQL, "GRANT USAGE, CREATE ON SCHEMA public TO ao_cloud_scm") {
			t.Fatalf("SCM migration %s combines durable schema usage with temporary CREATE", name)
		}
	}
	authRLSMigration, err := migrationFS.ReadFile("migrations/00005_auth_rls.sql")
	if err != nil {
		t.Fatal(err)
	}
	authRLSSQL := string(authRLSMigration)
	for _, required := range []string{
		"ALTER TABLE ao_users FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_auth_sessions FORCE ROW LEVEL SECURITY",
		"CREATE FUNCTION ao_upsert_google_user",
		"CREATE FUNCTION ao_rotate_refresh_session",
		"SECURITY DEFINER",
		"owner_user_id = ao_current_user_id()",
		"ao_cloud_workspaces_owner_created_idx",
	} {
		if !strings.Contains(authRLSSQL, required) {
			t.Fatalf("auth RLS migration does not contain %q", required)
		}
	}
	authDefinerMigration, err := migrationFS.ReadFile("migrations/00006_auth_definer_role.sql")
	if err != nil {
		t.Fatal(err)
	}
	authDefinerSQL := string(authDefinerMigration)
	for _, required := range []string{
		"CREATE ROLE ao_cloud_auth NOLOGIN",
		"ALTER FUNCTION ao_upsert_google_user(TEXT, TEXT, TEXT) OWNER TO ao_cloud_auth",
		"GRANT SELECT, INSERT, UPDATE, DELETE",
		"current_user = 'ao_cloud_auth'",
		"DROP POLICY ao_org_memberships_insert",
	} {
		if !strings.Contains(authDefinerSQL, required) {
			t.Fatalf("auth definer migration does not contain %q", required)
		}
	}
	authRepairMigration, err := migrationFS.ReadFile("migrations/00007_auth_definer_policy.sql")
	if err != nil {
		t.Fatal(err)
	}
	authRepairSQL := string(authRepairMigration)
	for _, required := range []string{"ALTER ROLE ao_cloud_auth NOBYPASSRLS", "WITH SET TRUE", "ao_auth_sessions_auth_definer"} {
		if !strings.Contains(authRepairSQL, required) {
			t.Fatalf("auth repair migration does not contain %q", required)
		}
	}
	workspaceScopeMigration, err := migrationFS.ReadFile("migrations/00008_workspace_runtime_scope.sql")
	if err != nil {
		t.Fatal(err)
	}
	workspaceScopeSQL := string(workspaceScopeMigration)
	for _, required := range []string{"ao_current_workspace_id", "workspace_id = ao_current_workspace_id()", "workspace.owner_user_id = ao_current_user_id()"} {
		if !strings.Contains(workspaceScopeSQL, required) {
			t.Fatalf("workspace runtime scope migration does not contain %q", required)
		}
	}
	coreMigration, err := migrationFS.ReadFile("migrations/00009_control_plane_core.sql")
	if err != nil {
		t.Fatal(err)
	}
	coreSQL := string(coreMigration)
	for _, required := range []string{
		"CREATE TABLE ao_projects",
		"CREATE TABLE ao_sessions",
		"CREATE TABLE ao_session_worktrees",
		"ALTER TABLE ao_projects FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_sessions FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_session_worktrees FORCE ROW LEVEL SECURITY",
		"REVOKE ALL ON TABLE ao_projects, ao_sessions, ao_session_worktrees FROM PUBLIC",
	} {
		if !strings.Contains(coreSQL, required) {
			t.Fatalf("core migration does not contain %q", required)
		}
	}
	if got := strings.Count(coreSQL, "CREATE TABLE "); got != 3 {
		t.Fatalf("core migration creates %d tables, want exactly 3", got)
	}

}
