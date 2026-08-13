package prstatus

import (
	"context"
	"errors"
	"testing"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
)

// fakeStore records every ref it would hand the scanner, without a real
// database.
type fakeStore struct {
	refs    []domain.PullRequestRef
	listErr error
}

func (f *fakeStore) OpenPullRequestRefs(context.Context) ([]domain.PullRequestRef, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.refs, nil
}

// fakeGitHub records every ref the scanner asked it to refresh, and can fail
// on demand for one ref, so a test can assert the scan continues past it.
type fakeGitHub struct {
	err       map[string]error
	refreshed []string
}

func (g *fakeGitHub) RefreshPullRequestStatus(
	_ context.Context, ref domain.PullRequestRef,
) (domain.PullRequest, error) {
	if err := g.err[ref.ID]; err != nil {
		return domain.PullRequest{}, err
	}
	g.refreshed = append(g.refreshed, ref.ID)
	return domain.PullRequest{ID: ref.ID}, nil
}

func TestScanOnceRefreshesEveryOpenPullRequest(t *testing.T) {
	store := &fakeStore{refs: []domain.PullRequestRef{
		{ID: "pr-1", OrgID: "org-1"},
		{ID: "pr-2", OrgID: "org-1"},
	}}
	github := &fakeGitHub{}
	scanner := New(store, github, Options{})

	if err := scanner.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce() error = %v", err)
	}
	if len(github.refreshed) != 2 || github.refreshed[0] != "pr-1" || github.refreshed[1] != "pr-2" {
		t.Errorf("refreshed = %v, want [pr-1 pr-2]", github.refreshed)
	}
}

func TestScanOnceSkipsAFailingPullRequestAndContinues(t *testing.T) {
	store := &fakeStore{refs: []domain.PullRequestRef{
		{ID: "pr-errors", OrgID: "org-1"},
		{ID: "pr-2", OrgID: "org-1"},
	}}
	github := &fakeGitHub{err: map[string]error{"pr-errors": errors.New("transient failure")}}
	scanner := New(store, github, Options{})

	if err := scanner.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce() error = %v, want a per-PR error not to fail the scan", err)
	}
	if len(github.refreshed) != 1 || github.refreshed[0] != "pr-2" {
		t.Errorf("refreshed = %v, want the healthy PR still refreshed despite the other's error", github.refreshed)
	}
}

func TestScanOnceReturnsAListError(t *testing.T) {
	store := &fakeStore{listErr: errors.New("database unavailable")}
	github := &fakeGitHub{}
	scanner := New(store, github, Options{})

	if err := scanner.ScanOnce(context.Background()); err == nil {
		t.Fatal("ScanOnce() error = nil, want the list failure surfaced")
	}
	if len(github.refreshed) != 0 {
		t.Errorf("refreshed = %v, want none", github.refreshed)
	}
}
