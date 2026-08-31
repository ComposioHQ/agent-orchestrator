// Package sessionimport discovers agent conversations that other coding CLIs
// (Claude Code, Codex, and any future provider) have already written to disk,
// so AO can import them as resumable sessions.
//
// Discovery is provider-agnostic: each provider implements Source, and the
// Service fans out across every registered Source, merges the results, flags
// the ones AO has already imported, and returns a single recency-ordered list.
// Adding another IDE is a matter of implementing Source for it; nothing else in
// the pipeline changes.
package sessionimport

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ImportableSession is one on-disk conversation AO could import. Every field is
// derived from the provider's own transcript, never from AO state, except
// AlreadyImported which the Service stamps against existing AO sessions.
type ImportableSession struct {
	// Provider is the harness that wrote the transcript (claude-code, codex, ...).
	Provider domain.AgentHarness
	// NativeSessionID is the provider's own session/thread id. It is what AO
	// binds to so the imported session can be resumed.
	NativeSessionID string
	// ConfigDir is the provider state root the transcript was found under
	// (e.g. ~/.claude or ~/.codex), so import can re-locate it deterministically.
	ConfigDir string
	// TranscriptPath is the absolute path to the JSONL transcript.
	TranscriptPath string
	// CWD is the working directory the conversation ran in, read from the
	// transcript itself (never reverse-engineered from a slugified dir name).
	CWD string
	// Branch is the git branch recorded in the transcript, when present.
	Branch string
	// Title is a human label: the provider's own title if it recorded one,
	// otherwise the first user prompt, otherwise the transcript file name.
	Title string
	// LastActivity is the most recent timestamp observed for the conversation.
	LastActivity time.Time
	// MessageCount is a best-effort count of visible messages. It is 0 (unknown)
	// for transcripts too large to scan cheaply; callers should fall back to
	// SizeBytes for display in that case.
	MessageCount int
	// SizeBytes is the transcript size on disk.
	SizeBytes int64
	// AlreadyImported is true when an AO session is already bound to
	// NativeSessionID. Stamped by the Service, not by a Source.
	AlreadyImported bool
}

// DiscoverOptions bounds a discovery scan so a large history directory cannot
// turn a single request into an unbounded amount of work.
type DiscoverOptions struct {
	// Since drops conversations whose LastActivity is older than this instant.
	// The zero value applies no age filter.
	Since time.Time
	// MaxPerProvider caps how many conversations each Source returns, keeping the
	// most recent. 0 means no cap.
	MaxPerProvider int
	// MaxScanBytes caps the bytes read from each transcript's head and tail when
	// extracting metadata. 0 selects a sensible default.
	MaxScanBytes int64
}

func (o DiscoverOptions) normalized() DiscoverOptions {
	if o.MaxScanBytes <= 0 {
		o.MaxScanBytes = defaultMaxScanBytes
	}
	return o
}

const (
	// defaultMaxScanBytes bounds head/tail metadata reads per transcript.
	defaultMaxScanBytes int64 = 256 * 1024
	// fullCountMaxBytes is the largest transcript we fully scan for an exact
	// message count. Above it MessageCount is left unknown (0).
	fullCountMaxBytes int64 = 8 * 1024 * 1024
)

// Source discovers importable conversations for one provider.
type Source interface {
	// Provider returns the harness this Source scans for.
	Provider() domain.AgentHarness
	// Discover returns the importable conversations found on disk. A missing
	// provider directory is not an error; it yields an empty slice.
	Discover(ctx context.Context, opts DiscoverOptions) ([]ImportableSession, error)
}

// ExistingNativeIDs reports the set of native session ids AO already has a
// session for, so discovery can flag duplicates. It returns a set keyed by the
// native id.
type ExistingNativeIDs func(ctx context.Context) (map[string]struct{}, error)

// Service fans discovery out across every registered Source.
type Service struct {
	sources  []Source
	existing ExistingNativeIDs
}

// NewService builds a discovery service over the given sources. existing may be
// nil, in which case no session is flagged AlreadyImported.
func NewService(existing ExistingNativeIDs, sources ...Source) *Service {
	return &Service{sources: sources, existing: existing}
}

// Sources returns the registered provider sources, in registration order.
func (s *Service) Sources() []Source { return s.sources }

// Discover scans every registered provider and returns a single list ordered by
// LastActivity, newest first. One provider failing does not fail the whole scan;
// its error is collected and returned alongside whatever the others found, so a
// single unreadable history directory never hides the rest.
func (s *Service) Discover(ctx context.Context, opts DiscoverOptions) ([]ImportableSession, error) {
	opts = opts.normalized()

	var (
		all  []ImportableSession
		errs []error
	)
	for _, src := range s.sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		found, err := src.Discover(ctx, opts)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		all = append(all, found...)
	}

	if err := s.flagImported(ctx, all); err != nil {
		errs = append(errs, err)
	}

	sort.SliceStable(all, func(i, j int) bool {
		if all[i].LastActivity.Equal(all[j].LastActivity) {
			return all[i].NativeSessionID < all[j].NativeSessionID
		}
		return all[i].LastActivity.After(all[j].LastActivity)
	})

	return all, errors.Join(errs...)
}

// Locate returns the importable conversation for one provider + native id, or
// ok=false when it is no longer on disk. It scans that provider's source with no
// age or count limit so an older conversation the discovery window dropped can
// still be imported by id.
func (s *Service) Locate(ctx context.Context, provider domain.AgentHarness, nativeID string) (ImportableSession, bool, error) {
	nativeID = strings.TrimSpace(nativeID)
	for _, src := range s.sources {
		if src.Provider() != provider {
			continue
		}
		found, err := src.Discover(ctx, DiscoverOptions{})
		if err != nil {
			return ImportableSession{}, false, err
		}
		for _, f := range found {
			if f.NativeSessionID == nativeID {
				return f, true, nil
			}
		}
	}
	return ImportableSession{}, false, nil
}

func (s *Service) flagImported(ctx context.Context, sessions []ImportableSession) error {
	if s.existing == nil || len(sessions) == 0 {
		return nil
	}
	imported, err := s.existing(ctx)
	if err != nil {
		return err
	}
	for i := range sessions {
		if _, ok := imported[sessions[i].NativeSessionID]; ok {
			sessions[i].AlreadyImported = true
		}
	}
	return nil
}

// titleFrom picks the best available label given a provider title, a first user
// prompt, and a fallback (usually the transcript file name). It trims and
// single-lines each candidate and truncates to a display-friendly length.
func titleFrom(providerTitle, firstPrompt, fallback string) string {
	for _, candidate := range []string{providerTitle, firstPrompt, fallback} {
		if t := normalizeTitle(candidate); t != "" {
			return t
		}
	}
	return ""
}

const maxTitleLen = 120

func normalizeTitle(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Collapse to the first non-empty line so a multi-line prompt reads as a
	// single label.
	if idx := strings.IndexAny(s, "\r\n"); idx >= 0 {
		s = strings.TrimSpace(s[:idx])
	}
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > maxTitleLen {
		s = strings.TrimSpace(s[:maxTitleLen]) + "…"
	}
	return s
}
