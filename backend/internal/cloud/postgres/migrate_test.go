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
	if len(migrations) != 10 || migrations[0].Version != 1 || migrations[1].Version != 2 || migrations[2].Version != 3 || migrations[3].Version != 4 || migrations[4].Version != 5 || migrations[5].Version != 6 || migrations[6].Version != 7 || migrations[7].Version != 8 || migrations[8].Version != 60 || migrations[9].Version != 61 {
		t.Fatalf("migrations = %#v", migrations)
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
		"CREATE FUNCTION ao_capture_change_event()",
		"INSERT INTO public.ao_change_log",
		"PERFORM pg_notify('ao_change_events'",
	} {
		if !strings.Contains(changeSQL, required) {
			t.Fatalf("change event migration does not contain %q", required)
		}
	}
	triggerMigration, err := migrationFS.ReadFile("migrations/00061_change_event_triggers.sql")
	if err != nil {
		t.Fatal(err)
	}
	triggerSQL := string(triggerMigration)
	for _, required := range []string{
		"ao_projects_change_created",
		"ao_workspace_repos_change_inserted",
		"ao_sessions_change_created",
		"ao_sessions_change_updated",
		"ao_conversations_change_inserted",
		"ao_conversation_provider_events_change_inserted",
		"ao_pull_requests_change_created",
		"ao_pull_requests_change_updated",
		"ao_pull_requests_change_session",
		"ao_pull_request_checks_change_inserted",
		"ao_pull_request_checks_change_updated",
		"ao_pull_request_review_threads_change_added",
		"ao_pull_request_review_threads_change_resolved",
		"ao_pull_request_comments_change_inserted",
		"ao_pull_request_reviews_change_inserted",
		"ao_notifications_change_created",
		"ao_notifications_change_resolved",
	} {
		if !strings.Contains(triggerSQL, required) {
			t.Fatalf("change trigger migration does not contain %q", required)
		}
	}

}
