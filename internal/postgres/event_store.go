package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/jackc/pgx/v5"
)

var clientEventTypes = []string{
	"chat.user_message",
	"chat.assistant_delta",
	"chat.turn_started",
	"chat.turn_completed",
	"chat.turn_interrupted",
	"chat.turn_aborted",
	"chat.interrupt_requested",
}

func (s *Store) SendMessage(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	sessionID string,
	idempotencyKey string,
	text string,
) (domain.ClientEvent, error) {
	var event domain.ClientEvent
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		payload, err := json.Marshal(map[string]string{"text": text})
		if err != nil {
			return err
		}
		var commandID string
		err = tx.QueryRow(
			ctx,
			`INSERT INTO ao_commands (
				org_id, session_id, idempotency_key, kind, payload
			) VALUES ($1, $2, $3, 'message.send', $4)
			ON CONFLICT (org_id, idempotency_key) DO NOTHING
			RETURNING id`,
			orgID,
			sessionID,
			idempotencyKey,
			payload,
		).Scan(&commandID)
		if errors.Is(err, pgx.ErrNoRows) {
			return loadIdempotentMessage(
				ctx,
				tx,
				orgID,
				sessionID,
				idempotencyKey,
				payload,
				&event,
			)
		}
		if err != nil {
			return normalizeConstraintError(err)
		}

		event, err = appendUserMessage(ctx, tx, orgID, sessionID, text)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			ctx,
			`UPDATE ao_commands
			SET status = 'succeeded',
				result = jsonb_build_object('eventSequence', $1::bigint),
				updated_at = now()
			WHERE id = $2`,
			event.Sequence,
			commandID,
		); err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`INSERT INTO ao_audit_events (
				org_id, actor_user_id, action, resource_type, resource_id,
				metadata
			) VALUES (
				$1, $2, 'session.message_queued', 'session', $3,
				jsonb_build_object('sequence', $4::bigint)
			)`,
			orgID,
			principal.UserID,
			sessionID,
			event.Sequence,
		)
		return err
	})
	return event, err
}

func loadIdempotentMessage(
	ctx context.Context,
	tx pgx.Tx,
	orgID string,
	sessionID string,
	idempotencyKey string,
	payload []byte,
	event *domain.ClientEvent,
) error {
	var storedPayload []byte
	var storedSessionID, kind, status string
	var sequence int64
	err := tx.QueryRow(
		ctx,
		`SELECT session_id, kind, status, payload,
			(result->>'eventSequence')::bigint
		FROM ao_commands
		WHERE org_id = $1 AND idempotency_key = $2`,
		orgID,
		idempotencyKey,
	).Scan(&storedSessionID, &kind, &status, &storedPayload, &sequence)
	if err != nil {
		return err
	}
	if storedSessionID != sessionID ||
		kind != "message.send" ||
		status != "succeeded" ||
		!jsonEqual(storedPayload, payload) {
		return ErrIdempotencyMismatch
	}
	return scanClientEvent(tx.QueryRow(
		ctx,
		`SELECT session_id, sequence, type, payload, created_at
		FROM ao_events
		WHERE org_id = $1 AND session_id = $2 AND sequence = $3`,
		orgID,
		sessionID,
		sequence,
	), event)
}

func appendUserMessage(
	ctx context.Context,
	tx pgx.Tx,
	orgID string,
	sessionID string,
	text string,
) (domain.ClientEvent, error) {
	var sequence int64
	err := tx.QueryRow(
		ctx,
		`UPDATE ao_sessions
		SET next_sequence = next_sequence + 1, updated_at = now()
		WHERE org_id = $1 AND id = $2 AND is_terminated = false
		RETURNING next_sequence - 1`,
		orgID,
		sessionID,
	).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		var terminated bool
		if err := tx.QueryRow(
			ctx,
			`SELECT is_terminated
			FROM ao_sessions
			WHERE org_id = $1 AND id = $2`,
			orgID,
			sessionID,
		).Scan(&terminated); errors.Is(err, pgx.ErrNoRows) {
			return domain.ClientEvent{}, ErrNotFound
		} else if err != nil {
			return domain.ClientEvent{}, err
		}
		if terminated {
			return domain.ClientEvent{}, ErrConflict
		}
	}
	if err != nil {
		return domain.ClientEvent{}, err
	}

	payload, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return domain.ClientEvent{}, err
	}
	var event domain.ClientEvent
	err = scanClientEvent(tx.QueryRow(
		ctx,
		`INSERT INTO ao_events (
			org_id, session_id, sequence, type, payload
		) VALUES ($1, $2, $3, 'chat.user_message', $4)
		RETURNING session_id, sequence, type, payload, created_at`,
		orgID,
		sessionID,
		sequence,
		payload,
	), &event)
	if err != nil {
		return domain.ClientEvent{}, err
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO ao_turns (
			org_id, session_id, user_message_sequence
		) VALUES ($1, $2, $3)`,
		orgID,
		sessionID,
		sequence,
	); err != nil {
		return domain.ClientEvent{}, normalizeConstraintError(err)
	}
	return event, nil
}

func (s *Store) ListClientEvents(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	sessionID string,
	after int64,
	limit int,
) ([]domain.ClientEvent, bool, error) {
	var events []domain.ClientEvent
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(
			ctx,
			`SELECT EXISTS (
				SELECT 1 FROM ao_sessions WHERE org_id = $1 AND id = $2
			)`,
			orgID,
			sessionID,
		).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		rows, err := tx.Query(
			ctx,
			`SELECT session_id, sequence, type, payload, created_at
			FROM ao_events
			WHERE org_id = $1
			  AND session_id = $2
			  AND sequence > $3
			  AND type = ANY($4)
			ORDER BY sequence
			LIMIT $5`,
			orgID,
			sessionID,
			after,
			clientEventTypes,
			limit+1,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var event domain.ClientEvent
			if err := scanClientEvent(rows, &event); err != nil {
				return err
			}
			events = append(events, event)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, false, err
	}
	hasMore := len(events) > limit
	if hasMore {
		events = events[:limit]
	}
	return events, hasMore, nil
}

func scanClientEvent(row scanner, event *domain.ClientEvent) error {
	return row.Scan(
		&event.SessionID,
		&event.Sequence,
		&event.Type,
		&event.Payload,
		&event.CreatedAt,
	)
}
