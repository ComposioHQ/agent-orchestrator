package github

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// ReviewPublisher posts an AO review to a GitHub pull request.
type ReviewPublisher interface {
	Publish(ctx context.Context, prURL, commitSHA, body string, comments []ports.ReviewComment) (string, error)
}

type reviewPublisher struct {
	execute func(context.Context, []string, []byte) ([]byte, error)
}

// NewReviewPublisher builds the production gh-backed publisher. A missing gh
// binary or authentication is reported per review so AO can still record and
// deliver the result locally.
func NewReviewPublisher() ReviewPublisher {
	return &reviewPublisher{execute: executeReview}
}

type reviewPayload struct {
	CommitID string          `json:"commit_id,omitempty"`
	Body     string          `json:"body"`
	Event    string          `json:"event"`
	Comments []inlineComment `json:"comments,omitempty"`
}

type inlineComment struct {
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Side      string `json:"side"`
	StartLine int    `json:"start_line,omitempty"`
	StartSide string `json:"start_side,omitempty"`
	Body      string `json:"body"`
}

func (p *reviewPublisher) Publish(ctx context.Context, prURL, commitSHA, body string, comments []ports.ReviewComment) (string, error) {
	owner, repo, number, err := pullRequestRef(prURL)
	if err != nil {
		return "", err
	}
	payload := reviewPayload{
		CommitID: strings.TrimSpace(commitSHA),
		Body:     strings.TrimSpace(body),
		Event:    "COMMENT",
		Comments: inlineComments(comments),
	}
	if payload.Body == "" {
		payload.Body = "AO reported a completed review on this pull request."
	}
	endpoint := "repos/" + owner + "/" + repo + "/pulls/" + strconv.Itoa(number) + "/reviews"
	id, err := p.publish(ctx, endpoint, payload)
	if err == nil || len(payload.Comments) == 0 || !inlineValidationFailure(err) {
		return id, err
	}

	// GitHub rejects an entire review when any inline location is no longer on
	// the diff. The full normalized findings are already present in Body, so a
	// summary-only retry keeps the review visible without losing information.
	payload.Comments = nil
	payload.Body += "\n\n> Some findings could not be attached inline because GitHub no longer accepted their diff locations. All findings are included in this review summary."
	return p.publish(ctx, endpoint, payload)
}

func (p *reviewPublisher) publish(ctx context.Context, endpoint string, payload reviewPayload) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode GitHub review: %w", err)
	}
	response, err := p.execute(ctx, []string{"gh", "api", "--method", "POST", "--input", "-", endpoint}, raw)
	if err != nil {
		return "", err
	}
	var decoded struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(response, &decoded); err != nil {
		return "", fmt.Errorf("decode GitHub review response: %w", err)
	}
	id := strings.Trim(strings.TrimSpace(string(decoded.ID)), "\"")
	if id == "" || id == "null" {
		return "", fmt.Errorf("GitHub review response did not include an id")
	}
	return id, nil
}

func pullRequestRef(raw string) (owner, repo string, number int, err error) {
	u, parseErr := url.Parse(strings.TrimSpace(raw))
	if parseErr != nil || u.Hostname() != "github.com" {
		return "", "", 0, fmt.Errorf("GitHub inline review requires a github.com pull request URL")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" {
		return "", "", 0, fmt.Errorf("invalid GitHub pull request URL %q", raw)
	}
	n, parseErr := strconv.Atoi(parts[3])
	if parseErr != nil || n <= 0 || parts[0] == "" || parts[1] == "" {
		return "", "", 0, fmt.Errorf("invalid GitHub pull request URL %q", raw)
	}
	return parts[0], parts[1], n, nil
}

func inlineComments(comments []ports.ReviewComment) []inlineComment {
	out := make([]inlineComment, 0, len(comments))
	for _, comment := range comments {
		path := strings.ReplaceAll(strings.TrimSpace(comment.Path), "\\", "/")
		body := strings.TrimSpace(comment.Body)
		line := comment.EndLine
		if line <= 0 {
			line = comment.StartLine
		}
		if path == "" || line <= 0 || body == "" {
			continue
		}
		side := strings.ToUpper(strings.TrimSpace(comment.Side))
		if side != "LEFT" && side != "RIGHT" {
			side = "RIGHT"
		}
		if suggestion := strings.TrimSpace(comment.Suggestion); suggestion != "" {
			body += "\n\nSuggested fix:\n" + suggestion
		}
		item := inlineComment{Path: path, Line: line, Side: side, Body: body}
		if comment.StartLine > 0 && comment.StartLine < line {
			item.StartLine = comment.StartLine
			item.StartSide = side
		}
		out = append(out, item)
	}
	return out
}

func inlineValidationFailure(err error) bool {
	if err == nil {
		return false
	}
	detail := strings.ToLower(err.Error())
	return strings.Contains(detail, "http 422") || strings.Contains(detail, "validation failed")
}

func executeReview(ctx context.Context, argv []string, input []byte) ([]byte, error) {
	if len(argv) == 0 {
		return nil, fmt.Errorf("GitHub review command is empty")
	}
	cmd := aoprocess.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return nil, fmt.Errorf("post GitHub review: %w: %s", err, detail)
		}
		return nil, fmt.Errorf("post GitHub review: %w", err)
	}
	return stdout.Bytes(), nil
}
