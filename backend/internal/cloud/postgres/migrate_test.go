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
	wantVersions := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 50, 51, 52, 53, 54, 55, 56, 59, 60}
	if len(migrations) != len(wantVersions) {
		t.Fatalf("migrations = %#v", migrations)
	}
	for i, want := range wantVersions {
		if migrations[i].Version != want {
			t.Fatalf("migration[%d].Version = %d, want %d", i, migrations[i].Version, want)
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
	conversationMigration, err := migrationFS.ReadFile("migrations/00010_conversations.sql")
	if err != nil {
		t.Fatal(err)
	}
	conversationSQL := string(conversationMigration)
	for _, required := range []string{"CREATE TABLE ao_conversations", "owner_user_id = ao_current_user_id()", "FORCE ROW LEVEL SECURITY"} {
		if !strings.Contains(conversationSQL, required) {
			t.Fatalf("conversation migration does not contain %q", required)
		}
	}
	eventMigration, err := migrationFS.ReadFile("migrations/00011_conversation_provider_events.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(eventMigration), "CREATE TABLE ao_conversation_provider_events") {
		t.Fatal("provider-event migration does not create archive table")
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
	productMigration, err := migrationFS.ReadFile("migrations/00009_control_plane_state.sql")
	if err != nil {
		t.Fatal(err)
	}
	productSQL := string(productMigration)
	for _, required := range []string{
		"CREATE TABLE ao_projects", "CREATE TABLE ao_workspace_repos",
		"CREATE TABLE ao_sessions", "CREATE TABLE ao_session_worktrees",
		"ALTER TABLE ao_projects FORCE ROW LEVEL SECURITY",
		"ALTER TABLE ao_sessions FORCE ROW LEVEL SECURITY",
	} {
		if !strings.Contains(productSQL, required) {
			t.Fatalf("product migration does not contain %q", required)
		}
	}
	changeMigration, err := migrationFS.ReadFile("migrations/00060_change_events.sql")
	if err != nil {
		t.Fatal(err)
	}
	changeSQL := string(changeMigration)
	for _, required := range []string{
		"CREATE TABLE ao_change_heads",
		"CREATE TABLE ao_change_log",
		"CREATE TABLE ao_change_cursors",
		"ALTER TABLE ao_change_log FORCE ROW LEVEL SECURITY",
		"PERFORM pg_notify('ao_change_events'",
	} {
		if !strings.Contains(changeSQL, required) {
			t.Fatalf("change event migration does not contain %q", required)
		}
	}

}

func TestTenantTablesCoverEveryTenantTable(t *testing.T) {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	declared := make(map[string]bool, len(runtimeTables))
	for _, table := range runtimeTables {
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
				t.Fatalf("%s creates table %q, which is missing from runtimeTables", entry.Name(), match[1])
			}
		}
	}
}

func TestProductMigrationsForceTenantRLS(t *testing.T) {
	t.Parallel()
	for _, fixture := range []struct {
		file  string
		table string
	}{
		{file: "migrations/00050_product_settings.sql", table: "ao_app_settings"},
		{file: "migrations/00051_pull_requests.sql", table: "ao_pull_requests"},
		{file: "migrations/00051_pull_requests.sql", table: "ao_pull_request_url_aliases"},
		{file: "migrations/00052_pull_request_checks.sql", table: "ao_pull_request_checks"},
		{file: "migrations/00053_pull_request_comments.sql", table: "ao_pull_request_comments"},
		{file: "migrations/00054_pull_request_reviews.sql", table: "ao_pull_request_reviews"},
		{file: "migrations/00055_pull_request_review_threads.sql", table: "ao_pull_request_review_threads"},
		{file: "migrations/00056_notifications.sql", table: "ao_notifications"},
		{file: "migrations/00059_agent_inventory_cache.sql", table: "ao_agent_inventory_cache"},
	} {
		fixture := fixture
		t.Run(fixture.table, func(t *testing.T) {
			contents, err := migrationFS.ReadFile(fixture.file)
			if err != nil {
				t.Fatal(err)
			}
			sql := string(contents)
			for _, required := range []string{
				"org_id UUID",
				"ENABLE ROW LEVEL SECURITY",
				"FORCE ROW LEVEL SECURITY",
				"org_id = ao_current_org_id()",
				"ao_is_org_member(org_id, ao_current_user_id())",
			} {
				if !strings.Contains(sql, required) {
					t.Fatalf("%s does not contain %q", fixture.file, required)
				}
			}
		})
	}
}
