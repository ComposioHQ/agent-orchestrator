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

func TestEnsureRuntimeRoleRequiresCredentials(t *testing.T) {
	if err := EnsureRuntimeRole(context.Background(), "unused", " ", "secret"); err == nil {
		t.Fatal("EnsureRuntimeRole succeeded without a role")
	}
	if err := EnsureRuntimeRole(context.Background(), "unused", "ao_cloud_app", ""); err == nil {
		t.Fatal("EnsureRuntimeRole succeeded without a password")
	}
}
