package acp

import (
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func selectOption(id, name, current string) acpsdk.SessionConfigOption {
	ungrouped := acpsdk.SessionConfigSelectOptionsUngrouped{
		{Value: acpsdk.SessionConfigValueId(current), Name: current},
	}
	return acpsdk.SessionConfigOption{
		Select: &acpsdk.SessionConfigOptionSelect{
			Id:           acpsdk.SessionConfigId(id),
			Name:         name,
			CurrentValue: acpsdk.SessionConfigValueId(current),
			Options:      acpsdk.SessionConfigSelectOptions{Ungrouped: &ungrouped},
		},
	}
}

// An agent that answers session/set_config_option without echoing the rebuilt
// catalog must not erase the one we already hold. ACP declares configOptions as
// the full, required set, so an empty list alongside a populated catalog is a
// partial answer rather than a real "this session now has no options" — and
// treating it as the latter made the entire turn-settings picker disappear
// mid-session until the agent happened to push a ConfigOptionUpdate.
func TestReplaceConfigOptionsKeepsCatalogWhenUpdateIsEmpty(t *testing.T) {
	c := &conversation{capabilities: make(ports.ChatCapabilities)}
	c.replaceConfigOptions([]acpsdk.SessionConfigOption{selectOption("model", "Model", "sonnet")})

	if got := len(c.configOptions); got != 1 {
		t.Fatalf("seed catalog: got %d options, want 1", got)
	}

	c.replaceConfigOptions(nil)
	if got := len(c.configOptions); got != 1 {
		t.Fatalf("nil update wiped the catalog: got %d options, want 1", got)
	}

	c.replaceConfigOptions([]acpsdk.SessionConfigOption{})
	if got := len(c.configOptions); got != 1 {
		t.Fatalf("empty update wiped the catalog: got %d options, want 1", got)
	}
	if c.configOptions[0].ID != "model" {
		t.Fatalf("kept the wrong option: got %q, want %q", c.configOptions[0].ID, "model")
	}
}

// A non-empty replacement is still authoritative: switching models can add,
// change, or remove the other controls, so the new catalog replaces the old one
// wholesale rather than merging into it.
func TestReplaceConfigOptionsReplacesOnNonEmptyUpdate(t *testing.T) {
	c := &conversation{capabilities: make(ports.ChatCapabilities)}
	c.replaceConfigOptions([]acpsdk.SessionConfigOption{
		selectOption("model", "Model", "sonnet"),
		selectOption("effort", "Effort", "high"),
	})

	c.replaceConfigOptions([]acpsdk.SessionConfigOption{selectOption("model", "Model", "opus")})

	if got := len(c.configOptions); got != 1 {
		t.Fatalf("got %d options, want 1 — a non-empty update is a full replacement", got)
	}
	if got := c.configOptions[0].Current.Select; got != "opus" {
		t.Fatalf("current value not updated: got %q, want %q", got, "opus")
	}
	if !c.capabilities[ports.ChatCapabilityConfigOptions] {
		t.Fatal("config-options capability should be set by a non-empty catalog")
	}
}

// An empty catalog on a conversation that never had one is a legitimate answer
// and must pass through, or an agent with genuinely no config options would look
// like a bug in the guard above.
func TestReplaceConfigOptionsAllowsEmptyWhenNoCatalogYet(t *testing.T) {
	c := &conversation{capabilities: make(ports.ChatCapabilities)}
	c.replaceConfigOptions(nil)

	if got := len(c.configOptions); got != 0 {
		t.Fatalf("got %d options, want 0", got)
	}
	if c.capabilities[ports.ChatCapabilityConfigOptions] {
		t.Fatal("an empty catalog must not advertise the config-options capability")
	}
}
