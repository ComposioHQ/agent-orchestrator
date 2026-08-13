// Package prstatus periodically refreshes the CI, review, and mergeability
// state of every pull request AO Cloud is tracking, so a session's PR list
// stays current without a worker or user having to ask GitHub directly.
package prstatus

import (
	"context"
	"log/slog"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
)

// Store lists the pull requests this scanner needs to refresh.
type Store interface {
	// OpenPullRequestRefs lists every open pull request across every
	// organization.
	OpenPullRequestRefs(ctx context.Context) ([]domain.PullRequestRef, error)
}

// GitHub fetches one pull request's current state and applies it over its
// durable record.
type GitHub interface {
	RefreshPullRequestStatus(ctx context.Context, ref domain.PullRequestRef) (domain.PullRequest, error)
}

// Options configures a Scanner. Zero values fall back to the defaults below.
type Options struct {
	// Interval is how often the scanner refreshes open pull requests.
	Interval time.Duration
	// Logger receives lifecycle events.
	Logger *slog.Logger
}

// DefaultInterval matches the local desktop app's fast metadata/CI poll tick
// (backend/internal/observe/scm.DefaultTickInterval), so cloud sessions get
// the same status freshness the local app already gives users.
const DefaultInterval = 30 * time.Second

// Scanner periodically refreshes every open pull request's status.
type Scanner struct {
	store   Store
	github  GitHub
	options Options
	log     *slog.Logger
}

// New creates a pull-request status scanner.
func New(store Store, github GitHub, options Options) *Scanner {
	if options.Interval <= 0 {
		options.Interval = DefaultInterval
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return &Scanner{store: store, github: github, options: options, log: options.Logger}
}

// Run scans on Options.Interval until ctx is canceled.
func (s *Scanner) Run(ctx context.Context) error {
	if err := s.ScanOnce(ctx); err != nil && ctx.Err() == nil {
		s.log.Error("pull request status scan failed", "err", err)
	}
	ticker := time.NewTicker(s.options.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := s.ScanOnce(ctx); err != nil && ctx.Err() == nil {
				s.log.Error("pull request status scan failed", "err", err)
			}
		}
	}
}

// ScanOnce refreshes every currently open pull request once. Each pull
// request is refreshed independently, so one failure does not stop the rest
// of the scan; the next tick retries what a transient error skipped.
func (s *Scanner) ScanOnce(ctx context.Context) error {
	refs, err := s.store.OpenPullRequestRefs(ctx)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		if _, err := s.github.RefreshPullRequestStatus(ctx, ref); err != nil {
			s.log.Error("pull request status refresh failed",
				"pull_request_id", ref.ID, "org_id", ref.OrgID, "err", err)
			continue
		}
	}
	return nil
}
