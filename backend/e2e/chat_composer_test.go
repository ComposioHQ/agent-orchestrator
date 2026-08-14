//go:build !windows

package e2e

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Scenarios for the composer's completions.
//
// The composer draws a slash menu from what the provider reports and an attachment
// chip from what actually reached the worktree. Both are claims about the outside
// world, so the failure these look for is a menu or a chip that promises something
// the provider or the filesystem will not honour.

// The skill catalog has to come from the provider, because it is assembled from the
// user's own config and the repo's own files — neither of which AO is told about.
func TestChatSkillsComeFromTheProvider(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "skills")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	var catalog struct {
		Skills []struct {
			Name        string `json:"name"`
			DisplayName string `json:"displayName"`
			Description string `json:"description"`
			Source      string `json:"source"`
		} `json:"skills"`
	}
	d.mustCall("GET", "/sessions/"+session+"/conversation/skills", http.StatusOK, nil, &catalog)

	// An empty catalog is a legitimate answer on a machine with no skills installed,
	// and the composer treats it as "leave `/` alone". What must never happen is a
	// row that cannot be rendered or invoked.
	if len(catalog.Skills) == 0 {
		t.Skip("provider reported no skills on this machine; nothing to assert about rows")
	}

	seen := map[string]bool{}
	for _, skill := range catalog.Skills {
		if skill.Name == "" {
			t.Errorf("skill %+v has no name, so nothing could be inserted for it", skill)
		}
		if skill.DisplayName == "" {
			t.Errorf("skill %q has no label, so its menu row would render blank", skill.Name)
		}
		// The menu keys on name. A duplicate would put the same command in the list
		// twice with no way for the user to tell them apart.
		if seen[skill.Name] {
			t.Errorf("skill %q reported twice", skill.Name)
		}
		seen[skill.Name] = true
		if strings.ContainsAny(skill.Name, " \t\n") {
			// The composer inserts `/<name>`; whitespace in it would split into an
			// argument the provider never receives as part of the command.
			t.Errorf("skill name %q contains whitespace", skill.Name)
		}
	}
}

// The endpoint has to answer for a session whose controller is running, and refuse
// in a way a client can branch on for one whose mode has no conversation at all.
func TestChatSkillsAreRefusedForATUISession(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "skillstui")

	tui := spawn(t, d, map[string]any{
		"projectId": project, "kind": "worker", "harness": "codex", "mode": "tui",
		"prompt": "do nothing",
	}).Session.ID

	status, body := d.callExpectingError("GET", "/sessions/"+tui+"/conversation/skills", nil)
	if status != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%+v)", status, body)
	}
	if body.Code != "SESSION_MODE_MISMATCH" {
		t.Errorf("code = %q, want SESSION_MODE_MISMATCH", body.Code)
	}
}

// An attachment chip claims the image is somewhere the agent can open. That is only
// true if staging wrote it into the worktree AND the agent can actually read it, so
// this drives the whole path rather than only the endpoint.
func TestChatAttachmentIsStagedIntoTheWorktreeAndReadableByTheAgent(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "attachments")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	// A 1x1 PNG. Small enough to inline, real enough to be a valid image.
	const onePixelPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

	var staged struct {
		SessionID string   `json:"sessionId"`
		Paths     []string `json:"paths"`
	}
	d.mustCall("POST", "/sessions/"+session+"/attachments", http.StatusCreated,
		map[string]any{"attachments": []map[string]any{{"mimeType": "image/png", "data": onePixelPNG}}},
		&staged)

	if len(staged.Paths) != 1 {
		t.Fatalf("staged %d paths, want 1: %+v", len(staged.Paths), staged.Paths)
	}
	path := staged.Paths[0]
	if !strings.HasPrefix(path, ".ao/attachments/") || !strings.HasSuffix(path, ".png") {
		t.Errorf("staged path = %q, want a .png under .ao/attachments/", path)
	}

	// Names must not collide across messages: a chat session attaches repeatedly, and
	// reusing a name would rewrite the image an earlier message still points at.
	var second struct {
		Paths []string `json:"paths"`
	}
	d.mustCall("POST", "/sessions/"+session+"/attachments", http.StatusCreated,
		map[string]any{"attachments": []map[string]any{{"mimeType": "image/png", "data": onePixelPNG}}},
		&second)
	if len(second.Paths) != 1 || second.Paths[0] == path {
		t.Errorf("second staging reused the path %q, overwriting the first image", path)
	}

	// The claim the chip makes, tested against the agent rather than the filesystem.
	send(t, d, session,
		"Run `test -f "+path+" && echo FOUND || echo MISSING` and reply with its exact output.",
		"attach-read")
	snap := d.awaitConversation(session, 3*time.Minute, "the agent to look for the image",
		func(s snapshot) bool { return terminal(s.Turns[len(s.Turns)-1].State) })
	if !contains(snap.assistantText(), "FOUND") {
		t.Fatalf("the agent could not see the staged image at %s:\n%s", path, describe(snap))
	}

	// The images must not dirty the worktree: AO derives session state from durable
	// git facts, and an attachment that reads as an uncommitted change would make a
	// clean session look like it has work in it.
	var files struct {
		Files []struct {
			Path   string `json:"path"`
			Status string `json:"status"`
		} `json:"files"`
	}
	d.mustCall("GET", "/sessions/"+session+"/workspace/files", http.StatusOK, nil, &files)
	for _, file := range files.Files {
		if strings.HasPrefix(file.Path, ".ao/attachments/") {
			t.Errorf("staged attachment %q shows up as a workspace change (%s)", file.Path, file.Status)
		}
	}
}

// The #3884 data-loss seam, driven end to end: an attachment staged before a
// daemon restart must still resolve — same preview URL, same bytes — after
// startup recovery has recreated the session's worktree, and the resumed agent
// must still be able to read the same .ao/attachments/... path its
// conversation history names.
func TestChatAttachmentSurvivesADaemonRestart(t *testing.T) {
	requireE2E(t)
	dataDir := t.TempDir()
	d := startDaemon(t, dataDir)
	project := seedProject(t, d, "attachrestart")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	const onePixelPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
	wantBytes, err := base64.StdEncoding.DecodeString(onePixelPNG)
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	var staged struct {
		Paths []string `json:"paths"`
	}
	d.mustCall("POST", "/sessions/"+session+"/attachments", http.StatusCreated,
		map[string]any{"attachments": []map[string]any{{"mimeType": "image/png", "data": onePixelPNG}}},
		&staged)
	if len(staged.Paths) != 1 {
		t.Fatalf("staged %d paths, want 1: %+v", len(staged.Paths), staged.Paths)
	}
	path := staged.Paths[0]
	previewPath := "/sessions/" + session + "/preview/files/" + path

	if got := rawGET(t, d, previewPath); !bytes.Equal(got, wantBytes) {
		t.Fatalf("preview before restart returned %d bytes, want the staged image", len(got))
	}

	// The user quits the app; the next boot's recovery recreates the worktree.
	d.stop()
	restarted := startDaemon(t, dataDir)
	restarted.awaitLiveController(session, 3*time.Minute)

	// The same URL the durable conversation embeds must keep answering with the
	// original bytes — this is the request that returned PREVIEW_FILE_NOT_FOUND
	// before attachments had a durable owner.
	if got := rawGET(t, restarted, previewPath); !bytes.Equal(got, wantBytes) {
		t.Fatalf("preview after restart returned %d bytes, want the staged image", len(got))
	}

	// And the resumed agent can still open the path its history names.
	send(t, restarted, session,
		"Run `test -f "+path+" && echo FOUND || echo MISSING` and reply with its exact output.",
		"attach-restart-read")
	snap := restarted.awaitConversation(session, 3*time.Minute, "the resumed agent to look for the image",
		func(s snapshot) bool { return terminal(s.Turns[len(s.Turns)-1].State) })
	if !contains(snap.assistantText(), "FOUND") {
		t.Fatalf("the resumed agent could not see the restored image at %s:\n%s", path, describe(snap))
	}
}

// rawGET fetches an API path and returns the body bytes without assuming JSON,
// which is what an <img> tag does with a preview URL.
func rawGET(t *testing.T, d *daemon, path string) []byte {
	t.Helper()
	res, err := httpClient.Get(d.baseURL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d: %s\n%s", path, res.StatusCode, body, d.tailLog())
	}
	return body
}
