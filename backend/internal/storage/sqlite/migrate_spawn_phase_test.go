package sqlite

import (
	"testing"
	"time"
)

// The upgrade promise for the spawn phase: an existing database must come out
// describing exactly what it already contained. A session with a controller is
// finished spawning; a live session that never recorded one is an abandoned
// attempt the reconciler should finish or clean up; and a terminated row is
// closed history that must not be re-reconciled at all.
func TestMigration0128ClassifiesExistingSessionsByControllerIdentity(t *testing.T) {
	db := openTestDB(t)
	upTo(t, db, 127)

	now := time.Now().UTC()
	if _, err := db.Exec(`INSERT INTO projects (id, path, display_name, registered_at)
		VALUES ('p1', '/tmp/p1', 'proj', ?)`, now); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	seed := func(id string, num int, terminated int, handle, launch, generation, agentSession, providerConv string) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO sessions
			(id, project_id, num, kind, activity_state, activity_last_at, is_terminated,
			 runtime_handle_id, runtime_launch_id, controller_generation,
			 agent_session_id, provider_conversation_id, created_at, updated_at)
			VALUES (?, 'p1', ?, 'worker', 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, num, now, terminated, handle, launch, generation, agentSession, providerConv, now, now); err != nil {
			t.Fatalf("seed session %s: %v", id, err)
		}
	}
	seed("tui-live", 1, 0, "tmux-1", "launch-1", "", "", "")
	seed("chat-live", 2, 0, "", "", "gen-1", "", "")
	seed("abandoned", 3, 0, "", "", "", "", "")
	seed("terminated-handleless", 4, 1, "", "", "", "", "")
	// CommitSessionControllerEpoch clears all three process handles together on a
	// live row mid interface transition. These rows look like seeds but name a
	// conversation, so they must not be classified as abandoned spawns.
	seed("mid-transition-native", 5, 0, "", "", "", "agent-5", "")
	seed("mid-transition-provider", 6, 0, "", "", "", "", "thread-6")

	upTo(t, db, 128)

	want := map[string]string{
		"tui-live":              "controller_ready",
		"chat-live":             "controller_ready",
		"abandoned":             "preparing",
		"terminated-handleless": "controller_ready",

		"mid-transition-native":   "controller_ready",
		"mid-transition-provider": "controller_ready",
	}
	rows, err := db.Query(`SELECT id, spawn_phase FROM sessions ORDER BY id`)
	if err != nil {
		t.Fatalf("query sessions: %v", err)
	}
	defer func() { _ = rows.Close() }()
	seen := 0
	for rows.Next() {
		var id, phase string
		if err := rows.Scan(&id, &phase); err != nil {
			t.Fatalf("scan: %v", err)
		}
		seen++
		if phase != want[id] {
			t.Errorf("session %s migrated to phase %q, want %q", id, phase, want[id])
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if seen != len(want) {
		t.Fatalf("classified %d sessions, want %d", seen, len(want))
	}
}
