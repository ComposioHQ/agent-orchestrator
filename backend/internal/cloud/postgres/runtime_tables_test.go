package postgres

import (
	"strings"
	"testing"
)

func TestQualifiedRuntimeTablesUsesCanonicalRegistry(t *testing.T) {
	t.Parallel()

	got := qualifiedRuntimeTables()
	for _, table := range runtimeTables {
		qualified := `"public"."` + table + `"`
		if strings.Count(got, qualified) != 1 {
			t.Fatalf("qualifiedRuntimeTables() contains %q %d times; want once: %s", qualified, strings.Count(got, qualified), got)
		}
	}
	if strings.Count(got, ",") != len(runtimeTables)-1 {
		t.Fatalf("qualifiedRuntimeTables() = %q; want %d tables", got, len(runtimeTables))
	}
}

func TestRuntimeTableGrantsKeepDefinerTablesPrivate(t *testing.T) {
	t.Parallel()

	statements := strings.Join(runtimeTableGrantStatements(`"runtime"`), "\n")
	for _, table := range []string{"ao_scm_webhook_deliveries", "ao_scm_observations"} {
		if strings.Contains(statements, table) {
			t.Fatalf("runtime grants expose definer-only table %s: %s", table, statements)
		}
	}
	for table, privileges := range map[string]string{
		"ao_scm_installations":  "GRANT SELECT, DELETE",
		"ao_scm_install_states": "GRANT INSERT",
		"ao_scm_token_grants":   "GRANT SELECT, INSERT",
	} {
		needle := privileges + ` ON TABLE "public"."` + table + `" TO "runtime"`
		if !strings.Contains(statements, needle) {
			t.Errorf("runtime grants missing %q: %s", needle, statements)
		}
	}
}
