package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/androidemulator"
)

// androidEmulatorStatusDTO mirrors controllers.AndroidEmulatorStatusResponse.
type androidEmulatorStatusDTO struct {
	State          string   `json:"state"`
	Error          string   `json:"error,omitempty"`
	Logs           []string `json:"logs,omitempty"`
	AccelAvailable bool     `json:"accelAvailable"`
	AccelDetail    string   `json:"accelDetail,omitempty"`
}

// androidInputActionDTO mirrors controllers.AndroidInputActionRequest.
type androidInputActionDTO struct {
	Type string `json:"type"`
	X    int32  `json:"x,omitempty"`
	Y    int32  `json:"y,omitempty"`
	X2   int32  `json:"x2,omitempty"`
	Y2   int32  `json:"y2,omitempty"`
	Key  string `json:"key,omitempty"`
	Text string `json:"text,omitempty"`
}

// androidUIBoundsDTO mirrors controllers.AndroidUIBounds.
type androidUIBoundsDTO struct {
	X1 int `json:"x1"`
	Y1 int `json:"y1"`
	X2 int `json:"x2"`
	Y2 int `json:"y2"`
}

// androidUINodeDTO mirrors controllers.AndroidUINode.
type androidUINodeDTO struct {
	Class       string             `json:"class"`
	ResourceID  string             `json:"resourceId,omitempty"`
	Text        string             `json:"text,omitempty"`
	ContentDesc string             `json:"contentDesc,omitempty"`
	Clickable   bool               `json:"clickable"`
	Bounds      androidUIBoundsDTO `json:"bounds"`
	Children    []androidUINodeDTO `json:"children,omitempty"`
}

// androidEmulatorUntrustedBegin/End wrap text pulled from the running app's
// own screen (UI text, content descriptions) the same way `ao browser`
// fences page-controlled text: on-screen app content is untrusted external
// input from the agent's perspective, not an AO-authored instruction, even
// though it arrives via a trusted AO tool.
const (
	androidEmulatorUntrustedBegin = "<<<BEGIN UNTRUSTED EXTERNAL CONTENT>>>"
	androidEmulatorUntrustedEnd   = "<<<END UNTRUSTED EXTERNAL CONTENT>>>"
)

func androidEmulatorUntrustedText(value string) string {
	value = strings.ReplaceAll(value, androidEmulatorUntrustedBegin, `<`+androidEmulatorUntrustedBegin[1:])
	value = strings.ReplaceAll(value, androidEmulatorUntrustedEnd, `<`+androidEmulatorUntrustedEnd[1:])
	return androidEmulatorUntrustedBegin + "\n" + value + "\n" + androidEmulatorUntrustedEnd
}

func newEmulatorCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "emulator",
		Short: "Inspect and control AO's single, shared Android emulator (agent + human tooling)",
		Long: "Inspect and control AO's managed Android emulator: boot lifecycle, screen capture,\n" +
			"structured UI inspection, and input injection (tap/swipe/type/key). This is the\n" +
			"same device every AO session sees -- like one physical phone shared across sessions.",
	}

	var statusJSON bool
	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show the emulator's lifecycle state (uninitialized/booting/running/crashed/stopping)",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			status, err := ctx.emulatorDeviceStatus(cmd.Context())
			if err != nil {
				return err
			}
			return writeEmulatorStatus(cmd.OutOrStdout(), status, statusJSON)
		},
	}
	statusCmd.Flags().BoolVar(&statusJSON, "json", false, "print JSON")
	cmd.AddCommand(statusCmd)

	cmd.AddCommand(&cobra.Command{
		Use:   "start",
		Short: "Boot the emulator (no-op if already running)",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			status, err := ctx.emulatorStart(cmd.Context())
			if err != nil {
				return err
			}
			return writeEmulatorStatus(cmd.OutOrStdout(), status, false)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "stop",
		Short: "Stop the emulator, if running",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			status, err := ctx.emulatorStop(cmd.Context())
			if err != nil {
				return err
			}
			return writeEmulatorStatus(cmd.OutOrStdout(), status, false)
		},
	})

	var screenshotOut string
	screenshotCmd := &cobra.Command{
		Use:   "screenshot",
		Short: "Capture a single on-demand PNG of the current screen",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			path, err := ctx.emulatorScreenshot(cmd.Context(), screenshotOut)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "Screenshot saved to %s\n", path)
			return err
		},
	}
	screenshotCmd.Flags().StringVar(&screenshotOut, "out", "", "output path (default: a new temp file)")
	cmd.AddCommand(screenshotCmd)

	var uiTreeJSON bool
	uiTreeCmd := &cobra.Command{
		Use:   "inspect-ui",
		Short: "Print the current on-screen UI hierarchy (structured, not a flat image)",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			tree, err := ctx.emulatorInspectUI(cmd.Context())
			if err != nil {
				return err
			}
			return writeEmulatorUITree(cmd.OutOrStdout(), tree, uiTreeJSON)
		},
	}
	uiTreeCmd.Flags().BoolVar(&uiTreeJSON, "json", false, "print JSON")
	cmd.AddCommand(uiTreeCmd)

	cmd.AddCommand(&cobra.Command{
		Use:   "tap <x> <y>",
		Short: "Tap a point on the screen",
		Args:  exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			x, y, err := parseXY(args[0], args[1])
			if err != nil {
				return err
			}
			return ctx.emulatorInput(cmd.Context(), androidInputActionDTO{Type: "tap", X: x, Y: y})
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "swipe <x1> <y1> <x2> <y2>",
		Short: "Swipe from one point to another",
		Args:  exactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) error {
			x1, y1, err := parseXY(args[0], args[1])
			if err != nil {
				return err
			}
			x2, y2, err := parseXY(args[2], args[3])
			if err != nil {
				return err
			}
			return ctx.emulatorInput(cmd.Context(), androidInputActionDTO{Type: "swipe", X: x1, Y: y1, X2: x2, Y2: y2})
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "type <text>",
		Short: "Type text, one character at a time",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.emulatorInput(cmd.Context(), androidInputActionDTO{Type: "text", Text: args[0]})
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "press-key <key>",
		Short: "Press a named key (e.g. Home, Back)",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.emulatorInput(cmd.Context(), androidInputActionDTO{Type: "key", Key: args[0]})
		},
	})

	var findSourceJSON bool
	findSourceCmd := &cobra.Command{
		Use:   "find-source <identifier>",
		Short: "Search the current directory tree for files referencing a resource-id, testID, or text",
		Long: "Search downward from the current working directory for source files (XML/Kotlin/\n" +
			"Java/JS/TS/Dart) referencing the given identifier -- a resource-id (e.g.\n" +
			"\"android:id/aerr_close\"), a React Native testID, or visible on-screen text.\n\n" +
			"This is a heuristic best-effort match (plain substring search), not a guaranteed-\n" +
			"exact symbolication. Run this from inside the session's worktree.",
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			matches, err := androidemulator.FindSource(cmd.Context(), cwd, args[0])
			if err != nil {
				return err
			}
			return writeEmulatorSourceMatches(cmd.OutOrStdout(), matches, findSourceJSON)
		},
	}
	findSourceCmd.Flags().BoolVar(&findSourceJSON, "json", false, "print JSON")
	cmd.AddCommand(findSourceCmd)

	return cmd
}

func parseXY(xs, ys string) (int32, int32, error) {
	x, err := strconv.ParseInt(xs, 10, 32)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid x %q: %w", xs, err)
	}
	y, err := strconv.ParseInt(ys, 10, 32)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid y %q: %w", ys, err)
	}
	return int32(x), int32(y), nil
}

func (c *commandContext) emulatorDeviceStatus(ctx context.Context) (androidEmulatorStatusDTO, error) {
	var out androidEmulatorStatusDTO
	err := c.doJSONPath(ctx, http.MethodGet, "/api/v1/android-device/status", nil, &out)
	return out, err
}

func (c *commandContext) emulatorStart(ctx context.Context) (androidEmulatorStatusDTO, error) {
	var out androidEmulatorStatusDTO
	err := c.doJSONPath(ctx, http.MethodPost, "/api/v1/android-device/start", nil, &out)
	return out, err
}

func (c *commandContext) emulatorStop(ctx context.Context) (androidEmulatorStatusDTO, error) {
	var out androidEmulatorStatusDTO
	err := c.doJSONPath(ctx, http.MethodPost, "/api/v1/android-device/stop", nil, &out)
	return out, err
}

func (c *commandContext) emulatorInput(ctx context.Context, action androidInputActionDTO) error {
	return c.doJSONPath(ctx, http.MethodPost, "/api/v1/android-device/input", action, nil)
}

func (c *commandContext) emulatorInspectUI(ctx context.Context) (androidUINodeDTO, error) {
	var out androidUINodeDTO
	err := c.doJSONPath(ctx, http.MethodGet, "/api/v1/android-device/ui-tree", nil, &out)
	return out, err
}

func (c *commandContext) emulatorScreenshot(ctx context.Context, outPath string) (string, error) {
	data, err := c.doRawBytes(ctx, http.MethodGet, "/api/v1/android-device/screenshot")
	if err != nil {
		return "", err
	}
	if outPath == "" {
		f, err := os.CreateTemp("", "ao-emulator-screenshot-*.png")
		if err != nil {
			return "", err
		}
		outPath = f.Name()
		if _, err := f.Write(data); err != nil {
			f.Close()
			return "", err
		}
		if err := f.Close(); err != nil {
			return "", err
		}
		return outPath, nil
	}
	if err := os.WriteFile(outPath, data, 0o644); err != nil {
		return "", err
	}
	return outPath, nil
}

func writeEmulatorStatus(w io.Writer, status androidEmulatorStatusDTO, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(status)
	}
	fmt.Fprintf(w, "state: %s\n", status.State)
	fmt.Fprintf(w, "hardware acceleration: %v", status.AccelAvailable)
	if status.AccelDetail != "" {
		fmt.Fprintf(w, " (%s)", status.AccelDetail)
	}
	fmt.Fprintln(w)
	if status.Error != "" {
		fmt.Fprintf(w, "error: %s\n", status.Error)
	}
	return nil
}

func writeEmulatorUITree(w io.Writer, tree androidUINodeDTO, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(tree)
	}
	var b strings.Builder
	writeUINodeTree(&b, tree, 0)
	_, err := fmt.Fprintln(w, androidEmulatorUntrustedText(strings.TrimRight(b.String(), "\n")))
	return err
}

func writeUINodeTree(b *strings.Builder, n androidUINodeDTO, depth int) {
	fmt.Fprint(b, strings.Repeat("  ", depth))
	fmt.Fprintf(b, "- %s", n.Class)
	if n.Text != "" {
		fmt.Fprintf(b, " text=%q", n.Text)
	}
	if n.ResourceID != "" {
		fmt.Fprintf(b, " id=%q", n.ResourceID)
	}
	if n.Clickable {
		fmt.Fprint(b, " [clickable]")
	}
	fmt.Fprintln(b)
	for _, c := range n.Children {
		writeUINodeTree(b, c, depth+1)
	}
}

func writeEmulatorSourceMatches(w io.Writer, matches []androidemulator.SourceMatch, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(matches)
	}
	if len(matches) == 0 {
		_, err := fmt.Fprintln(w, "No matches found.")
		return err
	}
	for _, m := range matches {
		if _, err := fmt.Fprintf(w, "%s:%d: %s\n", m.Path, m.Line, androidEmulatorUntrustedText(m.Text)); err != nil {
			return err
		}
	}
	return nil
}
