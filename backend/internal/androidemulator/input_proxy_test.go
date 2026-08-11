package androidemulator

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/androidemulator/pb"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
)

func TestInputActionJSONRoundTripsXAndYIndependently(t *testing.T) {
	// A prior version accidentally shared one struct tag across X and Y (Go
	// applies a trailing tag on a combined field declaration to every field
	// in it), silently mapping both to JSON key "x" and corrupting Y on the
	// wire. This guards against that regressing.
	in := InputAction{Type: "swipe", X: 10, Y: 20, X2: 30, Y2: 40}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out InputAction
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if out != in {
		t.Errorf("round-tripped = %+v, want %+v (raw JSON: %s)", out, in, data)
	}
}

// fakeInputClient is a smaller fake than fakeEmulatorControllerClient,
// focused on recording the sequence of touch/mouse/key calls InputProxy
// makes, to verify gesture translation (e.g. swipe -> a mouse-down, N
// intermediate moves, mouse-up sequence) rather than any single call's
// content in isolation.
type fakeInputClient struct {
	pb.EmulatorControllerClient
	mouseEvents []*pb.MouseEvent
	touchEvents []*pb.TouchEvent
	keyEvents   []*pb.KeyboardEvent
	failOn      int // if > 0, the failOn-th call (1-indexed, across all calls) returns an error
	callCount   int
}

func (f *fakeInputClient) nextErr() error {
	f.callCount++
	if f.failOn > 0 && f.callCount == f.failOn {
		return errors.New("boom")
	}
	return nil
}

func (f *fakeInputClient) SendMouse(ctx context.Context, in *pb.MouseEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	f.mouseEvents = append(f.mouseEvents, in)
	return &emptypb.Empty{}, f.nextErr()
}
func (f *fakeInputClient) SendTouch(ctx context.Context, in *pb.TouchEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	f.touchEvents = append(f.touchEvents, in)
	return &emptypb.Empty{}, f.nextErr()
}
func (f *fakeInputClient) SendKey(ctx context.Context, in *pb.KeyboardEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	f.keyEvents = append(f.keyEvents, in)
	return &emptypb.Empty{}, f.nextErr()
}

func TestInputProxyHandleTap(t *testing.T) {
	fake := &fakeInputClient{}
	p := NewInputProxy(NewEmulatorClient(fake))

	if err := p.Handle(context.Background(), InputAction{Type: "tap", X: 100, Y: 200}); err != nil {
		t.Fatalf("Handle(tap): %v", err)
	}
	if len(fake.touchEvents) != 1 || fake.touchEvents[0].GetTouches()[0].GetX() != 100 {
		t.Errorf("touchEvents = %+v, want one touch at x=100", fake.touchEvents)
	}
}

func TestInputProxyHandleKey(t *testing.T) {
	fake := &fakeInputClient{}
	p := NewInputProxy(NewEmulatorClient(fake))

	if err := p.Handle(context.Background(), InputAction{Type: "key", Key: "Back"}); err != nil {
		t.Fatalf("Handle(key): %v", err)
	}
	if len(fake.keyEvents) != 1 || fake.keyEvents[0].GetKey() != "Back" {
		t.Errorf("keyEvents = %+v, want one key=Back", fake.keyEvents)
	}
}

func TestInputProxyHandleSwipeSendsDownIntermediateMovesAndUp(t *testing.T) {
	fake := &fakeInputClient{}
	p := NewInputProxy(NewEmulatorClient(fake))

	if err := p.Handle(context.Background(), InputAction{Type: "swipe", X: 0, Y: 1000, X2: 0, Y2: 0}); err != nil {
		t.Fatalf("Handle(swipe): %v", err)
	}
	if len(fake.mouseEvents) < 3 {
		t.Fatalf("mouseEvents count = %d, want at least 3 (down, intermediate move(s), up)", len(fake.mouseEvents))
	}
	first, last := fake.mouseEvents[0], fake.mouseEvents[len(fake.mouseEvents)-1]
	if first.GetButtons() == 0 {
		t.Error("first mouse event has no button pressed, want the initial press (button down)")
	}
	if last.GetButtons() != 0 {
		t.Error("last mouse event still has a button pressed, want the release (button up)")
	}
	if first.GetY() != 1000 || last.GetY() != 0 {
		t.Errorf("swipe endpoints Y = %d..%d, want 1000..0", first.GetY(), last.GetY())
	}
}

func TestInputProxyHandleTextSendsOneKeyPerCharacter(t *testing.T) {
	fake := &fakeInputClient{}
	p := NewInputProxy(NewEmulatorClient(fake))

	if err := p.Handle(context.Background(), InputAction{Type: "text", Text: "hi"}); err != nil {
		t.Fatalf("Handle(text): %v", err)
	}
	if len(fake.keyEvents) != 2 || fake.keyEvents[0].GetKey() != "h" || fake.keyEvents[1].GetKey() != "i" {
		t.Errorf("keyEvents = %+v, want [h, i]", fake.keyEvents)
	}
}

func TestInputProxyHandleUnknownActionType(t *testing.T) {
	fake := &fakeInputClient{}
	p := NewInputProxy(NewEmulatorClient(fake))

	if err := p.Handle(context.Background(), InputAction{Type: "wiggle"}); err == nil {
		t.Error("Handle(wiggle): want an error for an unknown action type, got nil")
	}
}

func TestInputProxyHandleSwipeStopsOnFirstError(t *testing.T) {
	fake := &fakeInputClient{failOn: 1}
	p := NewInputProxy(NewEmulatorClient(fake))

	err := p.Handle(context.Background(), InputAction{Type: "swipe", X: 0, Y: 0, X2: 100, Y2: 100})
	if err == nil {
		t.Fatal("Handle(swipe) with a failing first call: want an error, got nil")
	}
	if len(fake.mouseEvents) != 1 {
		t.Errorf("mouseEvents count = %d after a first-call failure, want 1 (stop on error, don't keep sending)", len(fake.mouseEvents))
	}
}
