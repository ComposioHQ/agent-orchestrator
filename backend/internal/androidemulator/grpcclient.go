package androidemulator

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/androidemulator/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// EmulatorClient is a thin, Go-native wrapper over the emulator's real
// EmulatorController gRPC service (loopback-only, confirmed working with no
// auth required by default during the A0 spike). It exposes exactly the RPCs
// this package needs (screenshot + input injection) with plain Go parameter
// types, keeping raw protobuf message construction out of framerelay.go and
// input_proxy.go.
type EmulatorClient struct {
	client pb.EmulatorControllerClient
	conn   *grpc.ClientConn // nil when constructed via NewEmulatorClient for tests
}

// DialEmulator connects to the emulator's loopback gRPC port (e.g.
// "127.0.0.1:8554"). The connection is insecure/no-TLS, matching the
// loopback-only, no-auth-by-default posture confirmed during the A0 spike —
// this must never be reachable from anywhere but the daemon itself.
func DialEmulator(addr string) (*EmulatorClient, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("androidemulator: dial %s: %w", addr, err)
	}
	return &EmulatorClient{client: pb.NewEmulatorControllerClient(conn), conn: conn}, nil
}

// NewEmulatorClient wraps an already-constructed pb.EmulatorControllerClient
// (real or, in tests, a fake). Exported so a future Manager-level wiring can
// reuse a single connection across calls, and so tests can inject a fake
// without dialing a real emulator.
func NewEmulatorClient(client pb.EmulatorControllerClient) *EmulatorClient {
	return &EmulatorClient{client: client}
}

// Close releases the underlying connection, if this client owns one (a
// client built via NewEmulatorClient directly, e.g. in tests, does not).
func (c *EmulatorClient) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// Screenshot returns the current screen as PNG bytes.
func (c *EmulatorClient) Screenshot(ctx context.Context) ([]byte, error) {
	img, err := c.client.GetScreenshot(ctx, &pb.ImageFormat{Format: pb.ImageFormat_PNG})
	if err != nil {
		return nil, fmt.Errorf("androidemulator: get screenshot: %w", err)
	}
	return img.GetImage(), nil
}

// Tap sends a single-point touch-down-and-up at (x, y) in device pixels.
func (c *EmulatorClient) Tap(ctx context.Context, x, y int32) error {
	_, err := c.client.SendTouch(ctx, &pb.TouchEvent{
		Touches: []*pb.Touch{{X: x, Y: y, Identifier: 0, Pressure: 1}},
	})
	if err != nil {
		return fmt.Errorf("androidemulator: send touch: %w", err)
	}
	return nil
}

// MouseEvent sends a single mouse position/button-state update, used to
// synthesize drag/swipe gestures as a sequence of move events (mirrors how a
// real trackpad/mouse would drive the emulator's own pointer input).
func (c *EmulatorClient) MouseEvent(ctx context.Context, x, y int32, buttonDown bool) error {
	var buttons int32
	if buttonDown {
		buttons = 1
	}
	_, err := c.client.SendMouse(ctx, &pb.MouseEvent{X: x, Y: y, Buttons: buttons})
	if err != nil {
		return fmt.Errorf("androidemulator: send mouse: %w", err)
	}
	return nil
}

// PressKey sends a single key press (e.g. "Home", "Back").
func (c *EmulatorClient) PressKey(ctx context.Context, key string) error {
	_, err := c.client.SendKey(ctx, &pb.KeyboardEvent{
		EventType: pb.KeyboardEvent_keypress,
		Key:       key,
	})
	if err != nil {
		return fmt.Errorf("androidemulator: send key: %w", err)
	}
	return nil
}
