package acp

import (
	"strings"
	"testing"
)

func TestLineDeltaCountsActualEditsNotWholeFiles(t *testing.T) {
	// A one-line rewrite inside a large file must not report +N −N for N=len(file).
	const n = 1415
	var oldBuilder, newBuilder strings.Builder
	for i := 0; i < n; i++ {
		oldBuilder.WriteString("line\n")
		if i == 100 {
			newBuilder.WriteString("changed\n")
		} else {
			newBuilder.WriteString("line\n")
		}
	}

	additions, deletions := lineDelta(oldBuilder.String(), newBuilder.String())
	if additions != 1 || deletions != 1 {
		t.Fatalf("lineDelta = +%d −%d, want +1 −1", additions, deletions)
	}
}

func TestLineDeltaAddedAndDeletedFiles(t *testing.T) {
	additions, deletions := lineDelta("", "one\ntwo\nthree")
	if additions != 3 || deletions != 0 {
		t.Fatalf("added file = +%d −%d, want +3 −0", additions, deletions)
	}

	additions, deletions = lineDelta("one\ntwo\nthree", "")
	if additions != 0 || deletions != 3 {
		t.Fatalf("deleted file = +%d −%d, want +0 −3", additions, deletions)
	}
}

func TestLineDeltaIdenticalSnapshots(t *testing.T) {
	additions, deletions := lineDelta("same\nfile\n", "same\nfile\n")
	if additions != 0 || deletions != 0 {
		t.Fatalf("identical = +%d −%d, want +0 −0", additions, deletions)
	}
}

func TestLineDeltaAppendOnly(t *testing.T) {
	additions, deletions := lineDelta("a\nb\n", "a\nb\nc\n")
	if additions != 1 || deletions != 0 {
		t.Fatalf("append = +%d −%d, want +1 −0", additions, deletions)
	}
}

func TestTurnFileSnapNetsRepeatedEditsAgainstFirstSnapshot(t *testing.T) {
	var snap turnFileSnap
	base := "a\nb\nc\n"
	mid := "a\nb\nX\n"
	final := "a\nb\nX\nY\n"

	old := base
	snap.apply("f.txt", &old, mid)
	additions, deletions := snap.additionsDeletions()
	if snap.status != "modified" || additions != 1 || deletions != 1 {
		t.Fatalf("after first edit: status=%s +%d −%d", snap.status, additions, deletions)
	}

	old = mid
	snap.apply("f.txt", &old, final)
	additions, deletions = snap.additionsDeletions()
	// Net turn delta is base → final (+2 −1), not mid → final alone.
	if snap.status != "modified" || additions != 2 || deletions != 1 {
		t.Fatalf("after second edit: status=%s +%d −%d, want modified +2 −1", snap.status, additions, deletions)
	}
}

func TestTurnFileSnapKeepsAddStatusAcrossFollowUpEdits(t *testing.T) {
	var snap turnFileSnap
	snap.apply("new.txt", nil, "one\n")
	snap.apply("new.txt", strPtr("one\n"), "one\ntwo\n")
	additions, deletions := snap.additionsDeletions()
	if snap.status != "added" || additions != 2 || deletions != 0 {
		t.Fatalf("turn-local add = status=%s +%d −%d, want added +2 −0", snap.status, additions, deletions)
	}
}

func strPtr(value string) *string { return &value }
