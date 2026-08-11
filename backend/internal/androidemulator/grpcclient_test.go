package androidemulator

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/androidemulator/pb"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
)

// fakeEmulatorControllerClient embeds a nil pb.EmulatorControllerClient so it
// satisfies the (48-method) interface without hand-writing every method;
// only the methods a test actually needs are overridden below. Calling any
// unfaked method panics loudly (nil interface dereference), which is exactly
// the right failure mode for "a test exercised something it didn't expect to".
type fakeEmulatorControllerClient struct {
	pb.EmulatorControllerClient

	screenshotFunc func(ctx context.Context, in *pb.ImageFormat, opts ...grpc.CallOption) (*pb.Image, error)
	sendTouchFunc  func(ctx context.Context, in *pb.TouchEvent, opts ...grpc.CallOption) (*emptypb.Empty, error)
	sendMouseFunc  func(ctx context.Context, in *pb.MouseEvent, opts ...grpc.CallOption) (*emptypb.Empty, error)
	sendKeyFunc    func(ctx context.Context, in *pb.KeyboardEvent, opts ...grpc.CallOption) (*emptypb.Empty, error)
}

func (f *fakeEmulatorControllerClient) GetScreenshot(ctx context.Context, in *pb.ImageFormat, opts ...grpc.CallOption) (*pb.Image, error) {
	return f.screenshotFunc(ctx, in, opts...)
}
func (f *fakeEmulatorControllerClient) SendTouch(ctx context.Context, in *pb.TouchEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.sendTouchFunc(ctx, in, opts...)
}
func (f *fakeEmulatorControllerClient) SendMouse(ctx context.Context, in *pb.MouseEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.sendMouseFunc(ctx, in, opts...)
}
func (f *fakeEmulatorControllerClient) SendKey(ctx context.Context, in *pb.KeyboardEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.sendKeyFunc(ctx, in, opts...)
}

func TestEmulatorClientScreenshotReturnsPNGBytes(t *testing.T) {
	want := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	fake := &fakeEmulatorControllerClient{
		screenshotFunc: func(ctx context.Context, in *pb.ImageFormat, opts ...grpc.CallOption) (*pb.Image, error) {
			if in.GetFormat() != pb.ImageFormat_PNG {
				t.Errorf("requested format = %v, want PNG", in.GetFormat())
			}
			return &pb.Image{Image: want}, nil
		},
	}
	c := NewEmulatorClient(fake)

	got, err := c.Screenshot(context.Background())
	if err != nil {
		t.Fatalf("Screenshot: %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("Screenshot() = %v, want %v", got, want)
	}
}

func TestEmulatorClientScreenshotPropagatesError(t *testing.T) {
	fake := &fakeEmulatorControllerClient{
		screenshotFunc: func(ctx context.Context, in *pb.ImageFormat, opts ...grpc.CallOption) (*pb.Image, error) {
			return nil, errors.New("boom")
		},
	}
	c := NewEmulatorClient(fake)

	if _, err := c.Screenshot(context.Background()); err == nil {
		t.Error("Screenshot: want an error, got nil")
	}
}

func TestEmulatorClientTapSendsCorrectCoordinates(t *testing.T) {
	var got *pb.TouchEvent
	fake := &fakeEmulatorControllerClient{
		sendTouchFunc: func(ctx context.Context, in *pb.TouchEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
			got = in
			return &emptypb.Empty{}, nil
		},
	}
	c := NewEmulatorClient(fake)

	if err := c.Tap(context.Background(), 540, 1200); err != nil {
		t.Fatalf("Tap: %v", err)
	}
	if len(got.GetTouches()) != 1 || got.GetTouches()[0].GetX() != 540 || got.GetTouches()[0].GetY() != 1200 {
		t.Errorf("SendTouch called with %+v, want a single touch at (540, 1200)", got)
	}
}

func TestEmulatorClientPressKeySendsCorrectKey(t *testing.T) {
	var got *pb.KeyboardEvent
	fake := &fakeEmulatorControllerClient{
		sendKeyFunc: func(ctx context.Context, in *pb.KeyboardEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
			got = in
			return &emptypb.Empty{}, nil
		},
	}
	c := NewEmulatorClient(fake)

	if err := c.PressKey(context.Background(), "Home"); err != nil {
		t.Fatalf("PressKey: %v", err)
	}
	if got.GetKey() != "Home" || got.GetEventType() != pb.KeyboardEvent_keypress {
		t.Errorf("SendKey called with %+v, want Key=Home EventType=keypress", got)
	}
}

func TestEmulatorClientMoveTapSendsMouseEvent(t *testing.T) {
	var got *pb.MouseEvent
	fake := &fakeEmulatorControllerClient{
		sendMouseFunc: func(ctx context.Context, in *pb.MouseEvent, opts ...grpc.CallOption) (*emptypb.Empty, error) {
			got = in
			return &emptypb.Empty{}, nil
		},
	}
	c := NewEmulatorClient(fake)

	if err := c.MouseEvent(context.Background(), 100, 200, true); err != nil {
		t.Fatalf("MouseEvent: %v", err)
	}
	if got.GetX() != 100 || got.GetY() != 200 || got.GetButtons() != 1 {
		t.Errorf("SendMouse called with %+v, want (100, 200, buttons=1)", got)
	}
}
