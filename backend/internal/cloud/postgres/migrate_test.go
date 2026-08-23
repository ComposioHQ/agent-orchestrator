package postgres

import (
	"regexp"
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
	// Versions must be contiguous from 1. A gap means a migration was deleted
	// after being applied somewhere, which goose cannot reconcile.
	if len(migrations) != 9 {
		t.Fatalf("collected %d migrations, want 9", len(migrations))
	}
	for i, migration := range migrations {
		if migration.Version != int64(i+1) {
			t.Fatalf("migration %d has version %d, want %d", i, migration.Version, i+1)
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
	controlPlaneMigration, err := migrationFS.ReadFile("migrations/00009_control_plane_state.sql")
	if err != nil {
		t.Fatal(err)
	}
	controlPlaneSQL := string(controlPlaneMigration)
	for _, required := range []string{
		"CREATE TABLE ao_projects",
		"CREATE TABLE ao_workspace_repos",
		"CREATE TABLE ao_sessions",
		"CREATE TABLE ao_session_worktrees",
		// Every AO identifier is scoped by org: two tenants may both call a
		// project "acme", so a single-column key would merge them.
		"PRIMARY KEY (org_id, id)",
		"PRIMARY KEY (org_id, project_id, name)",
		"PRIMARY KEY (org_id, session_id, repo_name)",
		"UNIQUE (org_id, project_id, num)",
		"ALTER TABLE ao_projects FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_workspace_repos FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_sessions FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_session_worktrees FORCE ROW LEVEL SECURITY",
		"REVOKE ALL ON TABLE ao_projects",
	} {
		if !strings.Contains(controlPlaneSQL, required) {
			t.Fatalf("control plane migration does not contain %q", required)
		}
	}
	// Session status is derived from durable facts at read time. A bare
	// "status" column would let a write path persist a second, divergent
	// answer. git_status and activity_state are facts, not derived status.
	if regexp.MustCompile(`(?m)^\s+status\s`).MatchString(controlPlaneSQL) {
		t.Fatal("control plane migration persists a derived session status")
	}
}

// TestTenantTablesCoverEveryTenantTable keeps the Go-side list that drives the
// runtime GRANT and the row-level-security check in step with the migrations. A
// table missing from the list is not a loud failure at runtime — it is a table
// the runtime role cannot read, or one whose RLS nobody verified.
func TestTenantTablesCoverEveryTenantTable(t *testing.T) {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	declared := map[string]bool{}
	for _, table := range tenantTables {
		declared[table] = true
	}
	created := regexp.MustCompile(`(?m)^CREATE TABLE (ao_\w+)`)
	for _, entry := range entries {
		body, err := migrationFS.ReadFile("migrations/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		up, _, _ := strings.Cut(string(body), "-- +goose Down")
		for _, match := range created.FindAllStringSubmatch(up, -1) {
			if !declared[match[1]] {
				t.Fatalf("%s creates table %q, which is missing from tenantTables", entry.Name(), match[1])
			}
		}
	}
}
