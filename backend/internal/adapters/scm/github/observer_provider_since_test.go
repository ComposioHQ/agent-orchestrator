package github

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// The pull-requests endpoint has no `since` parameter — GitHub silently ignores
// one — so sending it meant every changed repo re-listed all of its open PRs on
// every poll. The watermark is applied client-side instead, which the
// sort=updated&direction=desc ordering makes exact.
func TestListPRsByRepoFiltersOnWatermarkWithoutSinceParam(t *testing.T) {
	f := newFakeGH(t)
	var seen url.Values
	f.on(http.MethodGet, "/repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		// Newest-updated first, as the query asks for.
		_, _ = w.Write([]byte(`[
			{"node_id":"n1","number":1,"state":"open","html_url":"h1","updated_at":"2026-01-03T00:00:00Z"},
			{"node_id":"n2","number":2,"state":"open","html_url":"h2","updated_at":"2026-01-02T00:00:00Z"},
			{"node_id":"n3","number":3,"state":"open","html_url":"h3","updated_at":"2026-01-01T00:00:00Z"}
		]`))
	})

	watermark := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	got, err := newProviderForTest(t, f).ListPRsByRepo(ctx(), ports.SCMRepo{Owner: "o", Name: "r"}, watermark)
	if err != nil {
		t.Fatalf("ListPRsByRepo: %v", err)
	}

	if seen.Has("since") {
		t.Fatalf("request carried since=%q; the pulls endpoint ignores it", seen.Get("since"))
	}
	if len(got) != 1 || got[0].Number != 1 {
		nums := make([]int, 0, len(got))
		for _, p := range got {
			nums = append(nums, p.Number)
		}
		t.Fatalf("returned PRs %v, want only #1 — #2 is at the watermark and #3 is older", nums)
	}
}

// A zero watermark means "full listing": nothing is filtered out.
func TestListPRsByRepoZeroWatermarkReturnsEverything(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodGet, "/repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"node_id":"n1","number":1,"state":"open","html_url":"h1","updated_at":"2026-01-03T00:00:00Z"},
			{"node_id":"n2","number":2,"state":"open","html_url":"h2","updated_at":"2020-01-01T00:00:00Z"}
		]`))
	})
	got, err := newProviderForTest(t, f).ListPRsByRepo(ctx(), ports.SCMRepo{Owner: "o", Name: "r"}, time.Time{})
	if err != nil {
		t.Fatalf("ListPRsByRepo: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("returned %d PRs, want both on a zero watermark", len(got))
	}
}
