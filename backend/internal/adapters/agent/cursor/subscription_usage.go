package cursor

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const cursorSubscriptionUsageTimeout = 20 * time.Second

type cursorUsagePlugin interface {
	ResolveBinary(context.Context) (string, error)
	AuthStatus(context.Context) (ports.AgentAuthStatus, error)
}

type cursorBuildReader func(context.Context, string) (string, error)
type cursorUsageClientFactory func(string, string, string, usageCommandRunner) (cursorUsageClient, error)

// SubscriptionUsageReader reads Cursor's local authenticated dashboard model
// without opening an AO session or retaining raw provider output.
type SubscriptionUsageReader struct {
	plugin        cursorUsagePlugin
	readBuild     cursorBuildReader
	newClient     cursorUsageClientFactory
	runtimeDir    string
	now           func() time.Time
	commandRunner usageCommandRunner
}

// NewSubscriptionUsageReader creates the daemon-owned Cursor capacity reader.
func NewSubscriptionUsageReader(plugin cursorUsagePlugin) *SubscriptionUsageReader {
	return &SubscriptionUsageReader{
		plugin: plugin, readBuild: readCursorBuild, newClient: newCursorUsageClient,
		runtimeDir: cursorUsageRuntimeDirectory(), now: func() time.Time { return time.Now().UTC() },
	}
}

// ReadSubscriptionUsage returns only normalized, display-safe usage fields.
func (r *SubscriptionUsageReader) ReadSubscriptionUsage(ctx context.Context) (ports.SubscriptionUsageObservation, error) {
	if r == nil || r.plugin == nil || strings.TrimSpace(os.Getenv("CURSOR_API_KEY")) != "" {
		return ports.SubscriptionUsageObservation{}, ports.ErrSubscriptionUsageUnsupported
	}
	binary, err := r.plugin.ResolveBinary(ctx)
	if err != nil {
		if errors.Is(err, ports.ErrAgentBinaryNotFound) {
			return ports.SubscriptionUsageObservation{}, ports.ErrSubscriptionUsageUnsupported
		}
		return ports.SubscriptionUsageObservation{}, err
	}
	auth, err := r.plugin.AuthStatus(ctx)
	if err != nil {
		return ports.SubscriptionUsageObservation{}, err
	}
	if auth != ports.AgentAuthStatusAuthorized {
		return ports.SubscriptionUsageObservation{}, ports.ErrSubscriptionUsageUnsupported
	}
	build, err := r.readBuild(ctx, binary)
	if err != nil {
		return ports.SubscriptionUsageObservation{}, err
	}
	client, err := r.newClient(binary, build, r.runtimeDir, r.commandRunner)
	if err != nil {
		if errors.Is(err, errCursorUsageBuildUnsupported) {
			return ports.SubscriptionUsageObservation{}, ports.ErrSubscriptionUsageUnsupported
		}
		return ports.SubscriptionUsageObservation{}, err
	}
	readCtx, cancel := context.WithTimeout(ctx, cursorSubscriptionUsageTimeout)
	defer cancel()
	raw, err := client.ReadUsage(readCtx)
	if err != nil {
		return ports.SubscriptionUsageObservation{}, err
	}
	return normalizeCursorSubscriptionUsage(raw, r.now())
}

func normalizeCursorSubscriptionUsage(raw rawCursorUsage, observedAt time.Time) (ports.SubscriptionUsageObservation, error) {
	if observedAt.IsZero() {
		return ports.SubscriptionUsageObservation{}, errors.New("cursor usage observation time is required")
	}
	reset := parseCursorResetLabel(raw.ResetLabel, observedAt)
	limits := make([]domain.SubscriptionUsageLimit, 0, 4)
	if raw.Included != nil {
		for _, entry := range []struct {
			id   string
			name string
			used *float64
		}{
			{"included", "Included", raw.Included.TotalPercentUsed},
			{"auto", "Auto", raw.Included.AutoPercentUsed},
			{"api", "API", raw.Included.APIPercentUsed},
		} {
			if entry.used == nil {
				continue
			}
			used := clampPercentage(*entry.used)
			remaining := 100 - used
			limits = append(limits, domain.SubscriptionUsageLimit{
				ID: entry.id, Name: entry.name, State: domain.SubscriptionLimitActive,
				UsedPercent: &used, RemainingPercent: &remaining, ResetsAt: reset,
			})
		}
	}
	if raw.OnDemand != nil {
		limit := domain.SubscriptionUsageLimit{ID: "on_demand", Name: "On-Demand", Unit: "USD"}
		if raw.OnDemand.UsedDollars != nil && *raw.OnDemand.UsedDollars >= 0 {
			value := *raw.OnDemand.UsedDollars
			limit.UsedValue = &value
		}
		switch raw.OnDemand.Kind {
		case "fixed":
			limit.State = domain.SubscriptionLimitActive
			total := math.Max(0, *raw.OnDemand.LimitDollars)
			used := math.Max(0, *raw.OnDemand.UsedDollars)
			remaining := math.Max(0, total-used)
			limit.UsedValue, limit.TotalValue, limit.RemainingValue = &used, &total, &remaining
			if total > 0 {
				usedPercent := clampPercentage(used / total * 100)
				remainingPercent := 100 - usedPercent
				limit.UsedPercent, limit.RemainingPercent = &usedPercent, &remainingPercent
			}
		case "unlimited":
			limit.State = domain.SubscriptionLimitUnlimited
		case "disabled":
			limit.State = domain.SubscriptionLimitDisabled
		case "unavailable":
			limit.State = domain.SubscriptionLimitUnavailable
		default:
			return ports.SubscriptionUsageObservation{}, fmt.Errorf("unsupported Cursor on-demand usage state %q", raw.OnDemand.Kind)
		}
		limits = append(limits, limit)
	}
	if len(limits) == 0 {
		return ports.SubscriptionUsageObservation{}, errors.New("cursor usage contains no capacity categories")
	}
	plan := strings.TrimSpace(raw.PlanName)
	var planValue *string
	if plan != "" {
		planValue = &plan
	}
	return ports.SubscriptionUsageObservation{Plan: planValue, Limits: limits, ObservedAt: observedAt.UTC()}, nil
}

func clampPercentage(value float64) float64 { return math.Min(100, math.Max(0, value)) }

func parseCursorResetLabel(label string, observedAt time.Time) *time.Time {
	value := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(label), "Resets "))
	parsed, err := time.ParseInLocation("Jan 2 2006", value+" "+fmt.Sprint(observedAt.Year()), time.UTC)
	if err != nil {
		return nil
	}
	day := time.Date(observedAt.Year(), observedAt.Month(), observedAt.Day(), 0, 0, 0, 0, time.UTC)
	if parsed.Before(day) {
		parsed = parsed.AddDate(1, 0, 0)
	}
	return &parsed
}

func cursorUsageRuntimeDirectory() string {
	if configured := strings.TrimSpace(os.Getenv("AO_ACP_RUNTIME_DIR")); configured != "" {
		return configured
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	resources := filepath.Dir(filepath.Dir(executable))
	for _, candidate := range []string{filepath.Join(resources, "acp-runtime"), filepath.Join(resources, "resources", "acp-runtime")} {
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}
