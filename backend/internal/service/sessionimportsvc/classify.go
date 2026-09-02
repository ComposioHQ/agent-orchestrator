package sessionimportsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/sessionimport"
)

// AgentRegistry resolves the adapter driving a harness, so classification can
// ask the very CLI that wrote a transcript to judge it.
type AgentRegistry interface {
	Agent(domain.AgentHarness) (ports.Agent, bool)
}

// maxClassifyBatch caps how many conversations go into one question. The reply
// has to stay a parseable list, and a long tail of low-value rows is not worth
// a second call.
const maxClassifyBatch = 40

// maxExcerptRunes bounds the prompt text sent per conversation. A first line or
// two is enough to tell a real request from a greeting, and sending less of the
// user's content is better on every axis: privacy, tokens, and latency.
const maxExcerptRunes = 240

// classifier resolves conversations the local heuristic could not place, by
// asking the user's own authorized agent.
//
// AO ships no model and holds no API key. The user has already authorized
// Claude Code or Codex; classification runs one short, tool-free, non-
// interactive call against that CLI, so their existing subscription is what
// pays and their transcripts stay with the provider that already has them.
type classifier struct {
	agents  AgentRegistry
	cache   *verdictCache
	workDir string
	logger  *slog.Logger
}

// resolve settles ambiguous conversations in place and returns the list with
// any newly-judged trivial ones removed.
//
// Every failure path is a no-op: an unauthorized agent, a CLI without one-shot
// support, a timeout, or an unparseable reply all leave the conversation
// ambiguous and therefore still visible. Classification refines the list; it is
// never the reason something disappears.
func (c *classifier) resolve(ctx context.Context, sessions []sessionimport.ImportableSession) []sessionimport.ImportableSession {
	if c == nil || c.agents == nil || len(sessions) == 0 {
		return sessions
	}

	pending := map[domain.AgentHarness][]int{}
	for i := range sessions {
		if sessions[i].Meaning != sessionimport.MeaningAmbiguous {
			continue
		}
		if verdict, ok := c.cache.get(sessions[i]); ok {
			sessions[i].Meaning = verdict
			continue
		}
		pending[sessions[i].Provider] = append(pending[sessions[i].Provider], i)
	}

	for _, provider := range sortedProviders(pending) {
		indexes := pending[provider]
		if len(indexes) > maxClassifyBatch {
			indexes = indexes[:maxClassifyBatch]
		}
		verdicts, err := c.ask(ctx, provider, sessions, indexes)
		if err != nil {
			c.logger.Debug("session import: classification unavailable; keeping ambiguous conversations",
				"provider", provider, "count", len(indexes), "error", err)
			continue
		}
		for _, idx := range indexes {
			verdict, ok := verdicts[sessions[idx].NativeSessionID]
			if !ok {
				continue
			}
			sessions[idx].Meaning = verdict
			c.cache.put(sessions[idx], verdict)
		}
	}
	c.cache.flush()

	kept := sessions[:0]
	for _, session := range sessions {
		if session.Meaning.Imported() {
			kept = append(kept, session)
		}
	}
	return kept
}

// ask puts one batched question to a provider's CLI and returns the verdicts by
// native session id.
func (c *classifier) ask(
	ctx context.Context,
	provider domain.AgentHarness,
	sessions []sessionimport.ImportableSession,
	indexes []int,
) (map[string]sessionimport.Meaning, error) {
	agent, ok := c.agents.Agent(provider)
	if !ok {
		return nil, fmt.Errorf("no adapter for %s", provider)
	}
	runner, ok := agent.(ports.AgentOneShot)
	if !ok {
		return nil, fmt.Errorf("%s cannot answer a one-shot prompt", provider)
	}
	// An agent the user has not logged into cannot answer, and asking anyway
	// would surface a login error as if it were a classification failure.
	// "unknown" is advisory, not a refusal, so it is still worth attempting.
	if checker, ok := agent.(ports.AgentAuthChecker); ok {
		if status, err := checker.AuthStatus(ctx); err == nil && status == ports.AgentAuthStatusUnauthorized {
			return nil, fmt.Errorf("%s is not authorized", provider)
		}
	}

	out, err := runner.RunOneShot(ctx, c.workDir, classifyPrompt(sessions, indexes))
	if err != nil {
		return nil, err
	}
	return parseVerdicts(out)
}

// classifyPrompt builds the batched question. It sends a title and a short
// excerpt per conversation, never a transcript.
func classifyPrompt(sessions []sessionimport.ImportableSession, indexes []int) string {
	var b strings.Builder
	b.WriteString("You are judging whether coding-assistant conversations are worth keeping.\n")
	b.WriteString("Reply with ONLY a JSON array and no prose:\n")
	b.WriteString(`[{"id":"<id>","verdict":"meaningful"}]` + "\n\n")
	b.WriteString("verdict must be \"meaningful\" or \"trivial\".\n")
	b.WriteString("trivial: a greeting, a smoke test, an aborted attempt, a failed login, or anything with no lasting value.\n")
	b.WriteString("meaningful: a real task, question, decision, investigation, implementation, or a discussion worth returning to.\n")
	b.WriteString("When genuinely unsure, answer \"meaningful\": discarding real work is the worse mistake.\n\n")
	b.WriteString("Conversations:\n")

	for _, idx := range indexes {
		s := sessions[idx]
		b.WriteString(fmt.Sprintf("- id=%s | folder=%s | messages=%d | title=%q | first prompt=%q\n",
			s.NativeSessionID,
			filepath.Base(strings.TrimSpace(s.CWD)),
			s.MessageCount,
			excerpt(s.Title),
			excerpt(s.FirstPrompt),
		))
	}
	return b.String()
}

func excerpt(text string) string {
	text = strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	runes := []rune(text)
	if len(runes) <= maxExcerptRunes {
		return text
	}
	return string(runes[:maxExcerptRunes]) + "…"
}

// parseVerdicts reads the JSON array out of a CLI reply. Agents often wrap the
// answer in prose or a code fence despite instructions, so the array is located
// rather than assumed to be the whole output.
func parseVerdicts(out string) (map[string]sessionimport.Meaning, error) {
	start := strings.Index(out, "[")
	end := strings.LastIndex(out, "]")
	if start < 0 || end < start {
		return nil, fmt.Errorf("no JSON array in reply")
	}
	var rows []struct {
		ID      string `json:"id"`
		Verdict string `json:"verdict"`
	}
	if err := json.Unmarshal([]byte(out[start:end+1]), &rows); err != nil {
		return nil, fmt.Errorf("unparseable reply: %w", err)
	}
	verdicts := make(map[string]sessionimport.Meaning, len(rows))
	for _, row := range rows {
		id := strings.TrimSpace(row.ID)
		if id == "" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(row.Verdict)) {
		case "trivial":
			verdicts[id] = sessionimport.MeaningTrivial
		case "meaningful":
			verdicts[id] = sessionimport.MeaningMeaningful
		default:
			// An answer AO does not recognize is not evidence of anything.
		}
	}
	if len(verdicts) == 0 {
		return nil, fmt.Errorf("reply carried no usable verdicts")
	}
	return verdicts, nil
}

// sortedProviders keeps batching deterministic, which matters for tests and for
// reading logs.
func sortedProviders(pending map[domain.AgentHarness][]int) []domain.AgentHarness {
	providers := make([]domain.AgentHarness, 0, len(pending))
	for provider := range pending {
		providers = append(providers, provider)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i] < providers[j] })
	return providers
}
