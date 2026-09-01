package persistenthost

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestACPPromptJournalReplaysResetsAndEnforcesQuota(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prompt.journal")
	journal, err := openACPPromptJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(journal.close)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("journal permissions = %v", info.Mode().Perm())
	}
	for _, frame := range [][]byte{[]byte("one\n"), []byte("two\n")} {
		if err := journal.append(frame); err != nil {
			t.Fatal(err)
		}
	}
	var replay bytes.Buffer
	if err := journal.replayTo(&replay); err != nil || replay.String() != "one\ntwo\n" {
		t.Fatalf("replay = %q, err=%v", replay.String(), err)
	}
	if err := journal.reset(); err != nil {
		t.Fatal(err)
	}
	replay.Reset()
	if err := journal.replayTo(&replay); err != nil || replay.Len() != 0 {
		t.Fatalf("reset replay = %q, err=%v", replay.String(), err)
	}
	journal.size = maxACPJournalBytes
	if err := journal.append([]byte("overflow\n")); !errors.Is(err, errACPJournalFull) {
		t.Fatalf("quota error = %v", err)
	}
}
