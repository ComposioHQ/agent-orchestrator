package postgres

import (
	"strings"

	"github.com/jackc/pgx/v5"
)

// runtimeTables is the single registry of tenant tables available to the
// restricted ao-cloud runtime role. New storage slices append their tables
// here when their migration is integrated; grants and startup validation must
// never maintain independent lists.
var runtimeTables = []string{
	"ao_users",
	"ao_auth_sessions",
	"ao_organizations",
	"ao_org_memberships",
	"ao_cloud_workspaces",
	"ao_cloud_session_runtimes",
	"ao_projects",
	"ao_sessions",
	"ao_session_worktrees",
}

func qualifiedRuntimeTables() string {
	qualified := make([]string, 0, len(runtimeTables))
	for _, table := range runtimeTables {
		qualified = append(qualified, pgx.Identifier{"public", table}.Sanitize())
	}
	return strings.Join(qualified, ", ")
}
