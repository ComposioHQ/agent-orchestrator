// Package harnesscatalog is the cloud execution capability registry. A harness
// belongs here only after its sandbox installer and credential custody path are
// implemented; the desktop then learns availability from the cloud coordinator
// instead of probing binaries on the user's machine.
package harnesscatalog

import (
	"path/filepath"
	"sort"
	"strings"
)

// CredentialKind identifies the provider-specific credential adapter required
// before a harness can be advertised as cloud-managed.
type CredentialKind string

// CredentialClaudeOAuth selects the Claude Code OAuth credential adapter.
const CredentialClaudeOAuth CredentialKind = "claude-oauth"

// Spec contains the provider-neutral information needed to prepare a harness
// in both the project coordinator and each isolated session runtime.
type Spec struct {
	ID                     string
	Executable             string
	InstallCommand         string
	CredentialKind         CredentialKind
	CredentialRelativePath string
}

var specs = []Spec{
	{
		ID:                     "claude-code",
		Executable:             "claude",
		InstallCommand:         `sudo env PATH="$PATH" npm install -g @anthropic-ai/claude-code`,
		CredentialKind:         CredentialClaudeOAuth,
		CredentialRelativePath: filepath.Join(".claude", ".credentials.json"),
	},
}

// All returns a copy in stable id order.
func All() []Spec {
	result := append([]Spec(nil), specs...)
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

// IDs returns the harness ids safe to advertise from a cloud coordinator.
func IDs() []string {
	all := All()
	result := make([]string, 0, len(all))
	for _, spec := range all {
		result = append(result, spec.ID)
	}
	return result
}

// CSV returns IDs in the daemon environment format.
func CSV() string { return strings.Join(IDs(), ",") }

// Lookup returns one advertised harness capability.
func Lookup(id string) (Spec, bool) {
	for _, spec := range specs {
		if spec.ID == id {
			return spec, true
		}
	}
	return Spec{}, false
}

// DetectLaunch resolves the harness executable embedded in AO's supervised
// argv. Arguments may contain the coordinator's absolute executable path.
func DetectLaunch(argv []string) (Spec, bool) {
	for _, argument := range argv {
		base := filepath.Base(argument)
		for _, spec := range specs {
			if base == spec.Executable {
				return spec, true
			}
		}
	}
	return Spec{}, false
}
