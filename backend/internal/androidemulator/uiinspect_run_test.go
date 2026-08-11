package androidemulator

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestUIInspectWithDepsSucceedsFirstTry(t *testing.T) {
	dumpCalls, catCalls := 0, 0
	deps := uiInspectDeps{
		dump: func(ctx context.Context) (string, error) {
			dumpCalls++
			return "UI hierchary dumped to: /data/local/tmp/ao-ui-dump.xml", nil
		},
		cat: func(ctx context.Context) ([]byte, error) {
			catCalls++
			return []byte(realDumpFixture), nil
		},
	}
	node, err := uiInspectWithDeps(context.Background(), deps, 3, time.Millisecond)
	if err != nil {
		t.Fatalf("uiInspectWithDeps: %v", err)
	}
	if node.Class != "android.widget.FrameLayout" {
		t.Errorf("node = %+v, want the parsed real fixture", node)
	}
	if dumpCalls != 1 || catCalls != 1 {
		t.Errorf("dumpCalls=%d catCalls=%d, want 1 each on first-try success", dumpCalls, catCalls)
	}
}

func TestUIInspectWithDepsRetriesOnKnownTransientDumpError(t *testing.T) {
	// Mirrors what Phase A5 verification actually observed: the dump command
	// itself reports the transient "null root node" error on its first
	// attempt, then succeeds.
	attempt := 0
	deps := uiInspectDeps{
		dump: func(ctx context.Context) (string, error) {
			attempt++
			if attempt == 1 {
				return "ERROR: null root node returned by UiTestAutomationBridge.", nil
			}
			return "UI hierchary dumped to: /data/local/tmp/ao-ui-dump.xml", nil
		},
		cat: func(ctx context.Context) ([]byte, error) {
			return []byte(realDumpFixture), nil
		},
	}
	node, err := uiInspectWithDeps(context.Background(), deps, 3, time.Millisecond)
	if err != nil {
		t.Fatalf("uiInspectWithDeps: %v, want it to recover on retry", err)
	}
	if attempt != 2 {
		t.Errorf("dump was attempted %d times, want 2 (fail once, then succeed)", attempt)
	}
	if node.Class == "" {
		t.Error("node is empty after a successful retry")
	}
}

func TestUIInspectWithDepsReturnsLastErrorAfterExhaustingRetries(t *testing.T) {
	deps := uiInspectDeps{
		dump: func(ctx context.Context) (string, error) {
			return "ERROR: null root node returned by UiTestAutomationBridge.", nil
		},
		cat: func(ctx context.Context) ([]byte, error) {
			t.Fatal("cat should never be called when dump itself reports ERROR")
			return nil, nil
		},
	}
	_, err := uiInspectWithDeps(context.Background(), deps, 2, time.Millisecond)
	if err == nil {
		t.Fatal("uiInspectWithDeps: want an error after exhausting retries, got nil")
	}
}

func TestUIInspectWithDepsPropagatesCatFailure(t *testing.T) {
	deps := uiInspectDeps{
		dump: func(ctx context.Context) (string, error) {
			return "UI hierchary dumped to: /data/local/tmp/ao-ui-dump.xml", nil
		},
		cat: func(ctx context.Context) ([]byte, error) {
			return nil, errors.New("device offline")
		},
	}
	_, err := uiInspectWithDeps(context.Background(), deps, 1, time.Millisecond)
	if err == nil {
		t.Fatal("uiInspectWithDeps: want an error when cat fails, got nil")
	}
}
