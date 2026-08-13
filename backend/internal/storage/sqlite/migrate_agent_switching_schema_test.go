package sqlite

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMigration0085AgentSwitchIntegrityAndCDC(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 85)
	now := time.Date(2026, time.August, 5, 12, 0, 0, 0, time.UTC)
	if _, err := db.Exec(`
INSERT INTO projects (id, path, registered_at)
VALUES ('switch-schema', '/repos/switch-schema', ?);
INSERT INTO sessions (
    id, project_id, num, harness, activity_last_at, created_at, updated_at
) VALUES ('switch-session', 'switch-schema', 1, 'claude-code', ?, ?, ?);
INSERT INTO sessions (
    id, project_id, num, harness, activity_last_at, created_at, updated_at
) VALUES ('switch-error-session', 'switch-schema', 2, 'claude-code', ?, ?, ?);
`, now, now, now, now, now, now, now); err != nil {
		t.Fatalf("seed switch parents: %v", err)
	}
	if _, err := db.Exec(`
INSERT INTO agent_switches (
    id, session_id, idempotency_key, request_fingerprint,
    from_harness, target_harness, state,
    agent_handoff_status, source_generation_id, requested_at, updated_at
) VALUES (
    'switch-1', 'switch-session', 'switch-key', ?,
    'claude-code', 'codex', 'preparing_handoff',
    'not_attempted', 'source-generation', ?, ?
);
`, "v1:"+strings.Repeat("a", 64), now, now); err != nil {
		t.Fatalf("seed agent switch: %v", err)
	}

	if _, err := db.Exec(`
UPDATE agent_switches
SET agent_handoff_status = 'received',
    agent_handoff_path = '/ao/handoffs/switch-1/agent-handoff.json',
    agent_handoff_hash = 'BAD',
    updated_at = ?
WHERE id = 'switch-1';
`, now.Add(time.Minute)); err == nil {
		t.Fatal("agent_switches accepted a received handoff with a noncanonical SHA-256")
	}

	var transcriptStatus string
	if err := db.QueryRow(`
SELECT source_transcript_status FROM agent_switches WHERE id = 'switch-1';
`).Scan(&transcriptStatus); err != nil {
		t.Fatalf("read source transcript status: %v", err)
	}
	if transcriptStatus != "not_attempted" {
		t.Fatalf("source transcript status = %q, want not_attempted", transcriptStatus)
	}
	if _, err := db.Exec(`
UPDATE agent_switches
SET source_transcript_status = 'maybe', updated_at = ?
WHERE id = 'switch-1';
`, now.Add(time.Minute)); err == nil {
		t.Fatal("agent_switches accepted an invalid source transcript status")
	}
	if _, err := db.Exec(`
UPDATE agent_switches
SET semantic_handoff_included = 2, updated_at = ?
WHERE id = 'switch-1';
`, now.Add(time.Minute)); err == nil {
		t.Fatal("agent_switches accepted an invalid semantic handoff inclusion fact")
	}

	errorCodeCases := []struct {
		name             string
		state            string
		errorCode        string
		targetGeneration string
		targetHandle     string
		wantErr          bool
	}{
		{
			name:      "unknown code",
			state:     "failed",
			errorCode: "unknown_failure",
			wantErr:   true,
		},
		{
			name:    "failed without code",
			state:   "failed",
			wantErr: true,
		},
		{
			name:      "recovery marker in wrong state",
			state:     "preparing_handoff",
			errorCode: "target_start_unconfirmed",
			wantErr:   true,
		},
		{
			name:             "recovery marker with target handle",
			state:            "starting_target",
			errorCode:        "target_start_unconfirmed",
			targetGeneration: "target-generation",
			targetHandle:     "target-handle",
			wantErr:          true,
		},
		{
			name:      "recovery marker as failure code",
			state:     "failed",
			errorCode: "target_start_unconfirmed",
			wantErr:   true,
		},
		{
			name:      "failure code on active switch",
			state:     "preparing_handoff",
			errorCode: "failed_pre_stop",
			wantErr:   true,
		},
		{
			name:      "terminal failure",
			state:     "failed",
			errorCode: "failed_pre_stop",
		},
		{
			name:      "target-start recovery",
			state:     "starting_target",
			errorCode: "target_start_unconfirmed",
		},
	}
	for i, tc := range errorCodeCases {
		t.Run(tc.name, func(t *testing.T) {
			switchID := fmt.Sprintf("switch-error-%d", i)
			defer func() {
				if _, err := db.Exec(`DELETE FROM agent_switches WHERE id = ?`, switchID); err != nil {
					t.Errorf("clean up error-code switch: %v", err)
				}
			}()
			_, err := db.Exec(`
INSERT INTO agent_switches (
    id, session_id, idempotency_key, request_fingerprint,
    from_harness, target_harness, state,
    agent_handoff_status, source_generation_id,
    target_generation_id, target_runtime_handle_id, error_code,
    requested_at, updated_at
) VALUES (?, 'switch-error-session', ?, ?, 'claude-code', 'codex', ?,
          'not_attempted', 'source-generation', ?, ?, ?, ?, ?);
`,
				switchID,
				fmt.Sprintf("switch-error-key-%d", i),
				"v1:"+strings.Repeat("b", 64),
				tc.state,
				tc.targetGeneration,
				tc.targetHandle,
				tc.errorCode,
				now,
				now,
			)
			if tc.wantErr && err == nil {
				t.Fatal("agent_switches accepted an invalid error-code/state combination")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("agent_switches rejected a valid error-code/state combination: %v", err)
			}
		})
	}
	var before int
	if err := db.QueryRow(`
SELECT count(*)
FROM change_log
WHERE session_id = 'switch-session' AND event_type = 'session_updated';
`).Scan(&before); err != nil {
		t.Fatalf("count switch CDC rows before update: %v", err)
	}
	if _, err := db.Exec(`
UPDATE agent_switches
SET state = 'failed', error_code = 'failed_pre_stop', updated_at = ?
WHERE id = 'switch-1';
`, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("update agent switch: %v", err)
	}

	var after int
	if err := db.QueryRow(`
SELECT count(*)
FROM change_log
WHERE session_id = 'switch-session' AND event_type = 'session_updated';
`).Scan(&after); err != nil {
		t.Fatalf("count switch CDC rows after update: %v", err)
	}
	if after != before+1 {
		t.Fatalf("switch CDC rows after update = %d, want %d", after, before+1)
	}
}
