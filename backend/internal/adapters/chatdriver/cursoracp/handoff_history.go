package cursoracp

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	acpdriver "github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/acp"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const cursorHandoffTranscriptLimit = 512 << 10

type cursorTranscriptLine struct {
	Role    string `json:"role"`
	Message struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"message"`
}

type cursorTranscriptTurn struct {
	user      string
	assistant string
	migrated  bool
}

type cursorInterfaceHandoffEnvelope struct {
	XMLName  xml.Name                        `xml:"ao-interface-handoff"`
	Messages []cursorInterfaceHandoffMessage `xml:"message"`
}

type cursorInterfaceHandoffMessage struct {
	Role string `xml:"role,attr"`
	Text string `xml:",chardata"`
}

type cursorHistoryBlock struct {
	events       []ports.ChatEvent
	userKey      string
	assistantKey string
	turnID       string
	drop         bool
}

type cursorHistoryMatchKey struct {
	user      string
	assistant string
	migrated  bool
}

func augmentCursorHandoffHistory(
	ctx context.Context,
	cfg acpdriver.LaunchConfig,
	providerConversationID string,
	history []ports.ChatEvent,
) ([]ports.ChatEvent, error) {
	if !cfg.RequireNativeHistory {
		return history, nil
	}
	turns, err := readCursorTerminalTranscript(ctx, cfg.DataDir, providerConversationID)
	if err != nil {
		return nil, err
	}
	blocks, err := cursorProviderHistoryBlocks(history)
	if err != nil {
		return nil, err
	}
	providerIndexes := make([]int, 0, len(blocks))
	providerKeys := make([]cursorHistoryMatchKey, 0, len(blocks))
	for index, block := range blocks {
		if block.userKey != "" {
			providerIndexes = append(providerIndexes, index)
			providerKeys = append(providerKeys, cursorHistoryMatchKey{
				user: block.userKey, assistant: block.assistantKey,
			})
		}
	}
	transcriptKeys := make([]cursorHistoryMatchKey, len(turns))
	for index, turn := range turns {
		transcriptKeys[index] = cursorHistoryMatchKey{
			user: normalizeCursorHistoryText(turn.user), assistant: normalizeCursorHistoryText(turn.assistant),
			migrated: turn.migrated,
		}
	}
	matches := cursorHistoryLCS(providerKeys, transcriptKeys)

	result := make([]ports.ChatEvent, 0, len(history)+len(turns)*4)
	providerBlock := 0
	transcriptTurn := 0
	for _, match := range matches {
		matchedBlock := providerIndexes[match[0]]
		for ; providerBlock < matchedBlock; providerBlock++ {
			result = append(result, blocks[providerBlock].events...)
		}
		for ; transcriptTurn < match[1]; transcriptTurn++ {
			result = appendCursorTranscriptTurn(result, providerConversationID, transcriptTurn, turns[transcriptTurn])
		}
		if turns[transcriptTurn].migrated {
			// Cursor ACP can flatten the envelope and concatenate replies from
			// separate Chat turns. The native transcript retains their exact frames.
			result = appendCursorTranscriptTurn(result, providerConversationID, transcriptTurn, turns[transcriptTurn])
		} else {
			result = append(result, completedCursorHistoryBlock(
				blocks[matchedBlock].events, turns[transcriptTurn].assistant != "")...)
		}
		providerBlock = matchedBlock + 1
		transcriptTurn++
	}
	for ; providerBlock < len(blocks); providerBlock++ {
		result = append(result, blocks[providerBlock].events...)
	}
	for ; transcriptTurn < len(turns); transcriptTurn++ {
		result = appendCursorTranscriptTurn(result, providerConversationID, transcriptTurn, turns[transcriptTurn])
	}
	return result, nil
}

func completedCursorHistoryBlock(events []ports.ChatEvent, answered bool) []ports.ChatEvent {
	if !answered {
		return events
	}
	for index := range events {
		if events[index].Kind == ports.ChatEventTurnCompleted &&
			events[index].TurnState == domain.TurnStateRecovered {
			events[index].TurnState = domain.TurnStateCompleted
		}
	}
	return events
}

func cursorProviderHistoryBlocks(history []ports.ChatEvent) ([]cursorHistoryBlock, error) {
	var blocks []cursorHistoryBlock
	for _, event := range history {
		if len(blocks) == 0 || event.ProviderTurnID == "" ||
			blocks[len(blocks)-1].turnID != event.ProviderTurnID {
			blocks = append(blocks, cursorHistoryBlock{turnID: event.ProviderTurnID})
		}
		block := &blocks[len(blocks)-1]
		if block.drop {
			continue
		}
		block.events = append(block.events, event)
		switch event.Kind {
		case ports.ChatEventUserMessageCompleted:
			query := cursorUserQuery(event.Text)
			if cursorInterfaceHandoffCandidate(query) {
				if _, ok := cursorInterfaceHandoffMessages(query); !ok {
					return nil, fmt.Errorf("%w: malformed Cursor interface handoff envelope", ports.ErrChatHistoryUnavailable)
				}
				// Drop the raw transport turn and its acknowledgement. Canonical
				// visible messages are reconstructed from the native transcript.
				block.events = nil
				block.userKey = ""
				block.drop = true
				continue
			}
			block.userKey = normalizeCursorHistoryText(event.Text)
		case ports.ChatEventMessageCompleted:
			if text := normalizeCursorHistoryText(event.Text); text != "" {
				block.assistantKey = strings.TrimSpace(block.assistantKey + " " + text)
			}
		}
	}
	kept := blocks[:0]
	for _, block := range blocks {
		if !block.drop && len(block.events) > 0 {
			kept = append(kept, block)
		}
	}
	return kept, nil
}

func cursorHistoryLCS(provider, transcript []cursorHistoryMatchKey) [][2]int {
	table := make([][]int, len(provider)+1)
	for index := range table {
		table[index] = make([]int, len(transcript)+1)
	}
	for p := len(provider) - 1; p >= 0; p-- {
		for t := len(transcript) - 1; t >= 0; t-- {
			table[p][t] = max(table[p+1][t], table[p][t+1])
			if score := cursorHistoryMatchScore(provider[p], transcript[t]); score >= 0 {
				table[p][t] = max(table[p][t], score+table[p+1][t+1])
			}
		}
	}
	var matches [][2]int
	for p, t := 0, 0; p < len(provider) && t < len(transcript); {
		score := cursorHistoryMatchScore(provider[p], transcript[t])
		matchTotal := -1
		if score >= 0 {
			matchTotal = score + table[p+1][t+1]
		}
		switch {
		case matchTotal >= table[p+1][t] && matchTotal >= table[p][t+1]:
			matches = append(matches, [2]int{p, t})
			p++
			t++
		case table[p+1][t] >= table[p][t+1]:
			p++
		default:
			t++
		}
	}
	return matches
}

func cursorHistoryMatchScore(provider, transcript cursorHistoryMatchKey) int {
	if provider.user != transcript.user {
		return -1
	}
	if provider.assistant == "" || transcript.assistant == "" {
		return 1
	}
	if provider.assistant == transcript.assistant {
		return 2
	}
	// Cursor can prepend status text when ACP flattens an AO migration turn.
	// Native transcript content remains the canonical visible answer.
	if transcript.migrated && strings.Contains(provider.assistant, transcript.assistant) {
		return 2
	}
	return 1
}

func appendCursorTranscriptTurn(
	result []ports.ChatEvent,
	providerConversationID string,
	ordinal int,
	turn cursorTranscriptTurn,
) []ports.ChatEvent {
	turnID := fmt.Sprintf("cursor-terminal-history:%s:%d", providerConversationID, ordinal)
	result = append(result, cursorTerminalHistoryEvent(providerConversationID, ordinal, "turn-started",
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: turnID}))
	result = append(result, cursorTerminalHistoryEvent(providerConversationID, ordinal, "user",
		ports.ChatEvent{
			Kind: ports.ChatEventUserMessageCompleted, ProviderTurnID: turnID,
			ProviderItemID: turnID + ":user", ClientMessageID: turnID + ":user", Text: turn.user,
		}))
	if turn.assistant != "" {
		result = append(result, cursorTerminalHistoryEvent(providerConversationID, ordinal, "assistant",
			ports.ChatEvent{
				Kind: ports.ChatEventMessageCompleted, ProviderTurnID: turnID,
				ProviderItemID: turnID + ":assistant", Text: turn.assistant,
			}))
	}
	turnState := domain.TurnStateRecovered
	if turn.assistant != "" {
		turnState = domain.TurnStateCompleted
	}
	return append(result, cursorTerminalHistoryEvent(providerConversationID, ordinal, "turn-completed",
		ports.ChatEvent{
			Kind: ports.ChatEventTurnCompleted, ProviderTurnID: turnID, TurnState: turnState,
		}))
}

func normalizeCursorHistoryText(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func cursorTerminalHistoryEvent(
	providerConversationID string,
	ordinal int,
	kind string,
	event ports.ChatEvent,
) ports.ChatEvent {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s", providerConversationID, ordinal, kind)))
	event.ProviderEventID = "cursor-terminal:" + hex.EncodeToString(sum[:16])
	return event
}

func readCursorTerminalTranscript(
	ctx context.Context,
	dataDir string,
	providerConversationID string,
) ([]cursorTranscriptTurn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id := strings.TrimSpace(providerConversationID)
	if id == "" || filepath.Base(id) != id || strings.ContainsAny(id, `*?[]/\`) {
		return nil, fmt.Errorf("%w: invalid Cursor native conversation id", ports.ErrChatHistoryUnavailable)
	}
	pattern := filepath.Join(dataDir, "cursor", "projects", "*", "agent-transcripts", id, id+".jsonl")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, fmt.Errorf("%w: locate Cursor terminal transcript: %v", ports.ErrChatHistoryUnavailable, err)
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("%w: expected one Cursor terminal transcript for %s, found %d",
			ports.ErrChatHistoryUnavailable, id, len(matches))
	}
	info, err := os.Stat(matches[0])
	if err != nil {
		return nil, fmt.Errorf("%w: stat Cursor terminal transcript: %v", ports.ErrChatHistoryUnavailable, err)
	}
	if info.Size() > cursorHandoffTranscriptLimit {
		return nil, fmt.Errorf("%w: Cursor terminal transcript exceeds %d bytes",
			ports.ErrChatHistoryUnavailable, cursorHandoffTranscriptLimit)
	}
	file, err := os.Open(matches[0])
	if err != nil {
		return nil, fmt.Errorf("%w: open Cursor terminal transcript: %v", ports.ErrChatHistoryUnavailable, err)
	}
	defer file.Close()

	var turns []cursorTranscriptTurn
	skipHandoffAssistant := false
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), cursorHandoffTranscriptLimit)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var line cursorTranscriptLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}
		text := cursorTranscriptText(line)
		switch line.Role {
		case "user":
			query := cursorUserQuery(text)
			if messages, ok := cursorInterfaceHandoffMessages(query); ok {
				for _, message := range messages {
					switch message.Role {
					case "user":
						turns = append(turns, cursorTranscriptTurn{user: message.Text, migrated: true})
					case "assistant":
						if len(turns) > 0 && turns[len(turns)-1].assistant == "" {
							turns[len(turns)-1].assistant = message.Text
						}
					}
				}
				skipHandoffAssistant = true
				continue
			}
			if cursorInterfaceHandoffCandidate(query) {
				return nil, fmt.Errorf("%w: malformed Cursor interface handoff envelope", ports.ErrChatHistoryUnavailable)
			}
			skipHandoffAssistant = false
			if query != "" {
				turns = append(turns, cursorTranscriptTurn{user: query})
			}
		case "assistant":
			if skipHandoffAssistant {
				continue
			}
			text = cleanCursorTranscriptAssistant(text)
			if text != "" && len(turns) > 0 {
				if turns[len(turns)-1].assistant != "" {
					turns[len(turns)-1].assistant += "\n"
				}
				turns[len(turns)-1].assistant += text
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("%w: read Cursor terminal transcript: %v", ports.ErrChatHistoryUnavailable, err)
	}
	if len(turns) == 0 {
		return nil, fmt.Errorf("%w: Cursor terminal transcript contains no user turns", ports.ErrChatHistoryUnavailable)
	}
	return turns, nil
}

func cleanCursorTranscriptAssistant(text string) string {
	lines := strings.Split(text, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.TrimSpace(line) != "[REDACTED]" {
			kept = append(kept, line)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

func cursorInterfaceHandoffMessages(query string) ([]cursorInterfaceHandoffMessage, bool) {
	if !strings.HasPrefix(strings.TrimSpace(query), `<ao-interface-handoff version="1">`) {
		return nil, false
	}
	var envelope cursorInterfaceHandoffEnvelope
	if err := xml.Unmarshal([]byte(query), &envelope); err != nil || envelope.XMLName.Local != "ao-interface-handoff" {
		return nil, false
	}
	messages := envelope.Messages[:0]
	for _, message := range envelope.Messages {
		message.Role = strings.TrimSpace(message.Role)
		message.Text = strings.TrimSpace(message.Text)
		if message.Text != "" && (message.Role == "user" || message.Role == "assistant") {
			messages = append(messages, message)
		}
	}
	return messages, true
}

func cursorInterfaceHandoffCandidate(query string) bool {
	return strings.HasPrefix(strings.TrimSpace(query), "<ao-interface-handoff")
}

func cursorTranscriptText(line cursorTranscriptLine) string {
	var parts []string
	for _, content := range line.Message.Content {
		if content.Type == "text" && strings.TrimSpace(content.Text) != "" {
			parts = append(parts, strings.TrimSpace(content.Text))
		}
	}
	return strings.Join(parts, "\n")
}

func cursorUserQuery(text string) string {
	const open, close = "<user_query>", "</user_query>"
	start := strings.Index(text, open)
	if start < 0 {
		return strings.TrimSpace(text)
	}
	rest := text[start+len(open):]
	end := strings.Index(rest, close)
	if end < 0 {
		return strings.TrimSpace(rest)
	}
	return strings.TrimSpace(rest[:end])
}
