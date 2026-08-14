package agyjson

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/processenv"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const maxStreamLineBytes = 8 << 20

type conversation struct {
	ctx    context.Context
	cancel context.CancelFunc

	binary                string
	workspacePath         string
	env                   map[string]string
	model                 string
	permissions           ports.PermissionMode
	systemPrompt          string
	additionalDirectories []string
	hookToken             string
	log                   *slog.Logger

	mu                     sync.Mutex
	providerConversationID string
	deferred               map[string]ports.ChatUserMessage
	approvals              map[string]chan ports.ChatDecision
	active                 *activeTurn
	closed                 bool

	events      chan ports.ChatEvent
	turnSeq     atomic.Uint64
	eventSeq    atomic.Uint64
	approvalSeq atomic.Uint64
	wg          sync.WaitGroup
	closeOnce   sync.Once
}

type activeTurn struct {
	id          string
	cancel      context.CancelFunc
	permission  ports.PermissionMode
	interrupted bool
	resultSeen  bool
	resultState domain.TurnState
	resultErr   error
}

var (
	_ ports.ChatConversation        = (*conversation)(nil)
	_ ports.ChatDeferredTurnStarter = (*conversation)(nil)
)

func (c *conversation) ProviderConversationID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.providerConversationID
}

func (c *conversation) Capabilities() ports.ChatCapabilities { return capabilities() }

func (c *conversation) Events() <-chan ports.ChatEvent { return c.events }

func (c *conversation) SendTurn(ctx context.Context, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	if err := ctx.Err(); err != nil {
		return ports.ChatTurnRef{}, err
	}
	if strings.TrimSpace(msg.Text) == "" {
		return ports.ChatTurnRef{}, errors.New("agy chat: message text is required")
	}
	if len(msg.Content) != 0 {
		return ports.ChatTurnRef{}, fmt.Errorf("%w: Agy stream-json chat does not support structured content blocks", ports.ErrChatUnsupported)
	}
	if strings.TrimSpace(msg.Settings.Effort) != "" {
		return ports.ChatTurnRef{}, fmt.Errorf("%w: Agy stream-json chat does not expose a per-turn reasoning-effort control", ports.ErrChatConfigOptionInvalid)
	}

	turnID := fmt.Sprintf("agy-turn-%d", c.turnSeq.Add(1))
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return ports.ChatTurnRef{}, errors.New("agy chat: conversation is closed")
	}
	if c.active != nil {
		return ports.ChatTurnRef{}, errors.New("agy chat: a turn is already active")
	}
	c.deferred[turnID] = msg
	return ports.ChatTurnRef{ProviderTurnID: turnID}, nil
}

func (c *conversation) StartDeferredTurn(providerTurnID string) error {
	c.mu.Lock()
	msg, ok := c.deferred[providerTurnID]
	if !ok {
		c.mu.Unlock()
		return fmt.Errorf("agy chat: deferred turn %s not found", providerTurnID)
	}
	if c.closed {
		delete(c.deferred, providerTurnID)
		c.mu.Unlock()
		return errors.New("agy chat: conversation is closed")
	}
	if c.active != nil {
		c.mu.Unlock()
		return fmt.Errorf("agy chat: turn %s is already active", c.active.id)
	}
	delete(c.deferred, providerTurnID)
	turnCtx, cancel := context.WithCancel(c.ctx)
	c.active = &activeTurn{
		id: providerTurnID, cancel: cancel,
		permission: effectivePermission(c.permissions, msg.Settings.Approval),
	}
	c.wg.Add(1)
	c.mu.Unlock()

	go c.runTurn(turnCtx, providerTurnID, msg)
	return nil
}

func (c *conversation) DiscardDeferredTurn(providerTurnID string) {
	c.mu.Lock()
	delete(c.deferred, providerTurnID)
	c.mu.Unlock()
}

func (c *conversation) Interrupt(ctx context.Context, providerTurnID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active == nil || c.active.id != providerTurnID {
		return ports.ErrChatNoActiveTurn
	}
	c.active.interrupted = true
	c.active.cancel()
	return nil
}

func (c *conversation) ResolveRequest(ctx context.Context, requestID string, decision ports.ChatDecision) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if decision.ID != "allow" && decision.ID != "deny" {
		return ports.ErrChatDecisionNotOffered
	}

	c.mu.Lock()
	ch, ok := c.approvals[requestID]
	if ok {
		delete(c.approvals, requestID)
	}
	c.mu.Unlock()
	if !ok {
		return ports.ErrChatRequestNotPending
	}
	select {
	case ch <- decision:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-c.ctx.Done():
		return ports.ErrChatRequestNotPending
	}
}

func (c *conversation) Close() error {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
		c.cancel()
		c.wg.Wait()
		close(c.events)
	})
	return nil
}

func (c *conversation) runTurn(ctx context.Context, turnID string, msg ports.ChatUserMessage) {
	defer c.wg.Done()

	args := c.turnArgs(msg)
	cmd := aoprocess.CommandContext(ctx, c.binary, args...)
	cmd.Dir = c.workspacePath
	env := cloneMap(c.env)
	env[hookTokenEnv] = c.hookToken
	cmd.Env = processenv.Merge(env)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		c.finishTurnWithError(turnID, fmt.Errorf("open stdout: %w", err), false)
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		c.finishTurnWithError(turnID, fmt.Errorf("start agy: %w", err), false)
		return
	}

	c.emit(ports.ChatEvent{
		Kind:            ports.ChatEventTurnStarted,
		ProviderEventID: c.newEventID(turnID, "started"),
		ProviderTurnID:  turnID,
		ControllerState: ports.ChatControllerBusy,
	})

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), maxStreamLineBytes)
	resultSeen := false
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		seen, normalizeErr := c.normalizeStreamLine(turnID, line)
		if normalizeErr != nil {
			c.emitError(turnID, normalizeErr)
			continue
		}
		resultSeen = resultSeen || seen
	}
	scanErr := scanner.Err()
	waitErr := cmd.Wait()

	c.mu.Lock()
	interrupted := c.active != nil && c.active.id == turnID && c.active.interrupted
	resultState := domain.TurnStateCompleted
	var resultErr error
	if c.active != nil && c.active.id == turnID && c.active.resultSeen {
		resultState = c.active.resultState
		resultErr = c.active.resultErr
	}
	c.mu.Unlock()

	if interrupted {
		c.emitTurnCompleted(turnID, domain.TurnStateInterrupted, nil)
		return
	}
	if scanErr != nil {
		c.finishTurnWithError(turnID, fmt.Errorf("read agy stream: %w", scanErr), false)
		return
	}
	if waitErr != nil && !resultSeen {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = waitErr.Error()
		}
		c.finishTurnWithError(turnID, errors.New(detail), false)
		return
	}
	if !resultSeen {
		c.finishTurnWithError(turnID, errors.New("agy stream ended without a result event"), false)
		return
	}
	c.emitTurnCompleted(turnID, resultState, resultErr)
}

func (c *conversation) turnArgs(msg ports.ChatUserMessage) []string {
	args := []string{"--output-format", "stream-json", "--add-dir", c.workspacePath}
	for _, dir := range c.additionalDirectories {
		if dir = strings.TrimSpace(dir); dir != "" && dir != c.workspacePath {
			args = append(args, "--add-dir", dir)
		}
	}
	model := strings.TrimSpace(msg.Settings.Model)
	if model == "" {
		model = c.model
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	if id := c.ProviderConversationID(); id != "" {
		args = append(args, "--conversation", id)
	}
	if effectivePermission(c.permissions, msg.Settings.Approval) == ports.PermissionModeBypassPermissions {
		args = append(args, "--dangerously-skip-permissions")
	}
	args = append(args, "--print", msg.Text)
	return args
}

func (c *conversation) normalizeStreamLine(turnID string, line []byte) (bool, error) {
	var envelope struct {
		Event          string         `json:"event"`
		ConversationID string         `json:"conversation_id"`
		StepUpdate     map[string]any `json:"step_update"`
		Result         map[string]any `json:"result"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil {
		return false, fmt.Errorf("decode agy stream event: %w", err)
	}
	switch envelope.Event {
	case "init":
		if envelope.ConversationID == "" {
			return false, errors.New("agy init event has no conversation_id")
		}
		if err := c.observeProviderID(envelope.ConversationID); err != nil {
			return false, err
		}
		return false, nil
	case "step_update":
		c.normalizeStepUpdate(turnID, envelope.StepUpdate)
		return false, nil
	case "result":
		c.normalizeResult(turnID, envelope.Result)
		return true, nil
	default:
		return false, nil
	}
}

func (c *conversation) normalizeStepUpdate(turnID string, update map[string]any) {
	if update == nil {
		return
	}
	stepType, _ := update["step_type"].(string)
	state, _ := update["state"].(string)
	step := int64Value(update["step_index"])
	itemID := fmt.Sprintf("%s-step-%d", turnID, step)

	switch stepType {
	case "agent_response":
		delta, _ := update["text_delta"].(string)
		if state == "ACTIVE" && delta != "" {
			c.emit(ports.ChatEvent{
				Kind:            ports.ChatEventMessageDelta,
				ProviderEventID: c.newEventID(turnID, "message-delta"),
				ProviderTurnID:  turnID,
				ProviderItemID:  turnID + "-assistant",
				Delta:           delta,
			})
		}
	case "tool":
		name, _ := update["tool_name"].(string)
		detail := toolDetail(update)
		status := domain.ActivityStatusRunning
		kind := domain.ActivityKindCommand
		if strings.HasPrefix(name, "mcp") {
			kind = domain.ActivityKindMCPTool
		}
		eventKind := ports.ChatEventActivityStarted
		switch state {
		case "DONE":
			status = domain.ActivityStatusCompleted
			eventKind = ports.ChatEventActivityCompleted
		case "ERROR":
			status = domain.ActivityStatusFailed
			eventKind = ports.ChatEventActivityCompleted
		}
		c.emit(ports.ChatEvent{
			Kind:            eventKind,
			ProviderEventID: c.newEventID(turnID, "tool"),
			ProviderTurnID:  turnID,
			ProviderItemID:  itemID,
			ActivityKind:    kind,
			ActivityStatus:  status,
			Summary:         firstNonEmpty(name, "Agy tool"),
			Detail:          detail,
		})
	}
}

func (c *conversation) normalizeResult(turnID string, result map[string]any) {
	state := domain.TurnStateCompleted
	var resultErr error

	if result == nil {
		state = domain.TurnStateFailed
		resultErr = errors.New("agy result event is missing its result payload")
	} else {
		response, _ := result["response"].(string)
		status, _ := result["status"].(string)
		errorText, _ := result["error"].(string)

		if response != "" {
			c.emit(ports.ChatEvent{
				Kind:            ports.ChatEventMessageCompleted,
				ProviderEventID: c.newEventID(turnID, "message-completed"),
				ProviderTurnID:  turnID,
				ProviderItemID:  turnID + "-assistant",
				Text:            response,
			})
		}

		if usage, ok := result["usage"].(map[string]any); ok {
			c.emitUsage(turnID, usage)
		}

		if strings.EqualFold(status, "error") || errorText != "" {
			state = domain.TurnStateFailed
			if errorText == "" {
				errorText = "Agy reported an error"
			}
			resultErr = errors.New(errorText)
		}
	}

	// The result frame is terminal at the protocol level, but the child process
	// may not have exited yet. Record its outcome here and let runTurn publish
	// turn.completed only after cmd.Wait returns. Otherwise the Chat queue can
	// dispatch the next turn while this process is still the active owner.
	c.mu.Lock()
	if c.active != nil && c.active.id == turnID {
		c.active.resultSeen = true
		c.active.resultState = state
		c.active.resultErr = resultErr
	}
	c.mu.Unlock()
}

func (c *conversation) emitUsage(turnID string, usage map[string]any) {
	input := int64MapValue(usage, "input_tokens", "inputTokens")
	output := int64MapValue(usage, "output_tokens", "outputTokens")
	cached := int64MapValue(usage, "cache_read_tokens", "cached_tokens", "cachedTokens")
	total := int64MapValue(usage, "total_tokens", "totalTokens")
	if total == 0 {
		total = input + output + cached
	}
	c.emit(ports.ChatEvent{
		Kind:            ports.ChatEventUsage,
		ProviderEventID: c.newEventID(turnID, "usage"),
		ProviderTurnID:  turnID,
		Usage: &ports.ChatUsage{
			InputTokens:  input,
			OutputTokens: output,
			CachedTokens: cached,
			TotalTokens:  total,
			TotalsKnown:  true,
		},
	})
}

func (c *conversation) emitTurnCompleted(turnID string, state domain.TurnState, err error) {
	// Release ownership before publishing completion. The Chat service drains
	// queued turns synchronously from this event, so publishing first creates a
	// race where SendTurn still observes the previous turn as active.
	c.mu.Lock()
	if c.active != nil && c.active.id == turnID {
		c.active = nil
	}
	c.mu.Unlock()

	c.emit(ports.ChatEvent{
		Kind:            ports.ChatEventTurnCompleted,
		ProviderEventID: c.newEventID(turnID, "completed"),
		ProviderTurnID:  turnID,
		TurnState:       state,
		Err:             err,
	})
}

func (c *conversation) finishTurnWithError(turnID string, err error, interrupted bool) {
	if interrupted {
		c.emitTurnCompleted(turnID, domain.TurnStateInterrupted, nil)
		return
	}
	c.emitError(turnID, err)
	c.emitTurnCompleted(turnID, domain.TurnStateFailed, err)
}

func (c *conversation) emitError(turnID string, err error) {
	if err == nil {
		return
	}
	c.emit(ports.ChatEvent{
		Kind:            ports.ChatEventError,
		ProviderEventID: c.newEventID(turnID, "error"),
		ProviderTurnID:  turnID,
		Err:             err,
		Summary:         err.Error(),
	})
}

func (c *conversation) emit(event ports.ChatEvent) {
	select {
	case c.events <- event:
	case <-c.ctx.Done():
	}
}

func (c *conversation) newEventID(turnID, kind string) string {
	return fmt.Sprintf("%s:%s:%d", turnID, kind, c.eventSeq.Add(1))
}

func (c *conversation) observeProviderID(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("agy chat: provider conversation id is empty")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.providerConversationID != "" && c.providerConversationID != id {
		return fmt.Errorf("agy chat: provider conversation changed from %s to %s", c.providerConversationID, id)
	}
	c.providerConversationID = id
	return nil
}

// HandleAgyChatHook bridges Antigravity's blocking hooks into AO Chat events.
// onProviderID is invoked immediately after token/identity validation so the
// daemon can persist a newly allocated native conversation before a tool waits
// for human approval.
func (c *conversation) HandleAgyChatHook(
	ctx context.Context,
	event string,
	token string,
	payload []byte,
	onProviderID func(string) error,
) (map[string]any, error) {
	if subtle.ConstantTimeCompare([]byte(token), []byte(c.hookToken)) != 1 {
		return nil, errors.New("agy chat hook token is invalid")
	}
	var common struct {
		ConversationID string `json:"conversationId"`
	}
	if err := json.Unmarshal(payload, &common); err != nil {
		return nil, fmt.Errorf("decode agy hook payload: %w", err)
	}
	if err := c.observeProviderID(common.ConversationID); err != nil {
		return nil, err
	}
	if onProviderID != nil {
		if err := onProviderID(common.ConversationID); err != nil {
			return nil, err
		}
	}

	switch event {
	case "pre-invocation":
		return c.handlePreInvocation(payload)
	case "pre-tool-use":
		return c.handlePreToolUse(ctx, payload)
	default:
		return nil, fmt.Errorf("agy chat: unsupported hook event %q", event)
	}
}

func (c *conversation) handlePreInvocation(payload []byte) (map[string]any, error) {
	var input struct {
		InvocationNum int `json:"invocationNum"`
	}
	if err := json.Unmarshal(payload, &input); err != nil {
		return nil, err
	}
	steps := []map[string]string{}
	if input.InvocationNum == 0 && strings.TrimSpace(c.systemPrompt) != "" {
		steps = append(steps, map[string]string{"ephemeralMessage": c.systemPrompt})
	}
	return map[string]any{"injectSteps": steps}, nil
}

func (c *conversation) handlePreToolUse(ctx context.Context, payload []byte) (map[string]any, error) {
	var input struct {
		StepIdx  int64 `json:"stepIdx"`
		ToolCall struct {
			Name string         `json:"name"`
			Args map[string]any `json:"args"`
		} `json:"toolCall"`
	}
	if err := json.Unmarshal(payload, &input); err != nil {
		return nil, err
	}
	if input.ToolCall.Name == "ask_question" || input.ToolCall.Name == "ask_permission" {
		return map[string]any{
			"decision": "deny",
			"reason":   "This Agy Chat driver does not yet support provider-side interactive questions; ask in normal assistant text instead.",
		}, nil
	}

	mode := c.currentApprovalMode()
	if toolAutoAllowed(mode, input.ToolCall.Name) {
		return map[string]any{"decision": "allow"}, nil
	}

	c.mu.Lock()
	turnID := ""
	if c.active != nil {
		turnID = c.active.id
	}
	c.mu.Unlock()
	if turnID == "" {
		return map[string]any{"decision": "deny", "reason": "AO has no active turn for this tool call."}, nil
	}

	requestID := fmt.Sprintf("%s-approval-%d", turnID, c.approvalSeq.Add(1))
	decisionCh := make(chan ports.ChatDecision, 1)
	c.mu.Lock()
	c.approvals[requestID] = decisionCh
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.approvals, requestID)
		c.mu.Unlock()
	}()

	detail, _ := json.Marshal(map[string]any{
		"tool":    input.ToolCall.Name,
		"args":    input.ToolCall.Args,
		"stepIdx": input.StepIdx,
	})
	c.emit(ports.ChatEvent{
		Kind:            ports.ChatEventApprovalRequested,
		ProviderEventID: c.newEventID(turnID, "approval"),
		ProviderTurnID:  turnID,
		ProviderItemID:  fmt.Sprintf("%s-tool-%d", turnID, input.StepIdx),
		RequestID:       requestID,
		Summary:         "Allow Agy to use " + firstNonEmpty(input.ToolCall.Name, "this tool") + "?",
		Detail:          detail,
		Decisions: []ports.ChatDecisionOption{
			{ID: "allow", Label: "Allow"},
			{ID: "deny", Label: "Deny"},
		},
	})

	select {
	case decision := <-decisionCh:
		if decision.ID == "allow" {
			return map[string]any{"decision": "allow"}, nil
		}
		return map[string]any{"decision": "deny", "reason": "Denied in Agent Orchestrator."}, nil
	case <-ctx.Done():
		return map[string]any{"decision": "deny", "reason": "Approval request was cancelled."}, nil
	case <-c.ctx.Done():
		return map[string]any{"decision": "deny", "reason": "Agy Chat controller stopped."}, nil
	}
}

func (c *conversation) currentApprovalMode() ports.PermissionMode {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active != nil {
		return c.active.permission
	}
	return c.permissions
}

func effectivePermission(base, turn ports.PermissionMode) ports.PermissionMode {
	if turn != "" {
		return turn
	}
	return base
}

func toolAutoAllowed(mode ports.PermissionMode, tool string) bool {
	switch mode {
	case ports.PermissionModeAuto, ports.PermissionModeBypassPermissions:
		return true
	case ports.PermissionModeAcceptEdits:
		switch tool {
		case "view_file", "list_dir", "find_by_name", "grep_search", "list_permissions",
			"write_to_file", "replace_file_content", "multi_replace_file_content":
			return true
		}
	default:
		switch tool {
		case "view_file", "list_dir", "find_by_name", "grep_search", "list_permissions":
			return true
		}
	}
	return false
}

func toolDetail(update map[string]any) []byte {
	detail := map[string]any{}
	if info, ok := update["tool_info"].(map[string]any); ok {
		if params, ok := info["parameters"]; ok {
			detail["parameters"] = params
		}
		if value, ok := info["error"]; ok {
			detail["error"] = value
		}
	}
	if output, ok := update["output"]; ok {
		detail["output"] = output
	}
	data, _ := json.Marshal(detail)
	return data
}

func int64Value(v any) int64 {
	switch value := v.(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	case json.Number:
		parsed, _ := value.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(value, 10, 64)
		return parsed
	default:
		return 0
	}
}

func int64MapValue(values map[string]any, keys ...string) int64 {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			return int64Value(value)
		}
	}
	return 0
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
