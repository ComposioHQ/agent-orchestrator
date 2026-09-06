package chat_test

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
)

func TestQueuedEditAttachmentChanges(t *testing.T) {
	zero := int64(0)
	one := int64(1)
	for _, tc := range []struct {
		name     string
		text     string
		retained *[]int
		revision *int64
		add      []ports.ChatContent
		wantData []string
		wantErr  error
	}{
		{name: "preserve omitted", text: "updated", wantData: []string{"aGVsbG8="}},
		{name: "preserve explicit", text: "updated", retained: &[]int{0}, revision: &zero, wantData: []string{"aGVsbG8="}},
		{name: "remove", text: "updated", retained: &[]int{}, revision: &zero},
		{name: "replace", text: "updated", retained: &[]int{}, revision: &zero, add: []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "bmV3"}}, wantData: []string{"bmV3"}},
		{name: "append", text: "updated", add: []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "bmV3"}}, wantData: []string{"aGVsbG8=", "bmV3"}},
		{name: "image only", wantData: []string{"aGVsbG8="}},
		{name: "empty after removal", retained: &[]int{}, revision: &zero, wantErr: chatsvc.ErrQueuedTurnTextRequired},
		{name: "stale", text: "updated", retained: &[]int{}, revision: &one, wantErr: chatsvc.ErrQueuedEditConflict},
		{name: "missing revision", text: "updated", retained: &[]int{}, wantErr: chatsvc.ErrQueuedContentInvalid},
		{name: "invalid index", text: "updated", retained: &[]int{1}, revision: &zero, wantErr: chatsvc.ErrQueuedContentInvalid},
		{name: "duplicate index", text: "updated", retained: &[]int{0, 0}, revision: &zero, wantErr: chatsvc.ErrQueuedContentInvalid},
		{name: "negative index", text: "updated", retained: &[]int{-1}, revision: &zero, wantErr: chatsvc.ErrQueuedContentInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, provider := steerHarness(t)
			ctx := context.Background()
			turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "original", ClientMessageID: "queued-edit",
				Origin: domain.MessageOriginHuman, Content: []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "aGVsbG8="}}})
			if err != nil {
				t.Fatal(err)
			}
			err = h.svc.EditQueuedTurn(ctx, testSession, turn.ID, chatsvc.QueuedMessageEdit{
				Text: tc.text, Content: tc.add, RetainedContent: tc.retained, ExpectedRevision: tc.revision,
			})
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("edit = %v, want %v", err, tc.wantErr)
			}
			if _, err := h.svc.PromoteQueuedTurn(ctx, testSession, turn.ID); err != nil {
				t.Fatal(err)
			}
			calls := provider.steers()
			if len(calls) != 1 {
				t.Fatalf("provider calls = %d", len(calls))
			}
			wantText, wantData := tc.text, tc.wantData
			if tc.wantErr != nil {
				wantText, wantData = "original", []string{"aGVsbG8="}
			}
			if calls[0].msg.Text != wantText || len(calls[0].msg.Content) != len(wantData) {
				t.Fatalf("provider got text %q and %d attachments; want %q and %d", calls[0].msg.Text, len(calls[0].msg.Content), wantText, len(wantData))
			}
			for i, data := range wantData {
				if calls[0].msg.Content[i].Data != data {
					t.Fatalf("attachment %d changed", i)
				}
			}
		})
	}
}

func TestQueuedTextEditPreservesImageDelivery(t *testing.T) {
	for _, edit := range []bool{false, true} {
		name := "without_edit"
		if edit {
			name = "with_text_edit"
		}
		t.Run(name, func(t *testing.T) {
			h, provider := steerHarness(t)
			ctx := context.Background()
			turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
				Text:            "inspect this\n\nAttached files (read these files in the workspace):\n- .ao/attachments/image.png",
				ClientMessageID: "queued-image-analysis", Origin: domain.MessageOriginHuman,
				Content: []ports.ChatContent{{Type: "image", Data: "aGVsbG8=", MIMEType: "image/png"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			if edit {
				if err := h.svc.EditQueuedTurn(ctx, testSession, turn.ID, chatsvc.QueuedMessageEdit{Text: "inspect carefully\n\nAttached files (read these files in the workspace):\n- .ao/attachments/image.png"}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := h.svc.PromoteQueuedTurn(ctx, testSession, turn.ID); err != nil {
				t.Fatal(err)
			}
			calls := provider.steers()
			if len(calls) != 1 {
				t.Fatalf("provider calls = %d, want 1", len(calls))
			}
			if len(calls[0].msg.Content) != 1 {
				t.Fatalf("provider image blocks = %d, want 1; text = %q", len(calls[0].msg.Content), calls[0].msg.Text)
			}
		})
	}
}
