package domain

import (
	"fmt"
	"sort"
	"strings"
)

// TrackerProvider identifies an issue-tracker provider implementation.
type TrackerProvider string

// The supported issue-tracker providers.
const (
	TrackerProviderGitHub TrackerProvider = "github"
	TrackerProviderGitLab TrackerProvider = "gitlab"
	TrackerProviderOneDev TrackerProvider = "onedev"
)

// TrackerID identifies one issue. Native is the provider's own canonical form
// ("owner/repo#123" for GitHub, "group/project#123" for GitLab,
// "project/path#123" for OneDev) and is parsed by the adapter.
//
// Host is the self-hosted instance host (e.g. "gitlab.example.com"). For
// GitLab the zero value "" means gitlab.com, so all existing call sites that
// construct TrackerID without setting Host continue to work unchanged. OneDev
// has no public instance, so a OneDev id carries a real host unless exactly
// one instance is configured.
type TrackerID struct {
	Provider TrackerProvider `json:"provider"`
	Native   string          `json:"native"`
	// Host is the self-hosted instance host; "" means gitlab.com for GitLab.
	Host string `json:"host,omitempty"`
}

// NormalizedIssueState is the cross-provider issue-state vocabulary every
// adapter must implement. The closed list is intentional — adding a value
// here is a port-level decision because every adapter must map it.
type NormalizedIssueState string

// The normalized cross-provider issue states.
const (
	IssueOpen       NormalizedIssueState = "open"
	IssueInProgress NormalizedIssueState = "in_progress"
	IssueInReview   NormalizedIssueState = "review"
	IssueDone       NormalizedIssueState = "done"
	IssueCancelled  NormalizedIssueState = "cancelled"
)

// Issue is the minimum projection every tracker can produce. Provider-specific
// metadata stays inside provider-specific code paths.
type Issue struct {
	ID        TrackerID            `json:"id"`
	Title     string               `json:"title"`
	Body      string               `json:"body"`
	State     NormalizedIssueState `json:"state"`
	URL       string               `json:"url"`
	Labels    []string             `json:"labels,omitempty"`
	Assignees []string             `json:"assignees,omitempty"`
}

// TrackerRepo identifies a repository for cross-issue queries like Tracker.List.
// Native is the provider's canonical owner/project form, e.g. "owner/repo"
// for GitHub, "group/project" for GitLab, or a OneDev project path — which
// may be a single segment ("productone") because OneDev projects form a tree
// rather than an owner/repo pair.
//
// Host is the self-hosted instance host (e.g. "gitlab.example.com"). For
// GitLab the zero value "" means gitlab.com, so all existing call sites that
// construct TrackerRepo without setting Host continue to work unchanged.
type TrackerRepo struct {
	Provider TrackerProvider `json:"provider"`
	Native   string          `json:"native"`
	// Host is the self-hosted instance host; "" means gitlab.com for GitLab.
	Host string `json:"host,omitempty"`
}

// ListStateFilter narrows Tracker.List results by the provider's coarse
// state (open vs closed). It is intentionally NOT the 5-value normalized
// enum — finer filtering (e.g. "only in-review issues") goes through the
// Labels field of ListFilter.
type ListStateFilter string

// Coarse list-state filters for Tracker.List.
const (
	// ListAll is the zero value and returns issues in any state.
	ListAll    ListStateFilter = ""
	ListOpen   ListStateFilter = "open"
	ListClosed ListStateFilter = "closed"
)

// ListFilter is the query the Session Manager passes to Tracker.List.
// Empty / zero values mean "no filter on this dimension".
//
// Limit is an optional total-result cap. Adapters choose their own provider
// page size.
type ListFilter struct {
	State    ListStateFilter `json:"state,omitempty"`
	Labels   []string        `json:"labels,omitempty"`
	Assignee string          `json:"assignee,omitempty"`
	Limit    int             `json:"limit,omitempty"`
}

// TrackerIntakeConfig controls issue-driven worker spawning for a project.
// Enabled requires an explicit assignee eligibility rule so turning intake on
// cannot accidentally drain an entire issue backlog.
type TrackerIntakeConfig struct {
	Enabled bool `json:"enabled,omitempty"`
	// Provider defaults to github when Enabled is true. Supported values:
	// "github", "gitlab" and "onedev".
	Provider TrackerProvider `json:"provider,omitempty" enum:"github,gitlab,onedev"`
	// Repo is the provider-native repository key ("owner/repo" for GitHub,
	// "group/project" for GitLab, a project path for OneDev — which may be a
	// single segment). When empty, the intake loop derives it from the
	// project's repo origin URL.
	Repo string `json:"repo,omitempty"`
	// Assignee narrows eligible issues to one assignee. Provider-specific values
	// such as "*" are passed through unchanged.
	Assignee string `json:"assignee,omitempty"`
}

// supportedIntakeProviders is the set of providers issue intake can resolve an
// adapter for. It is a set rather than a chain of comparisons so adding a
// provider is one line and cannot be half-added.
var supportedIntakeProviders = map[TrackerProvider]bool{
	TrackerProviderGitHub: true,
	TrackerProviderGitLab: true,
	TrackerProviderOneDev: true,
}

// SupportedIntakeProviders returns the providers issue intake can resolve an
// adapter for, sorted so callers can render a stable list in help text and
// error messages. It reads supportedIntakeProviders so adding a provider stays
// a one-line change there.
func SupportedIntakeProviders() []TrackerProvider {
	providers := make([]TrackerProvider, 0, len(supportedIntakeProviders))
	for provider := range supportedIntakeProviders {
		providers = append(providers, provider)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i] < providers[j] })
	return providers
}

// IsSupportedIntakeProvider reports whether issue intake can resolve an adapter
// for the given provider.
func IsSupportedIntakeProvider(provider TrackerProvider) bool {
	return supportedIntakeProviders[provider]
}

// WithDefaults fills the provider only when intake is enabled. Disabled intake
// leaves the zero value untouched so empty project configs still store as NULL.
func (c TrackerIntakeConfig) WithDefaults() TrackerIntakeConfig {
	if c.Enabled && c.Provider == "" {
		c.Provider = TrackerProviderGitHub
	}
	return c
}

// Validate rejects accidental broad intake and unknown providers.
func (c TrackerIntakeConfig) Validate() error {
	if !c.Enabled {
		return nil
	}
	c = c.WithDefaults()
	if !supportedIntakeProviders[c.Provider] {
		return fmt.Errorf("trackerIntake.provider: unsupported provider %q", c.Provider)
	}
	if err := validateNoWhitespaceField("trackerIntake.repo", c.Repo); err != nil {
		return err
	}
	if err := validateNoWhitespaceField("trackerIntake.assignee", c.Assignee); err != nil {
		return err
	}
	if strings.TrimSpace(c.Assignee) == "" {
		return fmt.Errorf("trackerIntake: assignee is required when enabled")
	}
	return nil
}
