package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

type agentListOptions struct {
	refresh bool
	json    bool
}

// agentInfo mirrors the daemon's agent Info body for the CLI client.
type agentInfo struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	AuthStatus string `json:"authStatus,omitempty"`
}

// agentInventory mirrors GET /api/v1/agents and POST /api/v1/agents/refresh.
type agentInventory struct {
	Supported  []agentInfo `json:"supported"`
	Installed  []agentInfo `json:"installed"`
	Authorized []agentInfo `json:"authorized"`
}

type agentReadinessObservation struct {
	State       string  `json:"state"`
	Freshness   string  `json:"freshness"`
	CheckedAt   *string `json:"checkedAt,omitempty"`
	AttemptedAt *string `json:"attemptedAt,omitempty"`
	ReasonCode  string  `json:"reasonCode"`
	Reason      string  `json:"reason"`
}

type agentReadinessSnapshot struct {
	ID                 string                    `json:"id"`
	Label              string                    `json:"label"`
	Installation       agentReadinessObservation `json:"installation"`
	Authentication     agentReadinessObservation `json:"authentication"`
	EffectiveReadiness string                    `json:"effectiveReadiness"`
	UsageCount         int                       `json:"usageCount"`
	LastUsedAt         *string                   `json:"lastUsedAt,omitempty"`
}

type agentReadinessResponse struct {
	Agents []agentReadinessSnapshot `json:"agents"`
}

type ensureAgentReadinessRequest struct {
	AgentIDs []string `json:"agentIds,omitempty"`
	Purpose  string   `json:"purpose"`
}

func newAgentCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "agent",
		Short: "Inspect agent catalog readiness",
	}
	cmd.AddCommand(newAgentListCommand(ctx))
	cmd.AddCommand(newAgentProfileCommand(ctx))
	return cmd
}

type codexProfileCapacityCLI struct {
	State             string            `json:"state"`
	Freshness         string            `json:"freshness"`
	Plan              *string           `json:"plan,omitempty"`
	UsedPercent       *float64          `json:"usedPercent,omitempty"`
	ResetsAt          *string           `json:"resetsAt,omitempty"`
	ObservedAt        *string           `json:"observedAt,omitempty"`
	CheckedAt         *string           `json:"checkedAt,omitempty"`
	AttemptedAt       *string           `json:"attemptedAt,omitempty"`
	ReasonCode        string            `json:"reasonCode"`
	Reason            string            `json:"reason"`
	Overall           json.RawMessage   `json:"overall,omitempty"`
	AdditionalBuckets []json.RawMessage `json:"additionalBuckets"`
}

type codexProfileCLI struct {
	ID                      string                    `json:"id"`
	Label                   string                    `json:"label"`
	Source                  string                    `json:"source"`
	Status                  string                    `json:"status"`
	ReasonCode              string                    `json:"reasonCode"`
	Reason                  string                    `json:"reason"`
	Authentication          agentReadinessObservation `json:"authentication"`
	AuthMethod              string                    `json:"authMethod"`
	AccountEmail            *string                   `json:"accountEmail,omitempty"`
	UsableByCurrentLaunches bool                      `json:"usableByCurrentLaunches"`
	Capacity                codexProfileCapacityCLI   `json:"capacity"`
}

type codexProfilesCLIResponse struct {
	Profiles     []codexProfileCLI          `json:"profiles"`
	Capabilities map[string]json.RawMessage `json:"capabilities"`
}

func newAgentProfileCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "profile", Short: "Inspect Codex profiles"}
	cmd.AddCommand(newAgentProfileListCommand(ctx))
	return cmd
}

func newAgentProfileListCommand(ctx *commandContext) *cobra.Command {
	var jsonOutput bool
	cmd := &cobra.Command{
		Use: "ls", Aliases: []string{"list"}, Short: "List Codex profiles and subscription capacity", Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			profiles, err := ctx.fetchCodexProfileCapacity(cmd.Context())
			if err != nil {
				return err
			}
			if jsonOutput {
				return writeJSON(cmd.OutOrStdout(), profiles)
			}
			return writeCodexProfileList(cmd, profiles)
		},
	}
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output raw Codex profile JSON")
	return cmd
}

func (c *commandContext) fetchCodexProfileCapacity(ctx context.Context) (codexProfilesCLIResponse, error) {
	var result codexProfilesCLIResponse
	if err := c.postJSON(ctx, "agents/codex/profiles/capacity/ensure", struct {
		ProfileIDs []string `json:"profileIds,omitempty"`
	}{}, &result); err != nil {
		return codexProfilesCLIResponse{}, err
	}
	return result, nil
}

func writeCodexProfileList(cmd *cobra.Command, response codexProfilesCLIResponse) error {
	tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "ID\tLABEL\tSOURCE\tAUTH\tPLAN\tCAPACITY\tUSED\tRESET\tFRESHNESS"); err != nil {
		return err
	}
	for _, profile := range response.Profiles {
		plan, used, reset := "—", "—", "—"
		if profile.Capacity.Plan != nil && *profile.Capacity.Plan != "" {
			plan = *profile.Capacity.Plan
		}
		if profile.Capacity.UsedPercent != nil {
			used = fmt.Sprintf("%g%%", *profile.Capacity.UsedPercent)
		}
		if profile.Capacity.ResetsAt != nil && *profile.Capacity.ResetsAt != "" {
			reset = *profile.Capacity.ResetsAt
		}
		auth := profile.Authentication.State
		if auth == "" {
			auth = "unknown"
		}
		capacity := profile.Capacity.State
		if capacity == "" {
			capacity = "unknown"
		}
		freshness := profile.Capacity.Freshness
		if freshness == "" {
			freshness = "stale"
		}
		if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", profile.ID, profile.Label, profile.Source, auth, plan, capacity, used, reset, freshness); err != nil {
			return err
		}
	}
	return tw.Flush()
}

func newAgentListCommand(ctx *commandContext) *cobra.Command {
	var opts agentListOptions
	cmd := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "List supported agents and local auth readiness",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			inv, err := ctx.fetchAgentInventory(cmd.Context())
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), inv)
			}
			return writeAgentList(cmd, inv)
		},
	}
	cmd.Flags().BoolVar(&opts.refresh, "refresh", false, "Deprecated: readiness is always ensured before listing")
	_ = cmd.Flags().MarkHidden("refresh")
	_ = cmd.Flags().MarkDeprecated("refresh", "readiness is always ensured before listing")
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output raw agent catalog JSON")
	return cmd
}

func readinessInventory(readiness agentReadinessResponse) agentInventory {
	inv := agentInventory{Supported: make([]agentInfo, 0, len(readiness.Agents)), Installed: []agentInfo{}, Authorized: []agentInfo{}}
	for _, snapshot := range readiness.Agents {
		authStatus := snapshot.Authentication.State
		if authStatus == "not_applicable" {
			authStatus = "authorized"
		}
		info := agentInfo{ID: snapshot.ID, Label: snapshot.Label, AuthStatus: authStatus}
		inv.Supported = append(inv.Supported, info)
		if snapshot.Installation.State == "installed" {
			inv.Installed = append(inv.Installed, info)
		}
		if snapshot.Authentication.State == "authorized" || snapshot.Authentication.State == "not_applicable" {
			inv.Authorized = append(inv.Authorized, info)
		}
	}
	return inv
}

func writeAgentList(cmd *cobra.Command, inv agentInventory) error {
	out := cmd.OutOrStdout()
	if len(inv.Supported) == 0 {
		_, err := fmt.Fprintln(out, "No agents supported by this daemon.")
		return err
	}

	sort.Slice(inv.Supported, func(i, j int) bool {
		return inv.Supported[i].ID < inv.Supported[j].ID
	})
	installed := agentInfoByID(inv.Installed)
	authorized := agentInfoByID(inv.Authorized)

	tw := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "ID\tLABEL\tINSTALL\tAUTH"); err != nil {
		return err
	}
	for _, info := range inv.Supported {
		installLabel := "needs install"
		authLabel := "auth unknown"
		if installedInfo, ok := installed[info.ID]; ok {
			installLabel = "installed"
			switch installedInfo.AuthStatus {
			case "authorized":
				authLabel = "authorized"
			case "unauthorized":
				authLabel = "needs auth"
			default:
				authLabel = "auth unknown"
			}
		}
		if _, ok := authorized[info.ID]; ok {
			installLabel = "installed"
			authLabel = "authorized"
		}
		if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", info.ID, info.Label, installLabel, authLabel); err != nil {
			return err
		}
	}
	return tw.Flush()
}

func agentInfoByID(infos []agentInfo) map[string]agentInfo {
	out := make(map[string]agentInfo, len(infos))
	for _, info := range infos {
		out[info.ID] = info
	}
	return out
}
