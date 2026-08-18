package androidemulator

import (
	"context"
	"encoding/xml"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Bounds is a node's on-screen rectangle in device pixels, parsed from
// uiautomator's "[x1,y1][x2,y2]" bounds attribute format.
type Bounds struct {
	X1, Y1, X2, Y2 int
}

// UINode is one element of the on-screen UI hierarchy, framework-agnostic
// (this is an OS-level accessibility dump, not tied to React Native/Flutter/
// native specifically) -- confirmed against a real `adb shell uiautomator
// dump` capture during Phase A5 verification.
type UINode struct {
	Class       string   `json:"class"`
	ResourceID  string   `json:"resourceId,omitempty"`
	Text        string   `json:"text,omitempty"`
	ContentDesc string   `json:"contentDesc,omitempty"`
	Clickable   bool     `json:"clickable"`
	Bounds      Bounds   `json:"bounds"`
	Children    []UINode `json:"children,omitempty"`
}

type xmlHierarchy struct {
	Root xmlNode `xml:"node"`
}

type xmlNode struct {
	Class       string    `xml:"class,attr"`
	ResourceID  string    `xml:"resource-id,attr"`
	Text        string    `xml:"text,attr"`
	ContentDesc string    `xml:"content-desc,attr"`
	Clickable   string    `xml:"clickable,attr"`
	BoundsRaw   string    `xml:"bounds,attr"`
	Children    []xmlNode `xml:"node"`
}

// ParseUIHierarchy parses the raw output of `adb shell uiautomator dump`
// (read back from the device via `adb shell cat <path>`) into a structured
// tree.
//
// uiautomator sometimes fails transiently (confirmed during Phase A5
// verification, especially right after the device wakes/resumes) and prints
// "ERROR: ..." on stdout instead of XML; that's detected explicitly here so
// callers get a clear, actionable error rather than a confusing XML parse
// failure -- and so a caller knows this specific failure is worth retrying.
func ParseUIHierarchy(data []byte) (UINode, error) {
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "ERROR") {
		return UINode{}, fmt.Errorf("androidemulator: uiautomator dump failed (often transient, retry): %s", trimmed)
	}

	var h xmlHierarchy
	if err := xml.Unmarshal(data, &h); err != nil {
		return UINode{}, fmt.Errorf("androidemulator: parse ui hierarchy: %w", err)
	}
	return convertNode(h.Root), nil
}

func convertNode(n xmlNode) UINode {
	out := UINode{
		Class:       n.Class,
		ResourceID:  n.ResourceID,
		Text:        n.Text,
		ContentDesc: n.ContentDesc,
		Clickable:   n.Clickable == "true",
		Bounds:      parseBounds(n.BoundsRaw),
	}
	for _, c := range n.Children {
		out.Children = append(out.Children, convertNode(c))
	}
	return out
}

// parseBounds parses uiautomator's "[x1,y1][x2,y2]" format. A malformed or
// empty string yields the zero Bounds rather than an error -- a bounds
// parse failure on one node shouldn't fail the whole tree.
func parseBounds(raw string) Bounds {
	var b Bounds
	_, err := fmt.Sscanf(raw, "[%d,%d][%d,%d]", &b.X1, &b.Y1, &b.X2, &b.Y2)
	if err != nil {
		return Bounds{}
	}
	return b
}

// uiDumpDataPath lives under /data/local/tmp rather than /sdcard: it's
// always writable by the shell user without needing storage permissions
// (some system images restrict /sdcard access), and it isn't left visible to
// the running app.
const uiDumpDataPath = "/data/local/tmp/ao-ui-dump.xml"

const (
	uiInspectMaxAttempts = 3
	uiInspectRetryDelay  = 500 * time.Millisecond
)

// uiInspectDeps abstracts the two adb calls UIInspect needs, so the
// retry/error-classification logic (uiInspectWithDeps) is testable without a
// real device.
type uiInspectDeps struct {
	dump func(ctx context.Context) (output string, err error)
	cat  func(ctx context.Context) ([]byte, error)
}

// UIInspect runs `adb shell uiautomator dump` against the given device
// serial and parses the result. Retries on the known transient "null root
// node" failure (confirmed empirically during Phase A5 verification -- it
// happens especially right after the device wakes/resumes), since surfacing
// that on the first hit would make a simple "look at the screen" request
// unreliable.
func UIInspect(ctx context.Context, adbPath, serial string) (UINode, error) {
	deps := uiInspectDeps{
		dump: func(ctx context.Context) (string, error) {
			out, err := exec.CommandContext(ctx, adbPath, "-s", serial, "shell", "uiautomator", "dump", uiDumpDataPath).CombinedOutput()
			return string(out), err
		},
		cat: func(ctx context.Context) ([]byte, error) {
			return exec.CommandContext(ctx, adbPath, "-s", serial, "shell", "cat", uiDumpDataPath).Output()
		},
	}
	return uiInspectWithDeps(ctx, deps, uiInspectMaxAttempts, uiInspectRetryDelay)
}

func uiInspectWithDeps(ctx context.Context, deps uiInspectDeps, maxAttempts int, retryDelay time.Duration) (UINode, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		node, err := uiInspectOnce(ctx, deps)
		if err == nil {
			return node, nil
		}
		lastErr = err
		if attempt < maxAttempts-1 {
			time.Sleep(retryDelay)
		}
	}
	return UINode{}, lastErr
}

func uiInspectOnce(ctx context.Context, deps uiInspectDeps) (UINode, error) {
	dumpOut, err := deps.dump(ctx)
	if err != nil {
		return UINode{}, fmt.Errorf("androidemulator: uiautomator dump: %w", err)
	}
	if strings.Contains(dumpOut, "ERROR") {
		return UINode{}, fmt.Errorf("androidemulator: uiautomator dump failed: %s", strings.TrimSpace(dumpOut))
	}
	data, err := deps.cat(ctx)
	if err != nil {
		return UINode{}, fmt.Errorf("androidemulator: read ui dump: %w", err)
	}
	return ParseUIHierarchy(data)
}

// FindClickable returns every clickable node in the tree, depth-first,
// document order -- the set an agent would want when asked "what's tappable
// on screen".
func FindClickable(root UINode) []UINode {
	var out []UINode
	var walk func(UINode)
	walk = func(n UINode) {
		if n.Clickable {
			out = append(out, n)
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(root)
	return out
}
