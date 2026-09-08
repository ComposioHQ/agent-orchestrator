package chat_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
)

type blockingHandoffConfigurer struct {
	*fakeConversation
	entered chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (c *blockingHandoffConfigurer) ListConfigOptions(context.Context) ([]ports.ChatConfigOption, error) {
	return nil, nil
}
func (c *blockingHandoffConfigurer) SetConfigOption(ctx context.Context, _ string, _ ports.ChatConfigOptionValue) ([]ports.ChatConfigOption, error) {
	c.calls.Add(1)
	close(c.entered)
	select {
	case <-c.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return []ports.ChatConfigOption{{ID: "model", Current: ports.ChatConfigOptionValue{Select: "new-model"}}}, nil
}

func TestProviderConfigCannotMutateAfterHandoffIsArmed(t *testing.T) {
	c := &blockingHandoffConfigurer{fakeConversation: newFakeConversation(), entered: make(chan struct{}), release: make(chan struct{})}
	close(c.release)
	h := newHarnessWithConversation(t, c)
	ctx := context.Background()
	if err := h.svc.ArmChatHandoff(ctx, testSession, domain.SessionInterfaceTransitionDrain); err != nil {
		t.Fatal(err)
	}
	_, err := h.svc.SetConfigOption(ctx, testSession, "model", ports.ChatConfigOptionValue{Select: "new-model"})
	if !errors.Is(err, chatsvc.ErrControllerHandoff) {
		t.Fatalf("error = %v", err)
	}
	if c.calls.Load() != 0 {
		t.Fatal("provider mutated after handoff was armed")
	}
}

func TestProviderConfigMutationCommitsBeforeHandoffCanArm(t *testing.T) {
	c := &blockingHandoffConfigurer{fakeConversation: newFakeConversation(), entered: make(chan struct{}), release: make(chan struct{})}
	h := newHarnessWithConversation(t, c)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	configDone := make(chan error, 1)
	go func() {
		_, err := h.svc.SetConfigOption(ctx, testSession, "model", ports.ChatConfigOptionValue{Select: "new-model"})
		configDone <- err
	}()
	select {
	case <-c.entered:
	case <-ctx.Done():
		t.Fatal("provider call did not start")
	}
	armDone := make(chan error, 1)
	go func() { armDone <- h.svc.ArmChatHandoff(ctx, testSession, domain.SessionInterfaceTransitionDrain) }()
	select {
	case err := <-armDone:
		close(c.release)
		t.Fatalf("handoff armed before provider mutation completed: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(c.release)
	if err := <-configDone; err != nil {
		t.Fatal(err)
	}
	if err := <-armDone; err != nil {
		t.Fatal(err)
	}
	controller, err := h.svc.Controller(testSession)
	if err != nil {
		t.Fatal(err)
	}
	if controller.Settings().Model != "new-model" {
		t.Fatal("handoff did not observe committed provider settings")
	}
	if _, err := h.svc.SetConfigOption(ctx, testSession, "model", ports.ChatConfigOptionValue{Select: "later"}); !errors.Is(err, chatsvc.ErrControllerHandoff) {
		t.Fatalf("later mutation: %v", err)
	}
	if c.calls.Load() != 1 {
		t.Fatal("provider mutated after handoff")
	}
}
