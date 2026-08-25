package postgres

import (
	"context"
	"testing"
)

func TestGrantRuntimeRoleRequiresRole(t *testing.T) {
	if err := GrantRuntimeRole(context.Background(), "unused", " "); err == nil {
		t.Fatal("GrantRuntimeRole succeeded without a role")
	}
}
