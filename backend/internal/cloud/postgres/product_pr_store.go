package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// Product fact writes are canonical SQL mutations; database triggers own CDC.
var _ ports.PRStore = (*Store)(nil)

const prColumns = `url, session_id, number, pr_state, review_decision, ci_state, mergeability,
 updated_at, state_changed_at, provider, host, repo, provider_id, source_branch, target_branch,
 head_sha, title, additions, deletions, changed_files, author, base_sha, merge_commit_sha,
 provider_state, provider_mergeable, provider_merge_state_status, html_url,
 created_at_provider, updated_at_provider, merged_at_provider, closed_at_provider,
 metadata_hash, ci_hash, review_hash, observed_at, ci_observed_at, review_observed_at,
 last_nudge_signature, auto_inject_ci`

func (s *Store) WritePR(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, comments []domain.PullRequestComment) error {
	return s.writeProductPR(ctx, pr, checks, nil, nil, comments, ports.ReviewWritePreserve, true, false)
}

func (s *Store) WriteSCMObservation(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, mode ports.ReviewWriteMode) error {
	return s.writeProductPR(ctx, pr, checks, reviews, threads, comments, mode, false, false)
}

func (s *Store) ClaimPR(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, mode ports.ReviewWriteMode, allowActiveTakeover bool) (ports.ClaimOutcome, error) {
	var outcome ports.ClaimOutcome
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		canonical, err := resolveProductPRURL(ctx, tx, identity, pr.URL)
		if err != nil {
			return err
		}
		pr.URL = canonical
		candidates, err := findProductPRCandidates(ctx, tx, identity, pr)
		if err != nil {
			return err
		}
		for _, candidate := range candidates {
			if candidate.SessionID == pr.SessionID {
				continue
			}
			if outcome.PreviousOwner != "" && outcome.PreviousOwner != candidate.SessionID {
				return fmt.Errorf("pr identity resolves to multiple sessions: %s and %s", outcome.PreviousOwner, candidate.SessionID)
			}
			outcome = ports.ClaimOutcome{PreviousOwner: candidate.SessionID, OwnerTerminated: candidate.Terminated}
			if !candidate.Terminated && !allowActiveTakeover {
				return ports.PRClaimedByActiveSessionError{Owner: candidate.SessionID}
			}
		}
		return writeProductPRTx(ctx, tx, identity, pr, checks, reviews, threads, comments, mode, false, true)
	})
	return outcome, err
}

func (s *Store) writeProductPR(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, mode ports.ReviewWriteMode, legacy, claim bool) error {
	return s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		canonical, err := resolveProductPRURL(ctx, tx, identity, pr.URL)
		if err != nil {
			return err
		}
		pr.URL = canonical
		return writeProductPRTx(ctx, tx, identity, pr, checks, reviews, threads, comments, mode, legacy, claim)
	})
}

// Product mutations remain plain SQL; database triggers own CDC.
func writeProductPRTx(ctx context.Context, tx pgx.Tx, identity tenant.Identity, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, mode ports.ReviewWriteMode, legacy, claim bool) error {
	if strings.TrimSpace(pr.URL) == "" || pr.SessionID == "" {
		return errors.New("write pull request: url and session are required")
	}
	pr = normalizeProductPR(pr)
	candidates, err := findProductPRCandidates(ctx, tx, identity, pr)
	if err != nil {
		return err
	}
	for _, candidate := range candidates {
		if !claim && candidate.SessionID != pr.SessionID {
			return fmt.Errorf("pr %s already belongs to session %s", candidate.URL, candidate.SessionID)
		}
		if candidate.URL != pr.URL && pr.ProviderID != "" {
			if _, err := tx.Exec(ctx, `UPDATE ao_pull_requests SET provider_id=''
				WHERE org_id=$1 AND owner_user_id=$2 AND url=$3`, identity.OrgID, identity.UserID, candidate.URL); err != nil {
				return normalizeError(err)
			}
		}
	}
	state := productPRState(pr)
	stateChanged := pr.StateChangedAt
	if stateChanged.IsZero() {
		stateChanged = productPRTransitionTime(pr, state)
	}
	query := `INSERT INTO ao_pull_requests (
		org_id, owner_user_id, url, session_id, number, pr_state, review_decision, ci_state, mergeability,
		updated_at, state_changed_at, provider, host, repo, provider_id, source_branch, target_branch,
		head_sha, title, additions, deletions, changed_files, author, base_sha, merge_commit_sha,
		provider_state, provider_mergeable, provider_merge_state_status, html_url,
		created_at_provider, updated_at_provider, merged_at_provider, closed_at_provider,
		metadata_hash, ci_hash, review_hash, observed_at, ci_observed_at, review_observed_at, auto_inject_ci)
	 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
	         $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
	         COALESCE((SELECT auto_inject_ci FROM ao_sessions WHERE org_id=$1 AND owner_user_id=$2 AND id=$4), TRUE))
	 ON CONFLICT (org_id, owner_user_id, url) DO UPDATE SET
		number=EXCLUDED.number, pr_state=EXCLUDED.pr_state, review_decision=EXCLUDED.review_decision,
		ci_state=EXCLUDED.ci_state, mergeability=EXCLUDED.mergeability, updated_at=EXCLUDED.updated_at,
		state_changed_at=CASE WHEN ao_pull_requests.pr_state<>EXCLUDED.pr_state THEN EXCLUDED.state_changed_at ELSE COALESCE(ao_pull_requests.state_changed_at, EXCLUDED.state_changed_at) END,
		provider=EXCLUDED.provider, host=EXCLUDED.host, repo=EXCLUDED.repo,
		provider_id=CASE WHEN EXCLUDED.provider_id<>'' THEN EXCLUDED.provider_id ELSE ao_pull_requests.provider_id END,
		source_branch=EXCLUDED.source_branch, target_branch=EXCLUDED.target_branch, head_sha=EXCLUDED.head_sha,
		title=EXCLUDED.title, additions=EXCLUDED.additions, deletions=EXCLUDED.deletions, changed_files=EXCLUDED.changed_files,
		author=EXCLUDED.author, base_sha=EXCLUDED.base_sha, merge_commit_sha=EXCLUDED.merge_commit_sha,
		provider_state=EXCLUDED.provider_state, provider_mergeable=EXCLUDED.provider_mergeable,
		provider_merge_state_status=EXCLUDED.provider_merge_state_status, html_url=EXCLUDED.html_url,
		created_at_provider=EXCLUDED.created_at_provider, updated_at_provider=EXCLUDED.updated_at_provider,
		merged_at_provider=EXCLUDED.merged_at_provider, closed_at_provider=EXCLUDED.closed_at_provider,
		metadata_hash=EXCLUDED.metadata_hash, ci_hash=EXCLUDED.ci_hash, review_hash=EXCLUDED.review_hash,
		observed_at=EXCLUDED.observed_at, ci_observed_at=EXCLUDED.ci_observed_at, review_observed_at=EXCLUDED.review_observed_at`
	if claim {
		query += `, session_id=EXCLUDED.session_id`
	}
	_, err = tx.Exec(ctx, query, identity.OrgID, identity.UserID, pr.URL, pr.SessionID, pr.Number, state,
		defaultReview(pr.Review), defaultCI(pr.CI), defaultMerge(pr.Mergeability), pr.UpdatedAt.UTC(), nullableTime(stateChanged),
		pr.Provider, pr.Host, pr.Repo, pr.ProviderID, pr.SourceBranch, pr.TargetBranch, pr.HeadSHA, pr.Title,
		pr.Additions, pr.Deletions, pr.ChangedFiles, pr.Author, pr.BaseSHA, pr.MergeCommitSHA, pr.ProviderState,
		pr.ProviderMergeable, pr.ProviderMergeStateStatus, pr.HTMLURL, nullableTime(pr.CreatedAtProvider),
		nullableTime(pr.UpdatedAtProvider), nullableTime(pr.MergedAtProvider), nullableTime(pr.ClosedAtProvider),
		pr.MetadataHash, pr.CIHash, pr.ReviewHash, nullableTime(pr.ObservedAt), nullableTime(pr.CIObservedAt), nullableTime(pr.ReviewObservedAt))
	if err != nil {
		return normalizeError(err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM ao_pull_request_url_aliases
		WHERE org_id=$1 AND owner_user_id=$2 AND alias_url=$3`, identity.OrgID, identity.UserID, pr.URL); err != nil {
		return normalizeError(err)
	}
	for _, candidate := range candidates {
		if candidate.URL == pr.URL {
			continue
		}
		if err := moveProductPRAliasRows(ctx, tx, identity, candidate.URL, pr.URL); err != nil {
			return err
		}
	}
	if pr.URLAlias != "" && pr.URLAlias != pr.URL {
		if _, err := tx.Exec(ctx, `INSERT INTO ao_pull_request_url_aliases(org_id,owner_user_id,alias_url,canonical_url)
			VALUES($1,$2,$3,$4) ON CONFLICT(org_id,owner_user_id,alias_url) DO UPDATE SET canonical_url=EXCLUDED.canonical_url`, identity.OrgID, identity.UserID, pr.URLAlias, pr.URL); err != nil {
			return normalizeError(err)
		}
	}
	if err := writeProductPRChildren(ctx, tx, identity, pr, checks, reviews, threads, comments, mode, legacy); err != nil {
		return err
	}
	return nil
}

type productPRCandidate struct {
	URL        string
	SessionID  domain.SessionID
	Terminated bool
}

func findProductPRCandidates(ctx context.Context, tx pgx.Tx, id tenant.Identity, pr domain.PullRequest) ([]productPRCandidate, error) {
	queries := []struct {
		query string
		args  []any
	}{
		{`SELECT p.url,p.session_id,s.is_terminated FROM ao_pull_requests p
			JOIN ao_sessions s ON s.org_id=p.org_id AND s.owner_user_id=p.owner_user_id AND s.id=p.session_id
			WHERE p.org_id=$1 AND p.owner_user_id=$2 AND p.url=$3 FOR UPDATE OF p`, []any{id.OrgID, id.UserID, pr.URL}},
	}
	if pr.URLAlias != "" && pr.URLAlias != pr.URL {
		queries = append(queries, struct {
			query string
			args  []any
		}{`SELECT p.url,p.session_id,s.is_terminated FROM ao_pull_requests p
			JOIN ao_sessions s ON s.org_id=p.org_id AND s.owner_user_id=p.owner_user_id AND s.id=p.session_id
			LEFT JOIN ao_pull_request_url_aliases a ON a.org_id=p.org_id AND a.owner_user_id=p.owner_user_id AND a.canonical_url=p.url
			WHERE p.org_id=$1 AND p.owner_user_id=$2 AND (p.url=$3 OR a.alias_url=$3) FOR UPDATE OF p`, []any{id.OrgID, id.UserID, pr.URLAlias}})
	}
	if pr.ProviderID != "" && pr.Provider != "" && pr.Host != "" {
		queries = append(queries, struct {
			query string
			args  []any
		}{`SELECT p.url,p.session_id,s.is_terminated FROM ao_pull_requests p
			JOIN ao_sessions s ON s.org_id=p.org_id AND s.owner_user_id=p.owner_user_id AND s.id=p.session_id
			WHERE p.org_id=$1 AND p.owner_user_id=$2 AND p.provider=$3 AND p.host=$4 AND p.provider_id=$5
			FOR UPDATE OF p`, []any{id.OrgID, id.UserID, pr.Provider, pr.Host, pr.ProviderID}})
	}
	byURL := make(map[string]productPRCandidate)
	for _, lookup := range queries {
		var candidate productPRCandidate
		err := tx.QueryRow(ctx, lookup.query, lookup.args...).Scan(&candidate.URL, &candidate.SessionID, &candidate.Terminated)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, normalizeError(err)
		}
		byURL[candidate.URL] = candidate
	}
	out := make([]productPRCandidate, 0, len(byURL))
	for _, candidate := range byURL {
		out = append(out, candidate)
	}
	return out, nil
}

func moveProductPRAliasRows(ctx context.Context, tx pgx.Tx, id tenant.Identity, previousURL, canonicalURL string) error {
	statements := []string{
		`INSERT INTO ao_pull_request_checks(org_id,owner_user_id,pr_url,name,commit_hash,status,conclusion,url,details,log_tail,created_at)
		 SELECT org_id,owner_user_id,$4,name,commit_hash,status,conclusion,url,details,log_tail,created_at
		 FROM ao_pull_request_checks WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3
		 ON CONFLICT(org_id,owner_user_id,pr_url,name,commit_hash) DO UPDATE SET status=EXCLUDED.status,conclusion=EXCLUDED.conclusion,url=EXCLUDED.url,details=EXCLUDED.details,log_tail=EXCLUDED.log_tail`,
		`INSERT INTO ao_pull_request_reviews(org_id,owner_user_id,pr_url,review_id,author,state,url,body,is_bot,target_sha,submitted_at,auto_inject_review)
		 SELECT org_id,owner_user_id,$4,review_id,author,state,url,body,is_bot,target_sha,submitted_at,auto_inject_review
		 FROM ao_pull_request_reviews WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3
		 ON CONFLICT(org_id,owner_user_id,pr_url,review_id) DO UPDATE SET author=EXCLUDED.author,state=EXCLUDED.state,url=EXCLUDED.url,body=EXCLUDED.body,is_bot=EXCLUDED.is_bot,target_sha=EXCLUDED.target_sha,submitted_at=EXCLUDED.submitted_at`,
		`INSERT INTO ao_pull_request_review_threads(org_id,owner_user_id,pr_url,thread_id,path,line,resolved,is_bot,semantic_hash,updated_at)
		 SELECT org_id,owner_user_id,$4,thread_id,path,line,resolved,is_bot,semantic_hash,updated_at
		 FROM ao_pull_request_review_threads WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3
		 ON CONFLICT(org_id,owner_user_id,pr_url,thread_id) DO UPDATE SET path=EXCLUDED.path,line=EXCLUDED.line,resolved=EXCLUDED.resolved,is_bot=EXCLUDED.is_bot,semantic_hash=EXCLUDED.semantic_hash,updated_at=EXCLUDED.updated_at`,
		`INSERT INTO ao_pull_request_comments(org_id,owner_user_id,pr_url,comment_id,thread_id,author,file,line,body,url,resolved,is_bot,auto_inject_review,created_at)
		 SELECT org_id,owner_user_id,$4,comment_id,thread_id,author,file,line,body,url,resolved,is_bot,auto_inject_review,created_at
		 FROM ao_pull_request_comments WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3
		 ON CONFLICT(org_id,owner_user_id,pr_url,comment_id) DO UPDATE SET thread_id=EXCLUDED.thread_id,author=EXCLUDED.author,file=EXCLUDED.file,line=EXCLUDED.line,body=EXCLUDED.body,url=EXCLUDED.url,resolved=EXCLUDED.resolved,is_bot=EXCLUDED.is_bot,created_at=EXCLUDED.created_at`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement, id.OrgID, id.UserID, previousURL, canonicalURL); err != nil {
			return normalizeError(err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE ao_notifications old SET status='read',resolved_at=COALESCE(old.resolved_at,old.created_at)
		WHERE old.org_id=$1 AND old.owner_user_id=$2 AND old.pr_url=$3
		AND (old.status='unread' OR old.resolved_at IS NULL)
		AND EXISTS(SELECT 1 FROM ao_notifications current WHERE current.org_id=old.org_id AND current.owner_user_id=old.owner_user_id
			AND current.pr_url=$4 AND current.session_id=old.session_id AND current.type=old.type
			AND (current.status='unread' OR current.resolved_at IS NULL))`, id.OrgID, id.UserID, previousURL, canonicalURL); err != nil {
		return normalizeError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE ao_notifications SET pr_url=$4 WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3`, id.OrgID, id.UserID, previousURL, canonicalURL); err != nil {
		return normalizeError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE ao_pull_request_url_aliases SET canonical_url=$4 WHERE org_id=$1 AND owner_user_id=$2 AND canonical_url=$3`, id.OrgID, id.UserID, previousURL, canonicalURL); err != nil {
		return normalizeError(err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM ao_pull_requests WHERE org_id=$1 AND owner_user_id=$2 AND url=$3`, id.OrgID, id.UserID, previousURL); err != nil {
		return normalizeError(err)
	}
	_, err := tx.Exec(ctx, `INSERT INTO ao_pull_request_url_aliases(org_id,owner_user_id,alias_url,canonical_url)
		VALUES($1,$2,$3,$4) ON CONFLICT(org_id,owner_user_id,alias_url) DO UPDATE SET canonical_url=EXCLUDED.canonical_url`, id.OrgID, id.UserID, previousURL, canonicalURL)
	return normalizeError(err)
}

func writeProductPRChildren(ctx context.Context, tx pgx.Tx, id tenant.Identity, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, mode ports.ReviewWriteMode, legacy bool) error {
	for _, c := range checks {
		if _, err := tx.Exec(ctx, `INSERT INTO ao_pull_request_checks(org_id,owner_user_id,pr_url,name,commit_hash,status,conclusion,url,details,log_tail,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(org_id,owner_user_id,pr_url,name,commit_hash) DO UPDATE SET status=EXCLUDED.status,conclusion=EXCLUDED.conclusion,url=EXCLUDED.url,details=EXCLUDED.details,log_tail=EXCLUDED.log_tail`, id.OrgID, id.UserID, pr.URL, c.Name, c.CommitHash, defaultCheck(c.Status), c.Conclusion, c.URL, c.Details, c.LogTail, c.CreatedAt.UTC()); err != nil {
			return normalizeError(err)
		}
	}
	if legacy {
		if _, err := tx.Exec(ctx, `DELETE FROM ao_pull_request_comments WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3 AND thread_id=''`, id.OrgID, id.UserID, pr.URL); err != nil {
			return normalizeError(err)
		}
		for i := range comments {
			comments[i].ThreadID = ""
		}
	}
	if mode == ports.ReviewWriteReplace || mode == ports.ReviewWriteMerge {
		for _, r := range reviews {
			if _, err := tx.Exec(ctx, `INSERT INTO ao_pull_request_reviews(org_id,owner_user_id,pr_url,review_id,author,state,url,body,is_bot,target_sha,submitted_at,auto_inject_review) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(org_id,owner_user_id,pr_url,review_id) DO UPDATE SET author=EXCLUDED.author,state=EXCLUDED.state,url=EXCLUDED.url,body=EXCLUDED.body,is_bot=EXCLUDED.is_bot,target_sha=EXCLUDED.target_sha,submitted_at=EXCLUDED.submitted_at`, id.OrgID, id.UserID, pr.URL, r.ID, r.Author, defaultReview(r.State), r.URL, r.Body, r.IsBot, r.TargetSHA, r.SubmittedAt.UTC(), r.AutoInjectReview); err != nil {
				return normalizeError(err)
			}
		}
		for _, th := range threads {
			if _, err := tx.Exec(ctx, `INSERT INTO ao_pull_request_review_threads(org_id,owner_user_id,pr_url,thread_id,path,line,resolved,is_bot,semantic_hash,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(org_id,owner_user_id,pr_url,thread_id) DO UPDATE SET path=EXCLUDED.path,line=EXCLUDED.line,resolved=EXCLUDED.resolved,is_bot=EXCLUDED.is_bot,semantic_hash=EXCLUDED.semantic_hash,updated_at=EXCLUDED.updated_at`, id.OrgID, id.UserID, pr.URL, th.ThreadID, th.Path, th.Line, th.Resolved, th.IsBot, th.SemanticHash, th.UpdatedAt.UTC()); err != nil {
				return normalizeError(err)
			}
		}
	}
	if legacy || mode == ports.ReviewWriteReplace || mode == ports.ReviewWriteMerge {
		for _, c := range comments {
			if _, err := tx.Exec(ctx, `INSERT INTO ao_pull_request_comments(org_id,owner_user_id,pr_url,comment_id,thread_id,author,file,line,body,url,resolved,is_bot,auto_inject_review,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(org_id,owner_user_id,pr_url,comment_id) DO UPDATE SET thread_id=EXCLUDED.thread_id,author=EXCLUDED.author,file=EXCLUDED.file,line=EXCLUDED.line,body=EXCLUDED.body,url=EXCLUDED.url,resolved=EXCLUDED.resolved,is_bot=EXCLUDED.is_bot,created_at=EXCLUDED.created_at`, id.OrgID, id.UserID, pr.URL, c.ID, c.ThreadID, c.Author, c.File, c.Line, c.Body, c.URL, c.Resolved, c.IsBot, c.AutoInjectReview, c.CreatedAt.UTC()); err != nil {
				return normalizeError(err)
			}
		}
	}
	if mode == ports.ReviewWriteReplace {
		if err := pruneProductIDs(ctx, tx, "ao_pull_request_reviews", "review_id", id, pr.URL, reviewIDs(reviews)); err != nil {
			return err
		}
		if err := pruneProductIDs(ctx, tx, "ao_pull_request_review_threads", "thread_id", id, pr.URL, threadIDs(threads)); err != nil {
			return err
		}
		if err := pruneProductIDs(ctx, tx, "ao_pull_request_comments", "comment_id", id, pr.URL, commentIDs(comments)); err != nil {
			return err
		}
	}
	return nil
}

func pruneProductIDs(ctx context.Context, tx pgx.Tx, table, column string, id tenant.Identity, prURL string, ids []string) error {
	query := fmt.Sprintf("DELETE FROM %s WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3 AND NOT (%s = ANY($4::text[]))", table, column)
	_, err := tx.Exec(ctx, query, id.OrgID, id.UserID, prURL, ids)
	return normalizeError(err)
}

func (s *Store) GetPR(ctx context.Context, url string) (domain.PullRequest, bool, error) {
	var out domain.PullRequest
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		canonical, e := resolveProductPRURL(ctx, tx, id, url)
		if e != nil {
			return e
		}
		return scanProductPR(tx.QueryRow(ctx, `SELECT `+prColumns+` FROM ao_pull_requests WHERE org_id=$1 AND owner_user_id=$2 AND url=$3`, id.OrgID, id.UserID, canonical), &out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.PullRequest{}, false, nil
	}
	return out, err == nil, err
}
func (s *Store) ListPRsBySession(ctx context.Context, sid domain.SessionID) ([]domain.PullRequest, error) {
	var out []domain.PullRequest
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		rows, e := tx.Query(ctx, `SELECT `+prColumns+` FROM ao_pull_requests WHERE org_id=$1 AND owner_user_id=$2 AND session_id=$3 ORDER BY updated_at DESC,url`, id.OrgID, id.UserID, sid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var p domain.PullRequest
			if e := scanProductPR(rows, &p); e != nil {
				return e
			}
			out = append(out, p)
		}
		return rows.Err()
	})
	return out, err
}

func (s *Store) GetDisplayPRFactsForSession(ctx context.Context, sid domain.SessionID) (domain.PRFacts, bool, error) {
	rows, err := s.ListPRFactsForSession(ctx, sid)
	if err != nil || len(rows) == 0 {
		return domain.PRFacts{}, false, err
	}
	for _, r := range rows {
		if !r.Merged && !r.Closed {
			return r, true, nil
		}
	}
	return rows[0], true, nil
}
func (s *Store) ListPRFactsForSession(ctx context.Context, sid domain.SessionID) ([]domain.PRFacts, error) {
	prs, err := s.ListPRsBySession(ctx, sid)
	if err != nil {
		return nil, err
	}
	out := make([]domain.PRFacts, 0, len(prs))
	for _, p := range prs {
		comments, e := s.ListPRComments(ctx, p.URL)
		if e != nil {
			return nil, e
		}
		unresolved := false
		for _, c := range comments {
			if !c.Resolved && !c.IsBot {
				unresolved = true
				break
			}
		}
		out = append(out, domain.PRFacts{URL: p.URL, Number: p.Number, Draft: p.Draft, Merged: p.Merged, Closed: p.Closed, CI: p.CI, Review: p.Review, Mergeability: p.Mergeability, ReviewComments: unresolved, SourceBranch: p.SourceBranch, TargetBranch: p.TargetBranch, HeadSHA: p.HeadSHA, UpdatedAt: p.UpdatedAt})
	}
	return out, nil
}

func (s *Store) ListChecks(ctx context.Context, url string) ([]domain.PullRequestCheck, error) {
	var out []domain.PullRequestCheck
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		rows, e := tx.Query(ctx, `SELECT name,commit_hash,status,conclusion,url,details,log_tail,created_at FROM ao_pull_request_checks WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3 ORDER BY name,created_at`, id.OrgID, id.UserID, url)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var v domain.PullRequestCheck
			if e := rows.Scan(&v.Name, &v.CommitHash, &v.Status, &v.Conclusion, &v.URL, &v.Details, &v.LogTail, &v.CreatedAt); e != nil {
				return e
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	return out, err
}

func (s *Store) ListPRComments(ctx context.Context, url string) ([]domain.PullRequestComment, error) {
	var out []domain.PullRequestComment
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		rows, e := tx.Query(ctx, `SELECT thread_id,comment_id,author,file,line,body,url,resolved,is_bot,created_at,auto_inject_review FROM ao_pull_request_comments WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3 ORDER BY created_at,comment_id`, id.OrgID, id.UserID, url)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var v domain.PullRequestComment
			if e := rows.Scan(&v.ThreadID, &v.ID, &v.Author, &v.File, &v.Line, &v.Body, &v.URL, &v.Resolved, &v.IsBot, &v.CreatedAt, &v.AutoInjectReview); e != nil {
				return e
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	return out, err
}
func (s *Store) ListPRReviews(ctx context.Context, url string) ([]domain.PullRequestReview, error) {
	var out []domain.PullRequestReview
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		rows, e := tx.Query(ctx, `SELECT review_id,author,state,url,body,is_bot,target_sha,submitted_at,auto_inject_review FROM ao_pull_request_reviews WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3 ORDER BY submitted_at,review_id`, id.OrgID, id.UserID, url)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var v domain.PullRequestReview
			if e := rows.Scan(&v.ID, &v.Author, &v.State, &v.URL, &v.Body, &v.IsBot, &v.TargetSHA, &v.SubmittedAt, &v.AutoInjectReview); e != nil {
				return e
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	return out, err
}
func (s *Store) ListPRReviewThreads(ctx context.Context, url string) ([]domain.PullRequestReviewThread, error) {
	var out []domain.PullRequestReviewThread
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		rows, e := tx.Query(ctx, `SELECT thread_id,path,line,resolved,is_bot,semantic_hash,updated_at FROM ao_pull_request_review_threads WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3 ORDER BY updated_at,thread_id`, id.OrgID, id.UserID, url)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var v domain.PullRequestReviewThread
			if e := rows.Scan(&v.ThreadID, &v.Path, &v.Line, &v.Resolved, &v.IsBot, &v.SemanticHash, &v.UpdatedAt); e != nil {
				return e
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	return out, err
}

func (s *Store) MarkPRCommentResolved(ctx context.Context, url, commentID string) (bool, error) {
	var changed bool
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		tag, e := tx.Exec(ctx, `UPDATE ao_pull_request_comments SET resolved=TRUE WHERE org_id=$1 AND owner_user_id=$2 AND pr_url=$3 AND comment_id=$4`, id.OrgID, id.UserID, url, commentID)
		changed = tag.RowsAffected() > 0
		return e
	})
	return changed, err
}
func (s *Store) GetPRLastNudgeSignature(ctx context.Context, url string) (string, error) {
	var value string
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		e := tx.QueryRow(ctx, `SELECT last_nudge_signature FROM ao_pull_requests WHERE org_id=$1 AND owner_user_id=$2 AND url=$3`, id.OrgID, id.UserID, url).Scan(&value)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		return e
	})
	return value, err
}
func (s *Store) UpdatePRLastNudgeSignature(ctx context.Context, url, value string) error {
	return s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		_, e := tx.Exec(ctx, `UPDATE ao_pull_requests SET last_nudge_signature=$4 WHERE org_id=$1 AND owner_user_id=$2 AND url=$3`, id.OrgID, id.UserID, url, value)
		return e
	})
}

func resolveProductPRURL(ctx context.Context, tx pgx.Tx, id tenant.Identity, url string) (string, error) {
	var canonical string
	err := tx.QueryRow(ctx, `SELECT canonical_url FROM ao_pull_request_url_aliases WHERE org_id=$1 AND owner_user_id=$2 AND alias_url=$3`, id.OrgID, id.UserID, url).Scan(&canonical)
	if errors.Is(err, pgx.ErrNoRows) {
		return url, nil
	}
	return canonical, normalizeError(err)
}
func productPRState(p domain.PullRequest) domain.PRState {
	if p.Merged {
		return domain.PRStateMerged
	}
	if p.Closed {
		return domain.PRStateClosed
	}
	if p.Draft {
		return domain.PRStateDraft
	}
	return domain.PRStateOpen
}
func defaultCI(v domain.CIState) domain.CIState {
	if v == "" {
		return domain.CIUnknown
	}
	return v
}
func defaultReview(v domain.ReviewDecision) domain.ReviewDecision {
	if v == "" {
		return domain.ReviewNone
	}
	return v
}
func defaultMerge(v domain.Mergeability) domain.Mergeability {
	if v == "" {
		return domain.MergeUnknown
	}
	return v
}
func defaultCheck(v domain.PRCheckStatus) domain.PRCheckStatus {
	if v == "" {
		return domain.PRCheckUnknown
	}
	return v
}
func nullableTime(v time.Time) any {
	if v.IsZero() {
		return nil
	}
	return v.UTC()
}
func productPRTransitionTime(p domain.PullRequest, state domain.PRState) time.Time {
	switch state {
	case domain.PRStateMerged:
		if !p.MergedAtProvider.IsZero() {
			return p.MergedAtProvider
		}
	case domain.PRStateClosed:
		if !p.ClosedAtProvider.IsZero() {
			return p.ClosedAtProvider
		}
	}
	if !p.UpdatedAtProvider.IsZero() {
		return p.UpdatedAtProvider
	}
	if !p.ObservedAt.IsZero() {
		return p.ObservedAt
	}
	return p.UpdatedAt
}
func normalizeProductPR(p domain.PullRequest) domain.PullRequest {
	p.URL = strings.TrimSpace(p.URL)
	p.URLAlias = strings.TrimSpace(p.URLAlias)
	p.Provider = strings.ToLower(strings.TrimSpace(p.Provider))
	p.Host = strings.ToLower(strings.TrimSpace(p.Host))
	p.ProviderID = strings.TrimSpace(p.ProviderID)
	return p
}
func reviewIDs(v []domain.PullRequestReview) []string {
	o := make([]string, len(v))
	for i := range v {
		o[i] = v[i].ID
	}
	return o
}
func threadIDs(v []domain.PullRequestReviewThread) []string {
	o := make([]string, len(v))
	for i := range v {
		o[i] = v[i].ThreadID
	}
	return o
}
func commentIDs(v []domain.PullRequestComment) []string {
	o := make([]string, len(v))
	for i := range v {
		o[i] = v[i].ID
	}
	return o
}

type scanRow interface{ Scan(...any) error }

func scanProductPR(row scanRow, p *domain.PullRequest) error {
	var state domain.PRState
	var created, updated, merged, closed, observed, ciObserved, reviewObserved, stateChanged *time.Time
	var nudge string
	err := row.Scan(&p.URL, &p.SessionID, &p.Number, &state, &p.Review, &p.CI, &p.Mergeability, &p.UpdatedAt, &stateChanged, &p.Provider, &p.Host, &p.Repo, &p.ProviderID, &p.SourceBranch, &p.TargetBranch, &p.HeadSHA, &p.Title, &p.Additions, &p.Deletions, &p.ChangedFiles, &p.Author, &p.BaseSHA, &p.MergeCommitSHA, &p.ProviderState, &p.ProviderMergeable, &p.ProviderMergeStateStatus, &p.HTMLURL, &created, &updated, &merged, &closed, &p.MetadataHash, &p.CIHash, &p.ReviewHash, &observed, &ciObserved, &reviewObserved, &nudge, &p.AutoInjectCI)
	if err != nil {
		return err
	}
	p.Draft = state == domain.PRStateDraft
	p.Merged = state == domain.PRStateMerged
	p.Closed = state == domain.PRStateClosed
	if stateChanged != nil {
		p.StateChangedAt = *stateChanged
	}
	if created != nil {
		p.CreatedAtProvider = *created
	}
	if updated != nil {
		p.UpdatedAtProvider = *updated
	}
	if merged != nil {
		p.MergedAtProvider = *merged
	}
	if closed != nil {
		p.ClosedAtProvider = *closed
	}
	if observed != nil {
		p.ObservedAt = *observed
	}
	if ciObserved != nil {
		p.CIObservedAt = *ciObserved
	}
	if reviewObserved != nil {
		p.ReviewObservedAt = *reviewObserved
	}
	return nil
}
