package domain

import "fmt"

// PermissionMode controls how much review an agent requires before acting. It
// lives in domain (not ports) so the typed AgentConfig can carry it; ports
// re-exports it as a type alias so agent adapters keep referring to
// ports.PermissionMode unchanged.
type PermissionMode string

// The permission modes adapters map onto their agent's native approval flags.
const (
	// PermissionModeDefault is special: adapters choose their own baseline
	// behavior for it. Most defer to the agent's own config; some managed
	// adapters may map it to a safer non-interactive default.
	PermissionModeDefault           PermissionMode = "default"
	PermissionModeAcceptEdits       PermissionMode = "accept-edits"
	PermissionModeAuto              PermissionMode = "auto"
	PermissionModeBypassPermissions PermissionMode = "bypass-permissions"
)

// AgentConfig is the typed per-project agent configuration. It replaces the
// former free-form map so the fields are validated and the API/UI render a
// real form rather than arbitrary JSON. An empty value (IsZero) means unset.
type AgentConfig struct {
	// Model overrides the agent's default model (e.g. claude-opus-4-5).
	Model string `json:"model,omitempty"`
	// Mode selects an agent-owned operating mode when the adapter exposes modes
	// instead of raw model ids (currently Amp: low|medium|high|ultra).
	Mode string `json:"mode,omitempty"`
	// Permissions sets the agent's starting permission mode. Empty is treated
	// like the adapter's default mode.
	Permissions PermissionMode `json:"permissions,omitempty"`
	// NativeReview configures an adapter-owned, non-interactive review command.
	// It is currently consumed only when Qwen's mode is "native-review"; keeping
	// these flags typed prevents arbitrary provider argv from crossing the API.
	NativeReview *NativeReviewConfig `json:"nativeReview,omitempty"`
}

// NativeReviewConfig is the typed option set shared with Qwen Code's native
// review command. Zero values deliberately defer to Qwen's own defaults.
type NativeReviewConfig struct {
	Effort         string `json:"effort,omitempty" enum:"low,medium,high"`
	Comment        bool   `json:"comment,omitempty"`
	Resume         bool   `json:"resume,omitempty"`
	Quiet          bool   `json:"quiet,omitempty"`
	TimeoutMinutes int    `json:"timeoutMinutes,omitempty"`
}

// IsZero reports whether the config carries no settings, so storage can persist
// SQL NULL and resolution can skip an empty config.
func (c AgentConfig) IsZero() bool {
	return c == AgentConfig{}
}

// Equal compares configuration values rather than pointer identity. Native
// review options arrive through JSON as fresh pointers on every read.
func (c AgentConfig) Equal(other AgentConfig) bool {
	if c.Model != other.Model || c.Mode != other.Mode || c.Permissions != other.Permissions {
		return false
	}
	left, right := NativeReviewConfig{}, NativeReviewConfig{}
	if c.NativeReview != nil {
		left = *c.NativeReview
	}
	if other.NativeReview != nil {
		right = *other.NativeReview
	}
	return left == right
}

// Valid reports whether the mode is one AO knows. Empty counts as valid: it means
// "the adapter's own baseline", which is a legitimate choice rather than a missing
// one.
func (m PermissionMode) Valid() bool {
	switch m {
	case "", PermissionModeDefault, PermissionModeAcceptEdits,
		PermissionModeAuto, PermissionModeBypassPermissions:
		return true
	default:
		return false
	}
}

// Validate rejects values outside the typed vocabulary so a bad config is
// refused when it is set (CLI/API) rather than silently dropped at spawn.
func (c AgentConfig) Validate() error {
	switch c.Mode {
	case "", "low", "medium", "high", "ultra", "native-review":
	default:
		return fmt.Errorf("invalid mode %q: want one of low, medium, high, ultra, native-review", c.Mode)
	}
	if c.NativeReview != nil {
		if c.Mode != "native-review" {
			return fmt.Errorf("nativeReview requires mode %q", "native-review")
		}
		switch c.NativeReview.Effort {
		case "", "low", "medium", "high":
		default:
			return fmt.Errorf("invalid nativeReview.effort %q: want one of low, medium, high", c.NativeReview.Effort)
		}
		if c.NativeReview.Comment && (c.NativeReview.Effort == "low" || c.NativeReview.Effort == "medium") {
			return fmt.Errorf("nativeReview.comment requires effort high or omitted")
		}
		if c.NativeReview.TimeoutMinutes < 0 {
			return fmt.Errorf("nativeReview.timeoutMinutes must be positive when set")
		}
	}
	if c.Permissions.Valid() {
		return nil
	}
	return fmt.Errorf("invalid permissions %q: want one of default, accept-edits, auto, bypass-permissions", c.Permissions)
}

// ValidateReviewer applies the provider boundary that the generic config
// vocabulary cannot express: native-review is a Qwen-only reviewer mode.
func (c AgentConfig) ValidateReviewer(harness ReviewerHarness) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if (c.Mode == "native-review" || c.NativeReview != nil) && harness != ReviewerQwen {
		return fmt.Errorf("native-review mode requires reviewer harness %q", ReviewerQwen)
	}
	return nil
}
