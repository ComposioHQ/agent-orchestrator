package cli

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
)

type codexProfileSwitchSummaryDTO struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Source       string `json:"source"`
	Availability string `json:"availability"`
}

type codexProfileSwitchAuthDTO struct {
	State     string `json:"state"`
	Freshness string `json:"freshness"`
}

type codexProfileSwitchCapacityDTO struct {
	State       string   `json:"state"`
	Freshness   string   `json:"freshness"`
	UsedPercent *float64 `json:"usedPercent,omitempty"`
	ResetsAt    *string  `json:"resetsAt,omitempty"`
}

type codexProfileSwitchCandidateDTO struct {
	ID                              string                        `json:"id"`
	Label                           string                        `json:"label"`
	Source                          string                        `json:"source"`
	Authentication                  codexProfileSwitchAuthDTO     `json:"authentication"`
	Capacity                        codexProfileSwitchCapacityDTO `json:"capacity"`
	Recommended                     bool                          `json:"recommended"`
	Selectable                      bool                          `json:"selectable"`
	RequiresCapacityAcknowledgement bool                          `json:"requiresCapacityAcknowledgement"`
	ReasonCode                      string                        `json:"reasonCode"`
	Reason                          string                        `json:"reason"`
}

type codexProfileSwitchOptionsDTO struct {
	SourceProfile        codexProfileSwitchSummaryDTO     `json:"sourceProfile"`
	RecommendedProfileID *string                          `json:"recommendedProfileId,omitempty"`
	Candidates           []codexProfileSwitchCandidateDTO `json:"candidates"`
}

type codexProfileSwitchDTO struct {
	ID                         string                        `json:"id"`
	SourceSessionID            string                        `json:"sourceSessionId"`
	TargetSessionID            *string                       `json:"targetSessionId,omitempty"`
	SourceProfileID            string                        `json:"sourceProfileId"`
	TargetProfileID            string                        `json:"targetProfileId"`
	Trigger                    string                        `json:"trigger"`
	Phase                      string                        `json:"phase"`
	HandoffClassification      string                        `json:"handoffClassification"`
	AcknowledgeUnknownCapacity bool                          `json:"acknowledgeUnknownCapacity"`
	ProgressReason             string                        `json:"progressReason"`
	CanCancel                  bool                          `json:"canCancel"`
	CanRecover                 bool                          `json:"canRecover"`
	CanRestoreSource           bool                          `json:"canRestoreSource"`
	ErrorCode                  string                        `json:"errorCode,omitempty"`
	SourceProfile              *codexProfileSwitchSummaryDTO `json:"sourceProfile,omitempty"`
	TargetProfile              *codexProfileSwitchSummaryDTO `json:"targetProfile,omitempty"`
	RequestedAt                time.Time                     `json:"requestedAt"`
	UpdatedAt                  time.Time                     `json:"updatedAt"`
	CompletedAt                *time.Time                    `json:"completedAt,omitempty"`
}

type codexProfileSwitchResponseDTO struct {
	Switch codexProfileSwitchDTO `json:"switch"`
}

type codexProfileSwitchListDTO struct {
	Switches []codexProfileSwitchDTO `json:"switches"`
}

type codexAutomaticPolicyEntryDTO struct {
	ID             string                         `json:"id"`
	Label          string                         `json:"label"`
	Source         *string                        `json:"source,omitempty"`
	Availability   string                         `json:"availability"`
	Authentication *codexProfileSwitchAuthDTO     `json:"authentication,omitempty"`
	Capacity       *codexProfileSwitchCapacityDTO `json:"capacity,omitempty"`
	Current        bool                           `json:"current"`
	ReasonCode     string                         `json:"reasonCode"`
	Reason         string                         `json:"reason"`
}

type codexAutomaticPolicyDTO struct {
	ChainRootSessionID string                         `json:"chainRootSessionId"`
	Enabled            bool                           `json:"enabled"`
	Revision           int64                          `json:"revision"`
	CurrentProfile     codexProfileSwitchSummaryDTO   `json:"currentProfile"`
	Profiles           []codexAutomaticPolicyEntryDTO `json:"profiles"`
	CreatedAt          *time.Time                     `json:"createdAt,omitempty"`
	UpdatedAt          *time.Time                     `json:"updatedAt,omitempty"`
}

type codexAutomaticAttemptDTO struct {
	ID                      string                        `json:"id"`
	State                   string                        `json:"state"`
	Trigger                 string                        `json:"trigger"`
	SourceProfile           *codexProfileSwitchSummaryDTO `json:"sourceProfile,omitempty"`
	TargetProfile           *codexProfileSwitchSummaryDTO `json:"targetProfile,omitempty"`
	SelectedProfilePosition *int64                        `json:"selectedProfilePosition,omitempty"`
	OutcomeCode             string                        `json:"outcomeCode"`
	Reason                  string                        `json:"reason"`
	CanCancel               bool                          `json:"canCancel"`
	CreatedAt               time.Time                     `json:"createdAt"`
	UpdatedAt               time.Time                     `json:"updatedAt"`
}

func newSessionProfileSwitchCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "profile-switch", Short: "Continue a Codex session with another profile"}
	cmd.AddCommand(newSessionProfileSwitchOptionsCommand(ctx))
	cmd.AddCommand(newSessionProfileSwitchStartCommand(ctx))
	cmd.AddCommand(newSessionProfileSwitchListCommand(ctx))
	cmd.AddCommand(newSessionProfileSwitchCancelCommand(ctx))
	cmd.AddCommand(newSessionProfileSwitchRecoverCommand(ctx))
	cmd.AddCommand(newSessionProfileSwitchAutomaticCommand(ctx))
	return cmd
}

func newSessionProfileSwitchAutomaticCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "automatic", Short: "Manage chain-scoped automatic Codex switching"}
	cmd.AddCommand(newSessionProfileSwitchAutomaticShowCommand(ctx))
	cmd.AddCommand(newSessionProfileSwitchAutomaticEnableCommand(ctx))
	cmd.AddCommand(newSessionProfileSwitchAutomaticDisableCommand(ctx))
	cmd.AddCommand(newSessionProfileSwitchAutomaticCancelCommand(ctx))
	return cmd
}

func newSessionProfileSwitchAutomaticShowCommand(ctx *commandContext) *cobra.Command {
	var jsonOutput bool
	cmd := &cobra.Command{Use: "show <session-id>", Short: "Show the automatic fallback policy", Args: oneSessionIDArg, RunE: func(cmd *cobra.Command, args []string) error {
		id, err := normalizeSessionID(args[0])
		if err != nil {
			return err
		}
		var policy codexAutomaticPolicyDTO
		if err := ctx.getJSON(cmd.Context(), automaticProfileSwitchPolicyCLIPath(id), &policy); err != nil {
			return err
		}
		return writeCodexAutomaticPolicy(cmd, policy, jsonOutput)
	}}
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output policy as JSON")
	return cmd
}

func newSessionProfileSwitchAutomaticEnableCommand(ctx *commandContext) *cobra.Command {
	var profileIDs []string
	var expectedRevision int64
	var jsonOutput bool
	cmd := &cobra.Command{Use: "enable <session-id>", Short: "Enable ordered automatic fallbacks", Args: oneSessionIDArg, RunE: func(cmd *cobra.Command, args []string) error {
		id, err := normalizeSessionID(args[0])
		if err != nil {
			return err
		}
		var current codexAutomaticPolicyDTO
		if !cmd.Flags().Changed("expected-revision") || len(profileIDs) == 0 {
			if err := ctx.getJSON(cmd.Context(), automaticProfileSwitchPolicyCLIPath(id), &current); err != nil {
				return err
			}
			if !cmd.Flags().Changed("expected-revision") {
				expectedRevision = current.Revision
			}
			if len(profileIDs) == 0 {
				for _, entry := range current.Profiles {
					profileIDs = append(profileIDs, entry.ID)
				}
			}
		}
		if len(profileIDs) == 0 {
			return usageError{errors.New("at least one --profile is required when no fallback list is configured")}
		}
		return putCodexAutomaticPolicy(ctx, cmd, id, true, profileIDs, expectedRevision, jsonOutput)
	}}
	cmd.Flags().StringArrayVar(&profileIDs, "profile", nil, "Approved profile id in priority order (repeatable)")
	cmd.Flags().Int64Var(&expectedRevision, "expected-revision", 0, "Policy revision for compare-and-swap")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output updated policy as JSON")
	return cmd
}

func newSessionProfileSwitchAutomaticDisableCommand(ctx *commandContext) *cobra.Command {
	var expectedRevision int64
	var jsonOutput bool
	cmd := &cobra.Command{Use: "disable <session-id>", Short: "Disable automatic switching and retain fallbacks", Args: oneSessionIDArg, RunE: func(cmd *cobra.Command, args []string) error {
		id, err := normalizeSessionID(args[0])
		if err != nil {
			return err
		}
		var current codexAutomaticPolicyDTO
		if err := ctx.getJSON(cmd.Context(), automaticProfileSwitchPolicyCLIPath(id), &current); err != nil {
			return err
		}
		if !cmd.Flags().Changed("expected-revision") {
			expectedRevision = current.Revision
		}
		profileIDs := make([]string, 0, len(current.Profiles))
		for _, entry := range current.Profiles {
			profileIDs = append(profileIDs, entry.ID)
		}
		return putCodexAutomaticPolicy(ctx, cmd, id, false, profileIDs, expectedRevision, jsonOutput)
	}}
	cmd.Flags().Int64Var(&expectedRevision, "expected-revision", 0, "Policy revision for compare-and-swap")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output updated policy as JSON")
	return cmd
}

func newSessionProfileSwitchAutomaticCancelCommand(ctx *commandContext) *cobra.Command {
	var jsonOutput bool
	cmd := &cobra.Command{Use: "cancel <session-id> <attempt-id>", Short: "Cancel automatic evaluation while safe", Args: usageArgs(cobra.ExactArgs(2)), RunE: func(cmd *cobra.Command, args []string) error {
		id, err := normalizeSessionID(args[0])
		if err != nil {
			return err
		}
		attemptID := strings.TrimSpace(args[1])
		if attemptID == "" {
			return usageError{errors.New("attempt id is required")}
		}
		var out codexAutomaticAttemptDTO
		path := "sessions/" + url.PathEscape(id) + "/automatic-profile-switch-attempts/" + url.PathEscape(attemptID) + "/cancel"
		if err := ctx.postJSON(cmd.Context(), path, struct{}{}, &out); err != nil {
			return err
		}
		if jsonOutput {
			return writeJSON(cmd.OutOrStdout(), out)
		}
		_, err = fmt.Fprintf(cmd.OutOrStdout(), "attempt: %s\nstate: %s\n%s\n", out.ID, out.State, out.Reason)
		return err
	}}
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output attempt as JSON")
	return cmd
}

func putCodexAutomaticPolicy(ctx *commandContext, cmd *cobra.Command, id string, enabled bool, profileIDs []string, revision int64, jsonOutput bool) error {
	req := struct {
		Enabled          bool     `json:"enabled"`
		ProfileIDs       []string `json:"profileIds"`
		ExpectedRevision int64    `json:"expectedRevision"`
	}{enabled, profileIDs, revision}
	var out codexAutomaticPolicyDTO
	if err := ctx.putJSON(cmd.Context(), automaticProfileSwitchPolicyCLIPath(id), req, &out); err != nil {
		return err
	}
	return writeCodexAutomaticPolicy(cmd, out, jsonOutput)
}

func automaticProfileSwitchPolicyCLIPath(sessionID string) string {
	return "sessions/" + url.PathEscape(sessionID) + "/automatic-profile-switch-policy"
}

func writeCodexAutomaticPolicy(cmd *cobra.Command, policy codexAutomaticPolicyDTO, jsonOutput bool) error {
	if jsonOutput {
		return writeJSON(cmd.OutOrStdout(), policy)
	}
	if _, err := fmt.Fprintf(cmd.OutOrStdout(), "enabled: %t\nrevision: %d\nchain: %s\n", policy.Enabled, policy.Revision, policy.ChainRootSessionID); err != nil {
		return err
	}
	if len(policy.Profiles) == 0 {
		_, err := fmt.Fprintln(cmd.OutOrStdout(), "(no approved fallback profiles)")
		return err
	}
	tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "ORDER\tPROFILE\tCURRENT\tAUTH\tCAPACITY\tREASON"); err != nil {
		return err
	}
	for position, entry := range policy.Profiles {
		auth, capacity := "unknown", "unknown"
		if entry.Authentication != nil {
			auth = entry.Authentication.State
		}
		if entry.Capacity != nil {
			capacity = entry.Capacity.State
		}
		if _, err := fmt.Fprintf(tw, "%d\t%s\t%t\t%s\t%s\t%s\n", position+1, entry.ID, entry.Current, auth, capacity, entry.ReasonCode); err != nil {
			return err
		}
	}
	return tw.Flush()
}

func newSessionProfileSwitchOptionsCommand(ctx *commandContext) *cobra.Command {
	var jsonOutput bool
	cmd := &cobra.Command{Use: "options <session-id>", Short: "List assisted profile-switch options", Args: oneSessionIDArg, RunE: func(cmd *cobra.Command, args []string) error {
		id, err := normalizeSessionID(args[0])
		if err != nil {
			return err
		}
		var out codexProfileSwitchOptionsDTO
		if err := ctx.postJSON(cmd.Context(), profileSwitchCLIPath(id)+"-options/ensure", struct{}{}, &out); err != nil {
			return err
		}
		if jsonOutput {
			return writeJSON(cmd.OutOrStdout(), out)
		}
		return writeCodexProfileSwitchOptions(cmd, out)
	}}
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output options as JSON")
	return cmd
}

func newSessionProfileSwitchStartCommand(ctx *commandContext) *cobra.Command {
	var profile, key string
	var acknowledge, jsonOutput bool
	cmd := &cobra.Command{Use: "start <session-id>", Short: "Start an assisted profile switch", Args: oneSessionIDArg, RunE: func(cmd *cobra.Command, args []string) error {
		id, err := normalizeSessionID(args[0])
		if err != nil {
			return err
		}
		profile = strings.TrimSpace(profile)
		if profile == "" {
			return usageError{errors.New("--profile is required")}
		}
		key = strings.TrimSpace(key)
		if key == "" {
			key = uuid.NewString()
		}
		var out codexProfileSwitchResponseDTO
		req := struct {
			TargetProfileID string `json:"targetProfileId"`
			IdempotencyKey  string `json:"idempotencyKey"`
			Acknowledge     bool   `json:"acknowledgeUnknownCapacity,omitempty"`
		}{profile, key, acknowledge}
		if err := ctx.postJSON(cmd.Context(), profileSwitchCLIPath(id)+"es", req, &out); err != nil {
			return err
		}
		return writeCodexProfileSwitch(cmd, out, jsonOutput)
	}}
	cmd.Flags().StringVar(&profile, "profile", "", "Target Codex profile id (required)")
	cmd.Flags().BoolVar(&acknowledge, "acknowledge-unknown-capacity", false, "Acknowledge unknown or unsupported target capacity")
	cmd.Flags().StringVar(&key, "idempotency-key", "", "Retry key (generated when omitted)")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output the accepted operation as JSON")
	return cmd
}

func newSessionProfileSwitchListCommand(ctx *commandContext) *cobra.Command {
	var jsonOutput bool
	cmd := &cobra.Command{Use: "ls <session-id>", Aliases: []string{"list"}, Short: "List profile switches", Args: oneSessionIDArg, RunE: func(cmd *cobra.Command, args []string) error {
		id, err := normalizeSessionID(args[0])
		if err != nil {
			return err
		}
		var out codexProfileSwitchListDTO
		if err := ctx.getJSON(cmd.Context(), profileSwitchCLIPath(id)+"es", &out); err != nil {
			return err
		}
		if jsonOutput {
			return writeJSON(cmd.OutOrStdout(), out)
		}
		return writeCodexProfileSwitchList(cmd, out.Switches)
	}}
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output operations as JSON")
	return cmd
}

func newSessionProfileSwitchCancelCommand(ctx *commandContext) *cobra.Command {
	var jsonOutput bool
	cmd := &cobra.Command{Use: "cancel <session-id> <switch-id>", Short: "Cancel before source shutdown", Args: usageArgs(cobra.ExactArgs(2)), RunE: func(cmd *cobra.Command, args []string) error {
		return ctx.controlCodexProfileSwitch(cmd.Context(), cmd, args, "cancel", jsonOutput)
	}}
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output the operation as JSON")
	return cmd
}

func newSessionProfileSwitchRecoverCommand(ctx *commandContext) *cobra.Command {
	var restoreSource, jsonOutput bool
	cmd := &cobra.Command{Use: "recover <session-id> <switch-id>", Short: "Recover an interrupted profile switch", Args: usageArgs(cobra.ExactArgs(2)), RunE: func(cmd *cobra.Command, args []string) error {
		action := "recover"
		if restoreSource {
			action = "restore-source"
		}
		return ctx.controlCodexProfileSwitch(cmd.Context(), cmd, args, action, jsonOutput)
	}}
	cmd.Flags().BoolVar(&restoreSource, "restore-source", false, "Restore the predecessor instead of retrying the target")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output the operation as JSON")
	return cmd
}

func (c *commandContext) controlCodexProfileSwitch(ctx context.Context, cmd *cobra.Command, args []string, action string, jsonOutput bool) error {
	id, err := normalizeSessionID(args[0])
	if err != nil {
		return err
	}
	switchID := strings.TrimSpace(args[1])
	if switchID == "" {
		return usageError{errors.New("switch id is required")}
	}
	var out codexProfileSwitchResponseDTO
	path := profileSwitchCLIPath(id) + "es/" + url.PathEscape(switchID) + "/" + action
	if err := c.postJSON(ctx, path, struct{}{}, &out); err != nil {
		return err
	}
	return writeCodexProfileSwitch(cmd, out, jsonOutput)
}

func profileSwitchCLIPath(sessionID string) string {
	return "sessions/" + url.PathEscape(sessionID) + "/profile-switch"
}

func writeCodexProfileSwitchOptions(cmd *cobra.Command, options codexProfileSwitchOptionsDTO) error {
	if len(options.Candidates) == 0 {
		_, err := fmt.Fprintln(cmd.OutOrStdout(), "(no profile-switch candidates)")
		return err
	}
	tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "ID\tLABEL\tAUTH\tCAPACITY\tUSED\tRECOMMENDED\tSELECTABLE\tREASON"); err != nil {
		return err
	}
	for _, candidate := range options.Candidates {
		used := "—"
		if candidate.Capacity.UsedPercent != nil {
			used = fmt.Sprintf("%g%%", *candidate.Capacity.UsedPercent)
		}
		if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%t\t%t\t%s\n", candidate.ID, candidate.Label, candidate.Authentication.State, candidate.Capacity.State, used, candidate.Recommended, candidate.Selectable, candidate.ReasonCode); err != nil {
			return err
		}
	}
	return tw.Flush()
}

func writeCodexProfileSwitchList(cmd *cobra.Command, switches []codexProfileSwitchDTO) error {
	if len(switches) == 0 {
		_, err := fmt.Fprintln(cmd.OutOrStdout(), "(no profile switches)")
		return err
	}
	tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "ID\tSOURCE\tTARGET PROFILE\tTARGET SESSION\tTRIGGER\tPHASE\tUPDATED"); err != nil {
		return err
	}
	for _, sw := range switches {
		target := "—"
		if sw.TargetSessionID != nil {
			target = *sw.TargetSessionID
		}
		if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", sw.ID, sw.SourceSessionID, sw.TargetProfileID, target, sw.Trigger, sw.Phase, sw.UpdatedAt.Format(time.RFC3339)); err != nil {
			return err
		}
	}
	return tw.Flush()
}

func writeCodexProfileSwitch(cmd *cobra.Command, response codexProfileSwitchResponseDTO, jsonOutput bool) error {
	if jsonOutput {
		return writeJSON(cmd.OutOrStdout(), response)
	}
	_, err := fmt.Fprintf(cmd.OutOrStdout(), "switch: %s\nphase: %s\nsource: %s\ntarget profile: %s\n%s\n", response.Switch.ID, response.Switch.Phase, response.Switch.SourceSessionID, response.Switch.TargetProfileID, response.Switch.ProgressReason)
	return err
}
