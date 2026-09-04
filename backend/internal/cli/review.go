package cli

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/aoagents/agent-orchestrator/backend/internal/nativeqwen"
)

// reviewRun mirrors the daemon's domain.ReviewRun for the CLI client.
type reviewRun struct {
	ID             string     `json:"id"`
	ReviewID       string     `json:"reviewId"`
	SessionID      string     `json:"sessionId"`
	BatchID        string     `json:"batchId"`
	Harness        string     `json:"harness"`
	PRURL          string     `json:"prUrl"`
	TargetSHA      string     `json:"targetSha"`
	Status         string     `json:"status"`
	Verdict        string     `json:"verdict"`
	Body           string     `json:"body"`
	GithubReviewID string     `json:"githubReviewId"`
	CreatedAt      time.Time  `json:"createdAt"`
	DeliveredAt    *time.Time `json:"deliveredAt,omitempty"`
}

type reviewState struct {
	PRURL       string     `json:"prUrl"`
	PRNumber    int        `json:"prNumber"`
	Title       string     `json:"title"`
	TargetSHA   string     `json:"targetSha"`
	Status      string     `json:"status"`
	LatestRun   *reviewRun `json:"latestRun,omitempty"`
	PreviousRun *reviewRun `json:"previousRun,omitempty"`
}

type listReviewsResponse struct {
	ReviewerHandleID string        `json:"reviewerHandleId"`
	Reviews          []reviewState `json:"reviews"`
}

// triggerReviewResponse mirrors controllers.TriggerReviewResponse. Only the
// Created flag is needed here, to report whether a new pass was started.
type triggerReviewResponse struct {
	Created bool `json:"created"`
}

// reviewRunResponse mirrors controllers.ReviewRunResponse.
type reviewRunResponse struct {
	Review           reviewRun   `json:"review"`
	Reviews          []reviewRun `json:"reviews"`
	ReviewerHandleID string      `json:"reviewerHandleId"`
}

// submitReviewItem mirrors controllers.SubmitReviewItem.
type submitReviewItem struct {
	RunID          string `json:"runId"`
	Status         string `json:"status,omitempty"`
	Verdict        string `json:"verdict"`
	Body           string `json:"body,omitempty"`
	GithubReviewID string `json:"githubReviewId,omitempty"`
}

type qwenNativeRecord struct {
	SchemaVersion   int             `json:"schemaVersion"`
	NativeTarget    string          `json:"nativeTarget"`
	TargetSHA       string          `json:"targetSha"`
	RequestedEffort string          `json:"requestedEffort,omitempty"`
	EffectiveEffort string          `json:"effectiveEffort,omitempty"`
	Completion      string          `json:"completion"`
	Reason          string          `json:"reason,omitempty"`
	ProviderResult  json.RawMessage `json:"providerResult,omitempty"`
	RawStdout       string          `json:"rawStdout,omitempty"`
}

// submitReviewRequest mirrors controllers.SubmitReviewInput.
type submitReviewRequest struct {
	RunID          string             `json:"runId,omitempty"`
	Status         string             `json:"status,omitempty"`
	Verdict        string             `json:"verdict,omitempty"`
	Body           string             `json:"body,omitempty"`
	GithubReviewID string             `json:"githubReviewId,omitempty"`
	Reviews        []submitReviewItem `json:"reviews,omitempty"`
}

type reviewSubmitOptions struct {
	session  string
	runID    string
	verdict  string
	body     string
	reviewID string
	reviews  string
}

type reviewSessionOptions struct {
	session string
}

type reviewListOptions struct {
	json bool
}

func newReviewCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "review",
		Short: "Manage AO code reviews of a worker's PR",
	}
	cmd.AddCommand(newReviewListCommand(ctx))
	cmd.AddCommand(newReviewSubmitCommand(ctx))
	cmd.AddCommand(newReviewCancelCommand(ctx))
	cmd.AddCommand(newReviewTriggerCommand(ctx))
	cmd.AddCommand(newQwenNativeRunCommand(ctx))
	return cmd
}

func newQwenNativeRunCommand(ctx *commandContext) *cobra.Command {
	var manifestPath string
	cmd := &cobra.Command{
		Use:    "qwen-native-run",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.runQwenNative(cmd, manifestPath)
		},
	}
	cmd.Flags().StringVar(&manifestPath, "manifest", "", "AO-owned native review manifest")
	return cmd
}

func (c *commandContext) runQwenNative(cmd *cobra.Command, manifestPath string) error {
	manifestPath = strings.TrimSpace(manifestPath)
	if manifestPath == "" {
		return usageError{errors.New("usage: --manifest is required")}
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read native Qwen manifest: %w", err)
	}
	defer func() { _ = os.Remove(manifestPath) }()
	var manifest nativeqwen.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return fmt.Errorf("decode native Qwen manifest: %w", err)
	}
	if err := manifest.Validate(); err != nil {
		return err
	}
	runCtx, cancel := context.WithCancel(cmd.Context())
	defer cancel()
	stopEscapeWatch := watchNativeReviewEscape(runCtx, cmd.InOrStdin(), cancel)
	defer stopEscapeWatch()
	failed := 0
	for _, task := range manifest.Tasks {
		resultPath := qwenNativeSubmissionPath(manifestPath, task.RunID)
		item, cached, err := readQwenNativeSubmission(resultPath, task)
		if err != nil {
			return err
		}
		if !cached {
			stdout, exitCode, runErr := c.deps.NativeQwenRun(runCtx, manifest.QwenBinary, manifest.WorkspacePath, task, cmd.ErrOrStderr())
			if runCtx.Err() != nil {
				return runCtx.Err()
			}
			outcome := nativeqwen.Outcome{Status: "failed", Reason: "Qwen review process failed to start"}
			if runErr == nil {
				outcome = nativeqwen.Parse(stdout, exitCode)
			} else {
				outcome.Reason = runErr.Error()
			}
			record := qwenNativeRecord{
				SchemaVersion:   1,
				NativeTarget:    task.Target,
				TargetSHA:       task.TargetSHA,
				RequestedEffort: task.Options.Effort,
				EffectiveEffort: effectiveNativeEffort(task.Options),
				Completion:      outcome.Status,
				Reason:          outcome.Reason,
			}
			if json.Valid(outcome.Raw) {
				record.ProviderResult = outcome.Raw
			} else if len(outcome.Raw) > 0 {
				record.RawStdout = string(outcome.Raw)
			}
			body, err := json.MarshalIndent(record, "", "  ")
			if err != nil {
				return fmt.Errorf("encode native Qwen result: %w", err)
			}
			item = submitReviewRequest{RunID: task.RunID, Status: outcome.Status, Verdict: outcome.Verdict, Body: string(body)}
			// Persist before contacting AO. If the daemon request fails after Qwen
			// already posted optional PR comments, restore replays this exact
			// idempotent submission instead of running the provider a second time.
			if err := writeQwenNativeSubmission(resultPath, item); err != nil {
				return fmt.Errorf("persist native Qwen result for run %s: %w", task.RunID, err)
			}
		}
		path := "sessions/" + url.PathEscape(manifest.WorkerSessionID) + "/reviews/submit"
		var response reviewRunResponse
		if err := c.postJSON(runCtx, path, item, &response); err != nil {
			return fmt.Errorf("record native Qwen result for run %s: %w", task.RunID, err)
		}
		if err := os.Remove(resultPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove recorded native Qwen result for run %s: %w", task.RunID, err)
		}
		if item.Status == "failed" {
			failed++
			_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "native Qwen review failed for %s\n", task.Target)
		} else {
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "recorded %s native Qwen review for %s\n", item.Verdict, task.Target)
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d native Qwen review(s) did not produce a verdict", failed)
	}
	return nil
}

func qwenNativeSubmissionPath(manifestPath, runID string) string {
	hash := sha256.Sum256([]byte(runID))
	return filepath.Join(filepath.Dir(manifestPath), fmt.Sprintf("native-result-%x.json", hash[:12]))
}

func readQwenNativeSubmission(path string, task nativeqwen.Task) (submitReviewRequest, bool, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return submitReviewRequest{}, false, nil
	}
	if err != nil {
		return submitReviewRequest{}, false, fmt.Errorf("read recorded native Qwen result: %w", err)
	}
	var item submitReviewRequest
	if err := json.Unmarshal(raw, &item); err != nil {
		return submitReviewRequest{}, false, fmt.Errorf("decode recorded native Qwen result: %w", err)
	}
	var record qwenNativeRecord
	if err := json.Unmarshal([]byte(item.Body), &record); err != nil || item.RunID != task.RunID || record.NativeTarget != task.Target || record.TargetSHA != task.TargetSHA {
		return submitReviewRequest{}, false, errors.New("recorded native Qwen result does not match the current run target")
	}
	return item, true, nil
}

func writeQwenNativeSubmission(path string, item submitReviewRequest) error {
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".native-result-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func watchNativeReviewEscape(ctx context.Context, input io.Reader, cancel context.CancelFunc) func() {
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 1)
		for {
			if _, err := input.Read(buf); err != nil {
				return
			}
			if buf[0] == '\x1b' {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
	return func() {
		// Production uses the wrapper process's stdin file. Closing it releases a
		// blocked Read when the provider finishes normally, so the input watcher
		// cannot outlive the one-shot command.
		if closer, ok := input.(io.Closer); ok {
			_ = closer.Close()
			<-done
			return
		}
		select {
		case <-done:
		default:
		}
	}
}

func effectiveNativeEffort(options nativeqwen.Options) string {
	if options.Comment {
		return "high"
	}
	return options.Effort
}

func newReviewListCommand(ctx *commandContext) *cobra.Command {
	var opts reviewListOptions
	cmd := &cobra.Command{
		Use:     "ls <worker-session-id>",
		Aliases: []string{"list"},
		Short:   "List reviews for a worker session",
		Args:    usageArgs(cobra.ExactArgs(1)),
		RunE: func(cmd *cobra.Command, args []string) error {
			session := strings.TrimSpace(args[0])
			if session == "" {
				return usageError{errors.New("worker session id must not be blank")}
			}
			var res listReviewsResponse
			path := "sessions/" + url.PathEscape(session) + "/reviews"
			if err := ctx.getJSON(cmd.Context(), path, &res); err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), res)
			}
			return writeReviewList(cmd, session, res)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output reviews as JSON")
	return cmd
}

func newReviewSubmitCommand(ctx *commandContext) *cobra.Command {
	var opts reviewSubmitOptions
	cmd := &cobra.Command{
		Use:   "submit [worker-session-id]",
		Short: "Record a reviewer's result for a worker's PR",
		Args:  atMostOneArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.submitReview(cmd, args, opts)
		},
	}
	// Reviewer agents routinely spell flags with underscores (--review_id) rather
	// than hyphens (--review-id); normalize so both resolve to the same flag.
	cmd.Flags().SetNormalizeFunc(func(_ *pflag.FlagSet, name string) pflag.NormalizedName {
		return pflag.NormalizedName(strings.ReplaceAll(name, "_", "-"))
	})
	cmd.Flags().StringVar(&opts.session, "session", "", "Worker session id (or pass it as the positional argument)")
	cmd.Flags().StringVar(&opts.runID, "run", "", "Review run id (required)")
	cmd.Flags().StringVar(&opts.verdict, "verdict", "", "Review verdict: approved, comment, or changes_requested (required)")
	cmd.Flags().StringVar(&opts.body, "body", "", "Review body: a path to a Markdown file, or - to read from stdin (so nothing is written into the worktree)")
	cmd.Flags().StringVar(&opts.reviewID, "review-id", "", "Id of the GitHub PR review just posted (the .id from the gh api POST that created the review)")
	cmd.Flags().StringVar(&opts.reviews, "reviews", "", "JSON review results array or object: a path, or - to read from stdin")
	return cmd
}

func (c *commandContext) submitReview(cmd *cobra.Command, args []string, opts reviewSubmitOptions) error {
	session := strings.TrimSpace(opts.session)
	if len(args) == 1 {
		session = strings.TrimSpace(args[0])
	}
	if session == "" {
		return usageError{errors.New("usage: worker session id is required (positional or --session)")}
	}
	if strings.TrimSpace(opts.reviews) != "" {
		return c.submitReviewBatch(cmd, session, opts)
	}
	runID := strings.TrimSpace(opts.runID)
	if runID == "" {
		return usageError{errors.New("usage: --run is required")}
	}
	verdict := strings.TrimSpace(opts.verdict)
	if verdict == "" {
		return usageError{errors.New("usage: --verdict is required (approved, comment, or changes_requested)")}
	}
	var body string
	if path := strings.TrimSpace(opts.body); path != "" {
		var raw []byte
		var err error
		if path == "-" {
			// Read the review from stdin so the reviewer never has to write a file
			// into its checkout (where it could be committed onto the worker branch).
			raw, err = io.ReadAll(cmd.InOrStdin())
		} else {
			raw, err = os.ReadFile(path)
		}
		if err != nil {
			return usageError{fmt.Errorf("read review body: %w", err)}
		}
		body = string(raw)
	}
	reviewID := strings.TrimSpace(opts.reviewID)
	path := "sessions/" + url.PathEscape(session) + "/reviews/submit"
	var res reviewRunResponse
	if err := c.postJSON(cmd.Context(), path, submitReviewRequest{RunID: runID, Verdict: verdict, Body: body, GithubReviewID: reviewID}, &res); err != nil {
		return err
	}
	_, err := fmt.Fprintf(cmd.OutOrStdout(), "recorded %s review for %s\n", res.Review.Verdict, session)
	return err
}

func (c *commandContext) submitReviewBatch(cmd *cobra.Command, session string, opts reviewSubmitOptions) error {
	if strings.TrimSpace(opts.runID) != "" || strings.TrimSpace(opts.verdict) != "" || strings.TrimSpace(opts.body) != "" || strings.TrimSpace(opts.reviewID) != "" {
		return usageError{errors.New("usage: --reviews cannot be combined with --run, --verdict, --body, or --review-id")}
	}
	reviews, err := readReviewItems(cmd, strings.TrimSpace(opts.reviews))
	if err != nil {
		return err
	}
	path := "sessions/" + url.PathEscape(session) + "/reviews/submit"
	var res reviewRunResponse
	if err := c.postJSON(cmd.Context(), path, submitReviewRequest{Reviews: reviews}, &res); err != nil {
		return err
	}
	count := len(res.Reviews)
	if count == 0 {
		count = len(reviews)
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "recorded %d review(s) for %s\n", count, session)
	return err
}

func newReviewCancelCommand(ctx *commandContext) *cobra.Command {
	var opts reviewSessionOptions
	cmd := &cobra.Command{
		Use:     "cancel [worker-session-id]",
		Aliases: []string{"stop"},
		Short:   "Cancel any running review for a worker's PR",
		Args:    atMostOneArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.stopReview(cmd, args, opts)
		},
	}
	cmd.Flags().StringVar(&opts.session, "session", "", "Worker session id (or pass it as the positional argument)")
	return cmd
}

func newReviewTriggerCommand(ctx *commandContext) *cobra.Command {
	var opts reviewSessionOptions
	cmd := &cobra.Command{
		Use:     "trigger [worker-session-id]",
		Aliases: []string{"execute", "restart"},
		Short:   "Trigger a new review pass for a worker's PR",
		Args:    atMostOneArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.restartReview(cmd, args, opts)
		},
	}
	cmd.Flags().StringVar(&opts.session, "session", "", "Worker session id (or pass it as the positional argument)")
	return cmd
}

func (c *commandContext) stopReview(cmd *cobra.Command, args []string, opts reviewSessionOptions) error {
	session := strings.TrimSpace(opts.session)
	if len(args) == 1 {
		session = strings.TrimSpace(args[0])
	}
	if session == "" {
		return usageError{errors.New("usage: worker session id is required (positional or --session)")}
	}
	path := "sessions/" + url.PathEscape(session) + "/reviews/cancel"
	if err := c.postJSON(cmd.Context(), path, struct{}{}, nil); err != nil {
		return err
	}
	_, err := fmt.Fprintf(cmd.OutOrStdout(), "cancelled review for %s\n", session)
	return err
}

func (c *commandContext) restartReview(cmd *cobra.Command, args []string, opts reviewSessionOptions) error {
	session := strings.TrimSpace(opts.session)
	if len(args) == 1 {
		session = strings.TrimSpace(args[0])
	}
	if session == "" {
		return usageError{errors.New("usage: worker session id is required (positional or --session)")}
	}
	path := "sessions/" + url.PathEscape(session) + "/reviews/trigger"
	// Decode the response so we can tell whether a new pass was started or an
	// existing run for the same commit was reused, and report it accurately.
	var res triggerReviewResponse
	if err := c.postJSON(cmd.Context(), path, struct{}{}, &res); err != nil {
		return err
	}
	msg := "reused the existing review for %s\n"
	if res.Created {
		msg = "started a new review for %s\n"
	}
	_, err := fmt.Fprintf(cmd.OutOrStdout(), msg, session)
	return err
}

func writeReviewList(cmd *cobra.Command, session string, res listReviewsResponse) error {
	out := cmd.OutOrStdout()
	if len(res.Reviews) == 0 {
		_, err := fmt.Fprintf(out, "No reviews found for %s.\n", session)
		return err
	}

	tw := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "PR\tSTATUS\tVERDICT\tTITLE"); err != nil {
		return err
	}
	for _, review := range res.Reviews {
		verdict := "-"
		if review.LatestRun != nil && review.LatestRun.Verdict != "" {
			verdict = review.LatestRun.Verdict
		}
		if _, err := fmt.Fprintf(tw, "#%d\t%s\t%s\t%s\n", review.PRNumber, review.Status, verdict, review.Title); err != nil {
			return err
		}
	}
	return tw.Flush()
}

func readReviewItems(cmd *cobra.Command, path string) ([]submitReviewItem, error) {
	var raw []byte
	var err error
	if path == "-" {
		raw, err = io.ReadAll(cmd.InOrStdin())
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, usageError{fmt.Errorf("read review results: %w", err)}
	}
	var req submitReviewRequest
	if err := json.Unmarshal(raw, &req); err == nil && len(req.Reviews) > 0 {
		return req.Reviews, nil
	}
	var reviews []submitReviewItem
	if err := json.Unmarshal(raw, &reviews); err != nil {
		return nil, usageError{fmt.Errorf("decode review results JSON: %w", err)}
	}
	if len(reviews) == 0 {
		return nil, usageError{errors.New("usage: --reviews requires at least one review result")}
	}
	return reviews, nil
}
