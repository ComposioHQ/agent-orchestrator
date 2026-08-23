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
