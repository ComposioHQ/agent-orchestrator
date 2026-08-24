package postgres

import (
	"strings"

	"github.com/jackc/pgx/v5"
)

type runtimeTableGrant struct {
	name       string
	privileges string
}

// runtimeTableGrants is the single registry for both startup RLS validation
// and least-privilege runtime grants. An empty privilege list means the table
// is reachable only through a SECURITY DEFINER function owned by its slice's
// NOLOGIN role.
var runtimeTableGrants = []runtimeTableGrant{
	{name: "ao_users", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_auth_sessions", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_organizations", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_org_memberships", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_cloud_workspaces", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_cloud_session_runtimes", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_compute_quota_reservations", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_compute_capabilities", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_terminal_tickets", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_projects", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_sessions", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_session_worktrees", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_scm_installations", privileges: "SELECT, DELETE"},
	{name: "ao_scm_repositories", privileges: "SELECT, INSERT, UPDATE, DELETE"},
	{name: "ao_scm_install_states", privileges: "INSERT"},
	{name: "ao_scm_token_grants", privileges: "SELECT, INSERT"},
	{name: "ao_scm_webhook_deliveries"},
	{name: "ao_scm_observations"},
}

var runtimeTables = func() []string {
	tables := make([]string, 0, len(runtimeTableGrants))
	for _, grant := range runtimeTableGrants {
		tables = append(tables, grant.name)
	}
	return tables
}()

func qualifiedRuntimeTables() string {
	qualified := make([]string, 0, len(runtimeTables))
	for _, table := range runtimeTables {
		qualified = append(qualified, pgx.Identifier{"public", table}.Sanitize())
	}
	return strings.Join(qualified, ", ")
}

func runtimeTableGrantStatements(role string) []string {
	statements := make([]string, 0, len(runtimeTableGrants))
	for _, grant := range runtimeTableGrants {
		if grant.privileges == "" {
			continue
		}
		statements = append(statements, "GRANT "+grant.privileges+" ON TABLE "+
			pgx.Identifier{"public", grant.name}.Sanitize()+" TO "+role)
	}
	return statements
}
