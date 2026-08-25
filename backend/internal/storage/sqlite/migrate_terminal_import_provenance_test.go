package sqlite

import "testing"

func TestMigration0109AddsTerminalImportProvenanceWithoutReclassifyingExistingTurns(t *testing.T) {
	db := openTestDB(t)
	upTo(t, db, 108)
	mustExec(t, db, `
INSERT INTO projects (id, path, display_name, registered_at)
VALUES ('terminal-import', '/tmp/terminal-import', 'Terminal import', CURRENT_TIMESTAMP);
INSERT INTO sessions (
    id, project_id, num, harness, session_mode, activity_last_at,
    created_at, updated_at
) VALUES (
    'terminal-import-1', 'terminal-import', 1, 'claude-code', 'chat',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO conversations (
    id, scope, project_id, session_id, current_session_id,
    active_branch_id, created_at, updated_at
) VALUES (
    'conversation-1', 'session', 'terminal-import', 'terminal-import-1',
    'terminal-import-1', 'conversation-1:root', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO conversation_branches (
    id, conversation_id, session_id, provider_conversation_id, created_at
) VALUES (
    'conversation-1:root', 'conversation-1', 'terminal-import-1',
    'native-1', CURRENT_TIMESTAMP
);
INSERT INTO conversation_turns (
    id, conversation_id, handled_by_session_id, provider_turn_id,
    state, requested_at, branch_id
) VALUES (
    'existing-turn', 'conversation-1', 'terminal-import-1', 'native-turn-1',
    'recovered', CURRENT_TIMESTAMP, 'conversation-1:root'
);`)

	upTo(t, db, 109)

	var existing bool
	if err := db.QueryRow(`
SELECT imported_from_terminal FROM conversation_turns WHERE id = 'existing-turn'
`).Scan(&existing); err != nil {
		t.Fatalf("read migrated turn provenance: %v", err)
	}
	if existing {
		t.Fatal("migration reclassified an existing recovered Chat turn as a Terminal import")
	}

	mustExec(t, db, `
INSERT INTO conversation_turns (
    id, conversation_id, handled_by_session_id, provider_turn_id,
    state, requested_at, branch_id, imported_from_terminal
) VALUES (
    'terminal-turn', 'conversation-1', 'terminal-import-1', 'native-turn-2',
    'recovered', CURRENT_TIMESTAMP, 'conversation-1:root', 1
);`)
	var imported bool
	if err := db.QueryRow(`
SELECT imported_from_terminal FROM conversation_turns WHERE id = 'terminal-turn'
`).Scan(&imported); err != nil {
		t.Fatalf("read Terminal turn provenance: %v", err)
	}
	if !imported {
		t.Fatal("Terminal import provenance did not persist")
	}
}
