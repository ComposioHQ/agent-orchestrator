package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/go-chi/chi/v5"
)

const (
	pullRequestTestOrgID     = "00000000-0000-0000-0000-000000000001"
	pullRequestTestSessionID = "00000000-0000-0000-0000-000000000002"
)

type pullRequestListStore struct {
	Store
	pullRequests []domain.PullRequest
	err          error
	sawPrincipal domain.Principal
	sawOrgID     string
	sawSessionID string
	callCount    int
}

func (s *pullRequestListStore) ListPullRequestsBySession(
	_ context.Context, principal domain.Principal, orgID, sessionID string,
) ([]domain.PullRequest, error) {
	s.callCount++
	s.sawPrincipal = principal
	s.sawOrgID = orgID
	s.sawSessionID = sessionID
	if s.err != nil {
		return nil, s.err
	}
	return s.pullRequests, nil
}

type reviewRunListStore struct {
	Store
	runs      []domain.ReviewRunPullRequest
	err       error
	callCount int
}

func (s *reviewRunListStore) ListReviewRunsBySession(
	context.Context, domain.Principal, string, string,
) ([]domain.ReviewRunPullRequest, error) {
	s.callCount++
	if s.err != nil {
		return nil, s.err
	}
	return s.runs, nil
}

func pullRequestHandlerRequest() *http.Request {
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/cloud/v1/orgs/"+pullRequestTestOrgID+"/sessions/"+pullRequestTestSessionID+"/pull-requests",
		nil,
	)
	route := chi.NewRouteContext()
	route.URLParams.Add("orgId", pullRequestTestOrgID)
	route.URLParams.Add("sessionId", pullRequestTestSessionID)
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
	ctx = context.WithValue(ctx, principalKey, domain.Principal{UserID: "user-1"})
	return request.WithContext(ctx)
}

func TestListSessionPullRequestsReturnsCurrentStatus(t *testing.T) {
	store := &pullRequestListStore{pullRequests: []domain.PullRequest{
		{
			ID: "pr-1", SessionID: pullRequestTestSessionID, Provider: "github",
			Repository: "acme/api", Author: "octocat", Number: 7, URL: "https://github.com/acme/api/pull/7",
			Title: "Fix the thing", State: contract.PRStateOpen,
			Additions: 12, Deletions: 3, ChangedFiles: 2,
			CIState: contract.CIFailing, ReviewState: contract.ReviewChangesRequest,
			Mergeability: contract.MergeConflicting, AOReviewState: contract.AOReviewNeedsReview,
		},
	}}
	server := &Server{store: store, logger: slog.Default()}
	response := httptest.NewRecorder()

	server.listSessionPullRequests(response, pullRequestHandlerRequest())

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if store.callCount != 1 || store.sawOrgID != pullRequestTestOrgID ||
		store.sawSessionID != pullRequestTestSessionID || store.sawPrincipal.UserID != "user-1" {
		t.Fatalf("store call = %#v", store)
	}
	var body struct {
		SessionID    string                       `json:"sessionId"`
		PullRequests []pullRequestSummaryResponse `json:"pullRequests"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.SessionID != pullRequestTestSessionID || len(body.PullRequests) != 1 {
		t.Fatalf("body = %#v", body)
	}
	pr := body.PullRequests[0]
	if pr.URL != "https://github.com/acme/api/pull/7" || pr.Number != 7 || pr.Author != "octocat" ||
		pr.Additions != 12 || pr.Deletions != 3 || pr.ChangedFiles != 2 ||
		pr.CI.State != "failing" || pr.Review.Decision != "changes_requested" || pr.Mergeability.State != "conflicting" {
		t.Fatalf("pull request = %#v", pr)
	}
}

func TestListSessionPullRequestsRejectsNonUUIDIdentifiers(t *testing.T) {
	store := &pullRequestListStore{}
	server := &Server{store: store, logger: slog.Default()}
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/cloud/v1/orgs/"+pullRequestTestOrgID+"/sessions/not-a-uuid/pull-requests",
		nil,
	)
	route := chi.NewRouteContext()
	route.URLParams.Add("orgId", pullRequestTestOrgID)
	route.URLParams.Add("sessionId", "not-a-uuid")
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
	ctx = context.WithValue(ctx, principalKey, domain.Principal{UserID: "user-1"})
	response := httptest.NewRecorder()

	server.listSessionPullRequests(response, request.WithContext(ctx))

	if response.Code != http.StatusBadRequest || store.callCount != 0 {
		t.Fatalf("status = %d, calls = %d", response.Code, store.callCount)
	}
}

func TestGetSessionReviewStateGroupsRunsByPullRequest(t *testing.T) {
	store := &reviewRunListStore{runs: []domain.ReviewRunPullRequest{
		{
			ReviewRun: domain.ReviewRun{
				ID: "run-2", PullRequestID: "pr-7", TargetSHA: "sha-2", Status: contract.AOReviewRunDelivered,
				Verdict: contract.AOReviewVerdictApproved,
			},
			PullRequestURL:    "https://github.com/acme/api/pull/7",
			PullRequestNumber: 7, PullRequestTitle: "Fix the thing",
			PullRequestAOReviewState: contract.AOReviewUpToDate,
		},
		{
			ReviewRun: domain.ReviewRun{
				ID: "run-1", PullRequestID: "pr-7", TargetSHA: "sha-1", Status: contract.AOReviewRunFailed,
			},
			PullRequestURL:    "https://github.com/acme/api/pull/7",
			PullRequestNumber: 7, PullRequestTitle: "Fix the thing",
			PullRequestAOReviewState: contract.AOReviewUpToDate,
		},
		{
			ReviewRun: domain.ReviewRun{
				ID: "run-3", PullRequestID: "pr-9", TargetSHA: "sha-3", Status: contract.AOReviewRunRunning,
			},
			PullRequestURL:    "https://github.com/acme/api/pull/9",
			PullRequestNumber: 9, PullRequestTitle: "Add the other thing",
			PullRequestAOReviewState: contract.AOReviewRunning,
		},
	}}
	server := &Server{store: store, logger: slog.Default()}

	rec := httptest.NewRecorder()
	server.getSessionReviewState(rec, pullRequestHandlerRequest())

	if rec.Code != http.StatusOK || store.callCount != 1 {
		t.Fatalf("status = %d, body = %s, calls = %d", rec.Code, rec.Body.String(), store.callCount)
	}
	var body struct {
		SessionID string                             `json:"sessionId"`
		Reviews   []aoPullRequestReviewStateResponse `json:"reviews"`
		Runs      []aoReviewRunResponse              `json:"runs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.SessionID != pullRequestTestSessionID || len(body.Reviews) != 2 || len(body.Runs) != 3 {
		t.Fatalf("body = %#v", body)
	}
	first := body.Reviews[0]
	if first.PullRequestNumber != 7 || first.Status != "up_to_date" ||
		first.LatestRun == nil || first.LatestRun.ID != "run-2" ||
		first.PreviousRun == nil || first.PreviousRun.ID != "run-1" {
		t.Fatalf("first review = %#v", first)
	}
	second := body.Reviews[1]
	if second.PullRequestNumber != 9 || second.LatestRun == nil || second.LatestRun.ID != "run-3" ||
		second.PreviousRun != nil {
		t.Fatalf("second review = %#v", second)
	}
}

func TestGetSessionReviewStateRejectsNonUUIDIdentifiers(t *testing.T) {
	store := &reviewRunListStore{}
	server := &Server{store: store, logger: slog.Default()}
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/cloud/v1/orgs/"+pullRequestTestOrgID+"/sessions/not-a-uuid/reviews",
		nil,
	)
	route := chi.NewRouteContext()
	route.URLParams.Add("orgId", pullRequestTestOrgID)
	route.URLParams.Add("sessionId", "not-a-uuid")
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
	ctx = context.WithValue(ctx, principalKey, domain.Principal{UserID: "user-1"})
	response := httptest.NewRecorder()

	server.getSessionReviewState(response, request.WithContext(ctx))

	if response.Code != http.StatusBadRequest || store.callCount != 0 {
		t.Fatalf("status = %d, calls = %d", response.Code, store.callCount)
	}
}
