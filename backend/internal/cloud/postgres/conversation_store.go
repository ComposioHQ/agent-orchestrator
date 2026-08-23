//nolint:revive,gocritic // Methods implement the fully documented shared conversation ports.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const maxConversationStreamChars = 64 * 1024

type conversationState struct {
	Record          domain.ConversationRecord          `json:"record"`
	AppliedTitle    string                             `json:"appliedTitle,omitempty"`
	Branches        map[string]conversationBranchState `json:"branches"`
	Turns           []domain.ConversationTurn          `json:"turns"`
	TurnBranches    map[string]string                  `json:"turnBranches,omitempty"`
	Messages        []domain.ConversationMessage       `json:"messages"`
	DeliveryContent map[string]string                  `json:"deliveryContent,omitempty"`
	Activities      []domain.ConversationActivity      `json:"activities"`
	Promotions      map[string]bool                    `json:"promotions,omitempty"`
}

type conversationBranchState struct {
	ID                     string           `json:"id"`
	ConversationID         string           `json:"conversationId"`
	SessionID              domain.SessionID `json:"sessionId"`
	ProviderConversationID string           `json:"providerConversationId,omitempty"`
	ProviderScopeID        string           `json:"providerScopeId,omitempty"`
	ParentBranchID         string           `json:"parentBranchId,omitempty"`
	ForkAfterTurnID        string           `json:"forkAfterTurnId,omitempty"`
	ReplacedTurnID         string           `json:"replacedTurnId,omitempty"`
	ReplacementTurnID      string           `json:"replacementTurnId,omitempty"`
	ForkAfterSequence      int64            `json:"forkAfterSequence,omitempty"`
	Active                 bool             `json:"active"`
	CreatedAt              time.Time        `json:"createdAt"`
}

func branchState(row domain.ConversationBranch) conversationBranchState {
	return conversationBranchState{
		ID: row.ID, ConversationID: row.ConversationID, SessionID: row.SessionID,
		ProviderConversationID: row.ProviderConversationID, ProviderScopeID: row.ProviderScopeID,
		ParentBranchID: row.ParentBranchID, ForkAfterTurnID: row.ForkAfterTurnID,
		ReplacedTurnID: row.ReplacedTurnID, ReplacementTurnID: row.ReplacementTurnID,
		ForkAfterSequence: row.ForkAfterSequence, Active: row.Active, CreatedAt: row.CreatedAt,
	}
}

func (b conversationBranchState) domain() domain.ConversationBranch {
	return domain.ConversationBranch{
		ID: b.ID, ConversationID: b.ConversationID, SessionID: b.SessionID,
		ProviderConversationID: b.ProviderConversationID, ProviderScopeID: b.ProviderScopeID,
		ParentBranchID: b.ParentBranchID, ForkAfterTurnID: b.ForkAfterTurnID,
		ReplacedTurnID: b.ReplacedTurnID, ReplacementTurnID: b.ReplacementTurnID,
		ForkAfterSequence: b.ForkAfterSequence, Active: b.Active, CreatedAt: b.CreatedAt,
	}
}

func newConversationState(rec domain.ConversationRecord, providerConversationID string) conversationState {
	rootID := rec.ID + ":root"
	rec.ActiveBranchID = rootID
	root := domain.ConversationBranch{
		ID: rootID, ConversationID: rec.ID, SessionID: rec.SessionID,
		ProviderConversationID: providerConversationID, ProviderScopeID: rootID,
		Active: true, CreatedAt: rec.CreatedAt,
	}
	return conversationState{
		Record: rec, Branches: map[string]conversationBranchState{rootID: branchState(root)},
		TurnBranches: make(map[string]string), DeliveryContent: make(map[string]string),
		Promotions: make(map[string]bool),
	}
}

func (state *conversationState) normalize() {
	if state.Branches == nil {
		state.Branches = make(map[string]conversationBranchState)
	}
	if state.TurnBranches == nil {
		state.TurnBranches = make(map[string]string)
	}
	if state.DeliveryContent == nil {
		state.DeliveryContent = make(map[string]string)
	}
	if state.Promotions == nil {
		state.Promotions = make(map[string]bool)
	}
	state.Record.AppliedTitle = state.AppliedTitle
	for i := range state.Turns {
		state.Turns[i].BranchID = state.TurnBranches[state.Turns[i].ID]
	}
	for i := range state.Messages {
		state.Messages[i].DeliveryContentJSON = state.DeliveryContent[state.Messages[i].ID]
	}
}

func (s *Store) loadConversation(ctx context.Context, tx pgx.Tx, id string, lock bool) (conversationState, error) {
	query := `SELECT state FROM ao_conversations WHERE id = $1`
	if lock {
		query += ` FOR UPDATE`
	}
	var data []byte
	if err := tx.QueryRow(ctx, query, id).Scan(&data); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return conversationState{}, domain.ErrNoConversation
		}
		return conversationState{}, err
	}
	var state conversationState
	if err := json.Unmarshal(data, &state); err != nil {
		return conversationState{}, fmt.Errorf("decode conversation %s: %w", id, err)
	}
	state.normalize()
	return state, nil
}

func saveConversation(ctx context.Context, tx pgx.Tx, state conversationState) error {
	state.AppliedTitle = state.Record.AppliedTitle
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE ao_conversations SET state = $2, session_id = $3, updated_at = $4 WHERE id = $1`,
		state.Record.ID, data, state.Record.SessionID, state.Record.UpdatedAt.UTC())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrNoConversation
	}
	return nil
}

func (s *Store) mutateConversation(ctx context.Context, id string, fn func(*conversationState) error) error {
	return s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		state, err := s.loadConversation(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if err := fn(&state); err != nil {
			return err
		}
		return saveConversation(ctx, tx, state)
	})
}

func (s *Store) mutateConversationForGeneration(ctx context.Context, id string, session domain.SessionID, generation string, fn func(*conversationState) error) (bool, error) {
	applied := false
	err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		var active string
		if err := tx.QueryRow(ctx, `SELECT controller_generation FROM ao_sessions WHERE id = $1`, session).Scan(&active); err != nil {
			return err
		}
		if active != generation {
			return nil
		}
		state, err := s.loadConversation(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if state.Record.SessionID != session {
			return nil
		}
		if err := fn(&state); err != nil {
			return err
		}
		if err := saveConversation(ctx, tx, state); err != nil {
			return err
		}
		applied = true
		return nil
	})
	return applied, err
}

func (s *Store) readConversation(ctx context.Context, id string) (conversationState, error) {
	var state conversationState
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		var err error
		state, err = s.loadConversation(ctx, tx, id, false)
		return err
	})
	return state, err
}

func (s *Store) CreateConversation(ctx context.Context, id string, scope domain.ConversationScope, project domain.ProjectID, session domain.SessionID, now time.Time) (domain.ConversationRecord, error) {
	var out domain.ConversationRecord
	err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		var data []byte
		var err error
		if scope == domain.ConversationScopeProject {
			err = tx.QueryRow(ctx, `SELECT state FROM ao_conversations WHERE scope = 'project' AND project_id = $1 FOR UPDATE`, project).Scan(&data)
		} else {
			err = tx.QueryRow(ctx, `SELECT state FROM ao_conversations WHERE session_id = $1 FOR UPDATE`, session).Scan(&data)
		}
		if err == nil {
			var state conversationState
			if err := json.Unmarshal(data, &state); err != nil {
				return err
			}
			state.normalize()
			if scope == domain.ConversationScopeProject && state.Record.SessionID != session {
				state.Record.SessionID = session
				state.Record.UpdatedAt = now.UTC()
				if err := saveConversation(ctx, tx, state); err != nil {
					return err
				}
			}
			out = state.Record
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var providerConversationID string
		if err := tx.QueryRow(ctx, `SELECT provider_conversation_id FROM ao_sessions WHERE id = $1`, session).Scan(&providerConversationID); err != nil {
			return err
		}
		if scope == "" {
			scope = domain.ConversationScopeSession
		}
		out = domain.ConversationRecord{ID: id, Scope: scope, ProjectID: project, SessionID: session, CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
		state := newConversationState(out, providerConversationID)
		out = state.Record
		encoded, err := json.Marshal(state)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO ao_conversations (org_id, owner_user_id, id, scope, project_id, session_id, state, created_at, updated_at)
			VALUES (ao_current_org_id(), ao_current_user_id(), $1, $2, $3, $4, $5, $6, $6)`, id, scope, project, session, encoded, now.UTC())
		return err
	})
	if err != nil {
		return domain.ConversationRecord{}, fmt.Errorf("create conversation %s: %w", id, normalizeStorageError(err))
	}
	return out, nil
}

func (s *Store) CreateProjectConversationWithContextReset(ctx context.Context, id string, project domain.ProjectID, session domain.SessionID, reset domain.ConversationActivity, now time.Time) (domain.ConversationRecord, error) {
	var out domain.ConversationRecord
	err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		var data []byte
		err := tx.QueryRow(ctx, `SELECT state FROM ao_conversations WHERE scope = 'project' AND project_id = $1 FOR UPDATE`, project).Scan(&data)
		if errors.Is(err, pgx.ErrNoRows) {
			txCtx := context.WithValue(ctx, tenantTxContextKey{}, tx)
			var createErr error
			out, createErr = s.CreateConversation(txCtx, id, domain.ConversationScopeProject, project, session, now)
			return createErr
		}
		if err != nil {
			return err
		}
		var state conversationState
		if err := json.Unmarshal(data, &state); err != nil {
			return err
		}
		state.normalize()
		state.Record.SessionID = session
		state.Record.UpdatedAt = now.UTC()
		if state.Record.LatestSequence > 0 && reset.ProviderItemID != "" {
			upsertActivityState(&state, "", reset, now)
		}
		if err := saveConversation(ctx, tx, state); err != nil {
			return err
		}
		out = state.Record
		return nil
	})
	if err != nil {
		return domain.ConversationRecord{}, fmt.Errorf("rebind project conversation %s: %w", project, normalizeStorageError(err))
	}
	return out, nil
}

func (s *Store) ConversationForSession(ctx context.Context, session domain.SessionID) (domain.ConversationRecord, error) {
	var state conversationState
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		var data []byte
		if err := tx.QueryRow(ctx, `SELECT state FROM ao_conversations WHERE session_id = $1`, session).Scan(&data); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.ErrNoConversation
			}
			return err
		}
		if err := json.Unmarshal(data, &state); err != nil {
			return err
		}
		state.normalize()
		return nil
	})
	return state.Record, err
}

func (s *Store) ConversationBranch(ctx context.Context, conversationID, branchID string) (domain.ConversationBranch, error) {
	state, err := s.readConversation(ctx, conversationID)
	if err != nil {
		return domain.ConversationBranch{}, err
	}
	branch, ok := state.Branches[branchID]
	if !ok {
		return domain.ConversationBranch{}, fmt.Errorf("%w: %s", domain.ErrNoConversationBranch, branchID)
	}
	return branch.domain(), nil
}

func (s *Store) ConversationEditAnchor(ctx context.Context, conversationID, replacedTurnID string) (domain.ConversationEditAnchor, error) {
	state, err := s.readConversation(ctx, conversationID)
	if err != nil {
		return domain.ConversationEditAnchor{}, err
	}
	idx := turnIndexByID(&state, replacedTurnID)
	if idx < 0 {
		return domain.ConversationEditAnchor{}, domain.ErrNoConversationTurn
	}
	turn := state.Turns[idx]
	anchor := domain.ConversationEditAnchor{ConversationID: conversationID, SourceBranchID: state.TurnBranches[turn.ID], ReplacedTurnID: turn.ID}
	for i := idx - 1; i >= 0; i-- {
		if state.Turns[i].ProviderTurnID != "" {
			anchor.PreviousProviderTurnID = state.Turns[i].ProviderTurnID
			break
		}
	}
	for _, msg := range state.Messages {
		if msg.TurnID == turn.ID {
			anchor.ForkAfterSequence = msg.Sequence - 1
			anchor.OriginalDeliveryContentJSON = state.DeliveryContent[msg.ID]
			break
		}
	}
	anchor.RetryActiveBranch = anchor.SourceBranchID == state.Record.ActiveBranchID
	return anchor, nil
}

func (s *Store) CreateAndActivateConversationBranch(ctx context.Context, sessionID domain.SessionID, branch domain.ConversationBranch, generation string, now time.Time) error {
	_, err := s.mutateConversationForGeneration(ctx, branch.ConversationID, sessionID, generation, func(state *conversationState) error {
		for id, item := range state.Branches {
			item.Active = false
			state.Branches[id] = item
		}
		branch.Active = true
		state.Branches[branch.ID] = branchState(branch)
		state.Record.ActiveBranchID = branch.ID
		state.Record.UpdatedAt = now.UTC()
		return nil
	})
	return err
}

func (s *Store) ActivateConversationBranch(ctx context.Context, sessionID domain.SessionID, conversationID, branchID, providerConversationID, generation string, now time.Time) error {
	_, err := s.mutateConversationForGeneration(ctx, conversationID, sessionID, generation, func(state *conversationState) error {
		branch, ok := state.Branches[branchID]
		if !ok {
			return domain.ErrNoConversationBranch
		}
		for id, item := range state.Branches {
			item.Active = false
			state.Branches[id] = item
		}
		branch.Active = true
		branch.ProviderConversationID = providerConversationID
		state.Branches[branchID] = branch
		state.Record.ActiveBranchID = branchID
		state.Record.SessionID = sessionID
		state.Record.UpdatedAt = now.UTC()
		return nil
	})
	return err
}

func (s *Store) UpdateConversationBranchReplacement(ctx context.Context, branchID, replacementTurnID string) error {
	return s.mutateConversationByBranch(ctx, branchID, func(state *conversationState, branch conversationBranchState) error {
		branch.ReplacementTurnID = replacementTurnID
		state.Branches[branchID] = branch
		return nil
	})
}

func (s *Store) mutateConversationByBranch(ctx context.Context, branchID string, fn func(*conversationState, conversationBranchState) error) error {
	var conversationID string
	if err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, state FROM ao_conversations`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var data []byte
			if err := rows.Scan(&id, &data); err != nil {
				return err
			}
			var st conversationState
			if json.Unmarshal(data, &st) == nil {
				if _, ok := st.Branches[branchID]; ok {
					conversationID = id
					return nil
				}
			}
		}
		return rows.Err()
	}); err != nil {
		return err
	}
	if conversationID == "" {
		return domain.ErrNoConversationBranch
	}
	return s.mutateConversation(ctx, conversationID, func(state *conversationState) error { return fn(state, state.Branches[branchID]) })
}

func (s *Store) AppendUserMessage(ctx context.Context, conversationID string, session domain.SessionID, generation string, msg domain.ConversationMessage, turnID string, now time.Time) (bool, error) {
	created := false
	applied, err := s.mutateConversationForGeneration(ctx, conversationID, session, generation, func(state *conversationState) error {
		for _, existing := range state.Messages {
			if msg.ClientMessageID != "" && existing.ClientMessageID == msg.ClientMessageID {
				return nil
			}
		}
		state.Record.LatestSequence++
		msg.ConversationID = conversationID
		msg.TurnID = turnID
		msg.Sequence = state.Record.LatestSequence
		msg.Role = domain.MessageRoleUser
		if msg.CreatedAt.IsZero() {
			msg.CreatedAt = now.UTC()
		}
		msg.UpdatedAt = now.UTC()
		turn := domain.ConversationTurn{ID: turnID, ConversationID: conversationID, HandledBySessionID: session, State: domain.TurnStateQueued, RequestedAt: now.UTC()}
		state.TurnBranches[turnID] = state.Record.ActiveBranchID
		state.DeliveryContent[msg.ID] = msg.DeliveryContentJSON
		state.Turns = append(state.Turns, turn)
		state.Messages = append(state.Messages, msg)
		state.Record.UpdatedAt = now.UTC()
		created = true
		return nil
	})
	return applied && created, err
}

func (s *Store) AdoptProviderTurn(ctx context.Context, conversationID string, session domain.SessionID, generation, turnID, providerTurnID string, now time.Time) error {
	_, err := s.mutateConversationForGeneration(ctx, conversationID, session, generation, func(state *conversationState) error {
		for _, turn := range state.Turns {
			if turn.ProviderTurnID == providerTurnID {
				return nil
			}
		}
		started := now.UTC()
		state.Turns = append(state.Turns, domain.ConversationTurn{ID: turnID, ConversationID: conversationID, HandledBySessionID: session, ProviderTurnID: providerTurnID, State: domain.TurnStateRunning, RequestedAt: started, StartedAt: &started})
		state.TurnBranches[turnID] = state.Record.ActiveBranchID
		state.Record.UpdatedAt = started
		return nil
	})
	return err
}

func (s *Store) AppendImportedUserMessage(ctx context.Context, conversationID, providerTurnID string, msg domain.ConversationMessage, now time.Time) error {
	return s.mutateConversation(ctx, conversationID, func(state *conversationState) error {
		turn := turnByProvider(state, providerTurnID)
		if turn == nil {
			return domain.ErrNoConversationTurn
		}
		for _, existing := range state.Messages {
			if existing.TurnID == turn.ID && existing.Role == domain.MessageRoleUser {
				return nil
			}
		}
		state.Record.LatestSequence++
		msg.ConversationID = conversationID
		msg.TurnID = turn.ID
		msg.Sequence = state.Record.LatestSequence
		msg.Role = domain.MessageRoleUser
		msg.Origin = domain.MessageOriginHuman
		msg.CreatedAt = now.UTC()
		msg.UpdatedAt = now.UTC()
		state.DeliveryContent[msg.ID] = msg.DeliveryContentJSON
		state.Messages = append(state.Messages, msg)
		state.Record.UpdatedAt = now.UTC()
		return nil
	})
}

func (s *Store) BindTurnToProvider(ctx context.Context, turnID, providerTurnID string, now time.Time) error {
	return s.mutateConversationByTurn(ctx, turnID, func(state *conversationState, idx int) error {
		state.Turns[idx].ProviderTurnID = providerTurnID
		state.Turns[idx].State = domain.TurnStateRunning
		at := now.UTC()
		state.Turns[idx].StartedAt = &at
		return nil
	})
}

func (s *Store) SettleTurn(ctx context.Context, conversationID, providerTurnID string, status domain.TurnState, message string, now time.Time) error {
	return s.mutateConversation(ctx, conversationID, func(state *conversationState) error {
		turn := turnByProvider(state, providerTurnID)
		if turn == nil {
			return domain.ErrNoConversationTurn
		}
		settleTurn(turn, status, message, now)
		return nil
	})
}

func (s *Store) SettleTurnByID(ctx context.Context, turnID string, status domain.TurnState, message string, now time.Time) error {
	return s.mutateConversationByTurn(ctx, turnID, func(state *conversationState, idx int) error {
		settleTurn(&state.Turns[idx], status, message, now)
		return nil
	})
}

func settleTurn(turn *domain.ConversationTurn, status domain.TurnState, message string, now time.Time) {
	at := now.UTC()
	turn.State = status
	turn.ErrorMessage = message
	turn.CompletedAt = &at
}

func (s *Store) mutateConversationByTurn(ctx context.Context, turnID string, fn func(*conversationState, int) error) error {
	var conversationID string
	if err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, state FROM ao_conversations`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var data []byte
			if err := rows.Scan(&id, &data); err != nil {
				return err
			}
			var st conversationState
			if json.Unmarshal(data, &st) == nil && turnIndexByID(&st, turnID) >= 0 {
				conversationID = id
				return nil
			}
		}
		return rows.Err()
	}); err != nil {
		return err
	}
	if conversationID == "" {
		return domain.ErrNoConversationTurn
	}
	return s.mutateConversation(ctx, conversationID, func(state *conversationState) error {
		idx := turnIndexByID(state, turnID)
		if idx < 0 {
			return domain.ErrNoConversationTurn
		}
		return fn(state, idx)
	})
}

func (s *Store) SettleOrphanedTurns(ctx context.Context, session domain.SessionID, now time.Time) error {
	rec, err := s.ConversationForSession(ctx, session)
	if err != nil {
		if errors.Is(err, domain.ErrNoConversation) {
			return nil
		}
		return err
	}
	return s.mutateConversation(ctx, rec.ID, func(state *conversationState) error {
		for i := range state.Turns {
			if state.Turns[i].HandledBySessionID == session && !state.Turns[i].State.Terminal() {
				settleTurn(&state.Turns[i], domain.TurnStateFailed, "controller stopped", now)
			}
		}
		return nil
	})
}

func (s *Store) ListVisibleRunningTurnProviderIDs(ctx context.Context, conversationID string) ([]string, error) {
	state, err := s.readConversation(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, turn := range state.Turns {
		if turn.State == domain.TurnStateRunning && turn.ProviderTurnID != "" && state.TurnBranches[turn.ID] == state.Record.ActiveBranchID {
			out = append(out, turn.ProviderTurnID)
		}
	}
	return out, nil
}

func (s *Store) SetConversationSettings(ctx context.Context, id string, settings domain.ConversationSettings, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		state.Record.Settings = settings
		state.Record.UpdatedAt = now.UTC()
		return nil
	})
}
func (s *Store) RecordUsage(ctx context.Context, id string, usage domain.ConversationUsage) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error { state.Record.Usage = &usage; return nil })
}
func (s *Store) RecordRateLimits(ctx context.Context, id string, limits domain.ConversationRateLimits) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error { state.Record.RateLimits = &limits; return nil })
}

func (s *Store) NextQueuedTurn(ctx context.Context, id string) (domain.QueuedTurn, error) {
	state, err := s.readConversation(ctx, id)
	if err != nil {
		return domain.QueuedTurn{}, err
	}
	for _, turn := range state.Turns {
		if turn.State == domain.TurnStateQueued && !state.Promotions[turn.ID] {
			return queuedTurn(state, turn), nil
		}
	}
	return domain.QueuedTurn{}, domain.ErrNoQueuedTurn
}
func (s *Store) ReserveQueuedTurnForPromotion(ctx context.Context, id, turnID string, now time.Time) (domain.QueuedTurn, error) {
	var out domain.QueuedTurn
	err := s.mutateConversation(ctx, id, func(state *conversationState) error {
		idx := turnIndexByID(state, turnID)
		if idx < 0 || state.Turns[idx].State != domain.TurnStateQueued || state.Promotions[turnID] {
			return domain.ErrNoConversationTurn
		}
		state.Promotions[turnID] = true
		out = queuedTurn(*state, state.Turns[idx])
		return nil
	})
	return out, err
}
func (s *Store) ReleaseQueuedTurnPromotion(ctx context.Context, id, turnID string) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error { delete(state.Promotions, turnID); return nil })
}
func (s *Store) CompleteQueuedTurnPromotion(ctx context.Context, id, sourceTurnID, providerTurnID string, activity domain.ConversationActivity, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		idx := turnIndexByID(state, sourceTurnID)
		if idx < 0 || !state.Promotions[sourceTurnID] {
			return domain.ErrNoConversationTurn
		}
		delete(state.Promotions, sourceTurnID)
		state.Turns[idx].ProviderTurnID = providerTurnID
		state.Turns[idx].State = domain.TurnStateRunning
		at := now.UTC()
		state.Turns[idx].StartedAt = &at
		upsertActivityState(state, providerTurnID, activity, now)
		return nil
	})
}
func (s *Store) CancelQueuedTurns(ctx context.Context, id string, cutoff, now time.Time) error {
	return s.cancelQueued(ctx, id, func(t domain.ConversationTurn) bool { return !t.RequestedAt.After(cutoff) }, now)
}
func (s *Store) CancelAllQueuedTurns(ctx context.Context, id string, now time.Time) error {
	return s.cancelQueued(ctx, id, func(domain.ConversationTurn) bool { return true }, now)
}
func (s *Store) cancelQueued(ctx context.Context, id string, predicate func(domain.ConversationTurn) bool, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		for i := range state.Turns {
			if state.Turns[i].State == domain.TurnStateQueued && predicate(state.Turns[i]) {
				settleTurn(&state.Turns[i], domain.TurnStateInterrupted, "", now)
				delete(state.Promotions, state.Turns[i].ID)
			}
		}
		return nil
	})
}

func queuedTurn(state conversationState, turn domain.ConversationTurn) domain.QueuedTurn {
	for _, msg := range state.Messages {
		if msg.TurnID == turn.ID && msg.Role == domain.MessageRoleUser {
			return domain.QueuedTurn{TurnID: turn.ID, Text: msg.Text, ClientMessageID: msg.ClientMessageID, Origin: msg.Origin, DeliveryContentJSON: state.DeliveryContent[msg.ID]}
		}
	}
	return domain.QueuedTurn{TurnID: turn.ID}
}
func (s *Store) TurnByID(ctx context.Context, turnID string) (domain.ConversationTurn, error) {
	var out domain.ConversationTurn
	err := s.mutateConversationByTurn(ctx, turnID, func(state *conversationState, idx int) error { out = state.Turns[idx]; return nil })
	return out, err
}
func (s *Store) RollbackTurns(ctx context.Context, id, turnID string, now time.Time) (int, error) {
	count := 0
	err := s.mutateConversation(ctx, id, func(state *conversationState) error {
		idx := turnIndexByID(state, turnID)
		if idx < 0 {
			return domain.ErrNoConversationTurn
		}
		at := now.UTC()
		for i := idx; i < len(state.Turns); i++ {
			if state.Turns[i].RolledBackAt == nil {
				state.Turns[i].RolledBackAt = &at
				count++
			}
		}
		return nil
	})
	return count, err
}

func (s *Store) SetProviderTitle(ctx context.Context, id, title string, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		state.Record.ProviderTitle = title
		state.Record.UpdatedAt = now.UTC()
		return nil
	})
}
func (s *Store) ApplyProviderTitle(ctx context.Context, id string, session domain.SessionID, title string, now time.Time) (bool, error) {
	applied := false
	err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		state, err := s.loadConversation(ctx, tx, id, true)
		if err != nil {
			return err
		}
		var current string
		if err := tx.QueryRow(ctx, `SELECT display_name FROM ao_sessions WHERE id=$1`, session).Scan(&current); err != nil {
			return err
		}
		if current != "" && current != state.Record.AppliedTitle {
			return nil
		}
		tag, err := tx.Exec(ctx, `UPDATE ao_sessions SET display_name=$2,updated_at=$3 WHERE id=$1`, session, title, now.UTC())
		if err != nil {
			return err
		}
		applied = tag.RowsAffected() > 0
		if applied {
			state.Record.AppliedTitle = title
			state.AppliedTitle = title
			state.Record.UpdatedAt = now.UTC()
			return saveConversation(ctx, tx, state)
		}
		return nil
	})
	return applied, err
}

func (s *Store) AppendAssistantDelta(ctx context.Context, id, itemID, providerTurnID, delta, messageID string, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		for i := range state.Messages {
			if state.Messages[i].ProviderItemID == itemID {
				state.Messages[i].Text += delta
				state.Messages[i].Revision++
				state.Messages[i].UpdatedAt = now.UTC()
				return nil
			}
		}
		state.Record.LatestSequence++
		msg := domain.ConversationMessage{ID: messageID, ConversationID: id, TurnID: turnIDByProvider(state, providerTurnID), Sequence: state.Record.LatestSequence, Role: domain.MessageRoleAssistant, Origin: domain.MessageOriginProvider, Text: delta, Streaming: true, ProviderItemID: itemID, CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
		state.Messages = append(state.Messages, msg)
		return nil
	})
}
func (s *Store) SettleAssistantMessage(ctx context.Context, id, itemID, providerTurnID, text, messageID string, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		for i := range state.Messages {
			if state.Messages[i].ProviderItemID == itemID {
				state.Messages[i].Text = text
				state.Messages[i].Streaming = false
				state.Messages[i].Revision++
				state.Messages[i].UpdatedAt = now.UTC()
				return nil
			}
		}
		state.Record.LatestSequence++
		state.Messages = append(state.Messages, domain.ConversationMessage{ID: messageID, ConversationID: id, TurnID: turnIDByProvider(state, providerTurnID), Sequence: state.Record.LatestSequence, Role: domain.MessageRoleAssistant, Origin: domain.MessageOriginProvider, Text: text, ProviderItemID: itemID, CreatedAt: now.UTC(), UpdatedAt: now.UTC()})
		return nil
	})
}
func (s *Store) AppendCommandOutput(ctx context.Context, id, itemID, delta string, now time.Time) (bool, error) {
	found := false
	err := s.mutateConversation(ctx, id, func(state *conversationState) error {
		for i := range state.Activities {
			if state.Activities[i].ProviderItemID == itemID {
				found = true
				state.Activities[i].CommandOutput, state.Activities[i].CommandOutputTruncated = appendCapped(state.Activities[i].CommandOutput, delta, maxConversationStreamChars)
				state.Activities[i].Revision++
				state.Activities[i].UpdatedAt = now.UTC()
				return nil
			}
		}
		return nil
	})
	return found, err
}
func (s *Store) SetTurnDiff(ctx context.Context, id, providerTurnID string, diff domain.ConversationTurnDiff, now time.Time) (bool, error) {
	found := false
	err := s.mutateConversation(ctx, id, func(state *conversationState) error {
		turn := turnByProvider(state, providerTurnID)
		if turn != nil {
			turn.Diff = &diff
			found = true
		}
		return nil
	})
	return found, err
}
func (s *Store) AppendActivityStreamedText(ctx context.Context, id, itemID, delta string, now time.Time) (bool, error) {
	return s.updateActivityText(ctx, id, itemID, delta, false, now)
}
func (s *Store) SettleActivityStreamedText(ctx context.Context, id, itemID, text string, now time.Time) (bool, error) {
	return s.updateActivityText(ctx, id, itemID, text, true, now)
}
func (s *Store) updateActivityText(ctx context.Context, id, itemID, text string, replace bool, now time.Time) (bool, error) {
	found := false
	err := s.mutateConversation(ctx, id, func(state *conversationState) error {
		for i := range state.Activities {
			if state.Activities[i].ProviderItemID == itemID {
				found = true
				if replace {
					state.Activities[i].StreamedText = text
					state.Activities[i].StreamedTextTruncated = false
				} else {
					state.Activities[i].StreamedText, state.Activities[i].StreamedTextTruncated = appendCapped(state.Activities[i].StreamedText, text, maxConversationStreamChars)
				}
				state.Activities[i].Revision++
				state.Activities[i].UpdatedAt = now.UTC()
				break
			}
		}
		return nil
	})
	return found, err
}
func (s *Store) SetTurnPlan(ctx context.Context, id, providerTurnID string, plan domain.ConversationPlan) (bool, error) {
	found := false
	err := s.mutateConversation(ctx, id, func(state *conversationState) error {
		turn := turnByProvider(state, providerTurnID)
		if turn != nil {
			turn.Plan = &plan
			found = true
		}
		return nil
	})
	return found, err
}

func (s *Store) RecordModelReroute(ctx context.Context, id string, value domain.ConversationModelReroute) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error { state.Record.ModelReroute = &value; return nil })
}
func (s *Store) RecordAccount(ctx context.Context, id string, value domain.ConversationAccount, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		state.Record.Account = &value
		state.Record.UpdatedAt = now.UTC()
		return nil
	})
}
func (s *Store) RecordThreadState(ctx context.Context, id string, value domain.ConversationThreadState) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error { state.Record.ThreadState = &value; return nil })
}
func (s *Store) RecordMCPServers(ctx context.Context, id string, value []domain.ConversationMCPServer) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		state.Record.MCPServers = append([]domain.ConversationMCPServer(nil), value...)
		return nil
	})
}
func (s *Store) UpsertActivity(ctx context.Context, id, providerTurnID string, value domain.ConversationActivity, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		upsertActivityState(state, providerTurnID, value, now)
		return nil
	})
}
func upsertActivityState(state *conversationState, providerTurnID string, value domain.ConversationActivity, now time.Time) {
	if value.ProviderItemID != "" {
		for i := range state.Activities {
			if state.Activities[i].ProviderItemID == value.ProviderItemID {
				seq := state.Activities[i].Sequence
				rev := state.Activities[i].Revision + 1
				created := state.Activities[i].CreatedAt
				value.Sequence = seq
				value.Revision = rev
				value.CreatedAt = created
				value.UpdatedAt = now.UTC()
				value.ConversationID = state.Record.ID
				value.TurnID = turnIDByProvider(state, providerTurnID)
				state.Activities[i] = value
				return
			}
		}
	}
	state.Record.LatestSequence++
	value.Sequence = state.Record.LatestSequence
	value.ConversationID = state.Record.ID
	value.TurnID = turnIDByProvider(state, providerTurnID)
	if value.CreatedAt.IsZero() {
		value.CreatedAt = now.UTC()
	}
	value.UpdatedAt = now.UTC()
	state.Activities = append(state.Activities, value)
}
func (s *Store) MarkCompacted(ctx context.Context, id string, at time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		value := at.UTC()
		state.Record.CompactedAt = &value
		state.Record.UpdatedAt = value
		return nil
	})
}
func (s *Store) ResolveApproval(ctx context.Context, id, requestID, detailJSON string, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		for i := range state.Activities {
			if state.Activities[i].RequestID == requestID && state.Activities[i].Status == domain.ActivityStatusPending {
				state.Activities[i].Status = domain.ActivityStatusResolved
				state.Activities[i].Detail = []byte(detailJSON)
				state.Activities[i].UpdatedAt = now.UTC()
			}
		}
		return nil
	})
}
func (s *Store) FailPendingApprovals(ctx context.Context, id string, now time.Time) error {
	return s.failPendingActivities(ctx, id, domain.ActivityKindApproval, now)
}
func (s *Store) FailPendingInputs(ctx context.Context, id string, now time.Time) error {
	return s.failPendingActivities(ctx, id, domain.ActivityKindUserInput, now)
}
func (s *Store) failPendingActivities(ctx context.Context, id string, kind domain.ActivityKind, now time.Time) error {
	return s.mutateConversation(ctx, id, func(state *conversationState) error {
		for i := range state.Activities {
			if state.Activities[i].Kind == kind && state.Activities[i].Status == domain.ActivityStatusPending {
				state.Activities[i].Status = domain.ActivityStatusFailed
				state.Activities[i].UpdatedAt = now.UTC()
			}
		}
		return nil
	})
}

func (s *Store) ProjectProviderEvent(ctx context.Context, id string, session domain.SessionID, generation, eventID, method, payload string, now time.Time, project func(context.Context) error) (bool, error) {
	applied := false
	err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		var active string
		if err := tx.QueryRow(ctx, `SELECT controller_generation FROM ao_sessions WHERE id=$1`, session).Scan(&active); err != nil {
			return err
		}
		if active != generation {
			return nil
		}
		if eventID != "" {
			tag, err := tx.Exec(ctx, `INSERT INTO ao_conversation_provider_events(org_id,owner_user_id,conversation_id,provider_event_id,method,payload_json,observed_at) VALUES(ao_current_org_id(),ao_current_user_id(),$1,$2,$3,NULLIF($4,'')::jsonb,$5) ON CONFLICT DO NOTHING`, id, eventID, method, payload, now.UTC())
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return nil
			}
		}
		txCtx := context.WithValue(ctx, tenantTxContextKey{}, tx)
		if project != nil {
			if err := project(txCtx); err != nil {
				return err
			}
		}
		applied = true
		return nil
	})
	return applied, err
}

func (s *Store) LoadConversationSnapshot(ctx context.Context, id string) (ports.ConversationSnapshot, error) {
	return s.LoadConversationSnapshotPage(ctx, id, 0, 0)
}
func (s *Store) LoadConversationSnapshotPage(ctx context.Context, id string, before, limit int64) (ports.ConversationSnapshot, error) {
	state, err := s.readConversation(ctx, id)
	if err != nil {
		return ports.ConversationSnapshot{}, err
	}
	turns := make([]domain.ConversationTurn, 0, len(state.Turns))
	for _, turn := range state.Turns {
		if turn.RolledBackAt == nil {
			turns = append(turns, turn)
		}
	}
	messages := append([]domain.ConversationMessage(nil), state.Messages...)
	activities := append([]domain.ConversationActivity(nil), state.Activities...)
	sort.Slice(messages, func(i, j int) bool { return messages[i].Sequence < messages[j].Sequence })
	sort.Slice(activities, func(i, j int) bool { return activities[i].Sequence < activities[j].Sequence })
	oldest := int64(0)
	more := false
	if limit > 0 {
		cutoff := before
		if cutoff <= 0 {
			cutoff = state.Record.LatestSequence + 1
		}
		type item struct {
			seq     int64
			message bool
			idx     int
		}
		items := []item{}
		for i, v := range messages {
			if v.Sequence < cutoff {
				items = append(items, item{v.Sequence, true, i})
			}
		}
		for i, v := range activities {
			if v.Sequence < cutoff {
				items = append(items, item{v.Sequence, false, i})
			}
		}
		sort.Slice(items, func(i, j int) bool { return items[i].seq < items[j].seq })
		if int64(len(items)) > limit {
			more = true
			items = items[len(items)-int(limit):]
		}
		keepMessages := map[int]bool{}
		keepActivities := map[int]bool{}
		for _, v := range items {
			if oldest == 0 || v.seq < oldest {
				oldest = v.seq
			}
			if v.message {
				keepMessages[v.idx] = true
			} else {
				keepActivities[v.idx] = true
			}
		}
		filteredMessages := []domain.ConversationMessage{}
		for i, v := range messages {
			if keepMessages[i] {
				filteredMessages = append(filteredMessages, v)
			}
		}
		filteredActivities := []domain.ConversationActivity{}
		for i, v := range activities {
			if keepActivities[i] {
				filteredActivities = append(filteredActivities, v)
			}
		}
		messages = filteredMessages
		activities = filteredActivities
	}
	return ports.ConversationSnapshot{Conversation: state.Record, Turns: turns, Messages: messages, Activities: activities, OldestSequence: oldest, HasMoreBefore: more}, nil
}

func turnIndexByID(state *conversationState, id string) int {
	for i := range state.Turns {
		if state.Turns[i].ID == id {
			return i
		}
	}
	return -1
}
func turnByProvider(state *conversationState, id string) *domain.ConversationTurn {
	for i := range state.Turns {
		if state.Turns[i].ProviderTurnID == id {
			return &state.Turns[i]
		}
	}
	return nil
}
func turnIDByProvider(state *conversationState, id string) string {
	if turn := turnByProvider(state, id); turn != nil {
		return turn.ID
	}
	return ""
}
func appendCapped(current, delta string, limit int) (string, bool) {
	if delta == "" {
		return current, false
	}
	combined := current + delta
	if utf8.RuneCountInString(combined) <= limit {
		return combined, false
	}
	runes := []rune(combined)
	return string(runes[len(runes)-limit:]), true
}

var _ ports.ConversationStore = (*Store)(nil)
var _ ports.ConversationReader = (*Store)(nil)
