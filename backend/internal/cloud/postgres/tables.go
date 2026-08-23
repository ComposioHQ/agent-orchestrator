package postgres

import "strings"

// tenantTables is the canonical list of tables holding tenant data. Three
// separate checks read it, and they only stay in agreement if they read the
// same list: the runtime role is granted DML on exactly these, Open refuses to
// start unless every one of them has FORCE ROW LEVEL SECURITY, and Open also
// refuses a runtime role that owns any of them (an owner can drop a policy).
//
// A new tenant table must be added here in the same change as its migration.
// Leaving it out does not fail loudly — it produces a table the runtime role
// cannot reach at all, or worse, one whose RLS nobody verified.
var tenantTables = []string{
	"ao_users",
	"ao_auth_sessions",
	"ao_organizations",
	"ao_org_memberships",
	"ao_cloud_workspaces",
	"ao_cloud_session_runtimes",
	"ao_projects",
	"ao_workspace_repos",
	"ao_sessions",
	"ao_session_worktrees",
}

// qualifiedTenantTables renders the list for a GRANT statement. The names are
// compile-time constants in this file, never user input.
func qualifiedTenantTables() string {
	qualified := make([]string, 0, len(tenantTables))
	for _, table := range tenantTables {
		qualified = append(qualified, "public."+table)
	}
	return strings.Join(qualified, ", ")
}
