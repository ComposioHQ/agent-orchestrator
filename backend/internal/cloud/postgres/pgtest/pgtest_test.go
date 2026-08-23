package pgtest

import (
	"reflect"
	"testing"
)

func TestQualifiedPendingTablesIncludesCoreAndQuotesAdditionalNames(t *testing.T) {
	got, err := qualifiedPendingTables([]string{"ao_notifications", " odd-name ", "ao_projects"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		`"public"."ao_projects"`,
		`"public"."ao_sessions"`,
		`"public"."ao_session_worktrees"`,
		`"public"."ao_notifications"`,
		`"public"."odd-name"`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("qualifiedPendingTables = %#v, want %#v", got, want)
	}
}

func TestQualifiedPendingTablesRejectsEmptyName(t *testing.T) {
	if _, err := qualifiedPendingTables([]string{" "}); err == nil {
		t.Fatal("qualifiedPendingTables accepted an empty table name")
	}
}
