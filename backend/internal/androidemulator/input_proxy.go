package androidemulator

import (
	"context"
	"fmt"
)

// InputAction is one renderer-originated input event.
type InputAction struct {
	Type string `json:"type"` // "tap" | "swipe" | "key" | "text"
	// X, Y are the tap point, or the swipe start point.
	X int32 `json:"x,omitempty"`
	Y int32 `json:"y,omitempty"`
	// X2, Y2 are the swipe end point.
	X2 int32 `json:"x2,omitempty"`
	Y2 int32 `json:"y2,omitempty"`
	// Key is a named key (e.g. "Home", "Back") for Type == "key".
	Key string `json:"key,omitempty"`
	// Text is arbitrary text for Type == "text", sent one character at a time.
	Text string `json:"text,omitempty"`
}

// swipeSteps is the number of intermediate mouse-move events synthesized
// between a swipe's start and end point. Coarse-grained is fine: the
// emulator only needs enough samples to recognize a drag, not a
// pixel-accurate trace.
const swipeSteps = 10

// InputProxy translates renderer InputActions into EmulatorClient calls,
// including composite gestures (swipe, text) built from EmulatorClient's
// low-level primitives (Tap/MouseEvent/PressKey).
type InputProxy struct {
	client *EmulatorClient
}

// NewInputProxy builds a proxy that issues input through client.
func NewInputProxy(client *EmulatorClient) *InputProxy {
	return &InputProxy{client: client}
}

// Handle dispatches action to the appropriate EmulatorClient call(s).
func (p *InputProxy) Handle(ctx context.Context, action InputAction) error {
	switch action.Type {
	case "tap":
		return p.client.Tap(ctx, action.X, action.Y)
	case "swipe":
		return p.swipe(ctx, action.X, action.Y, action.X2, action.Y2)
	case "key":
		return p.client.PressKey(ctx, action.Key)
	case "text":
		return p.typeText(ctx, action.Text)
	default:
		return fmt.Errorf("androidemulator: unknown input action type %q", action.Type)
	}
}

// swipe synthesizes a drag as a mouse-down at the start point, a series of
// intermediate move events (button still down) toward the end point, and a
// mouse-up at the end point -- the same shape a real trackpad/mouse drag
// would produce, which is what the emulator's pointer input expects.
func (p *InputProxy) swipe(ctx context.Context, x1, y1, x2, y2 int32) error {
	if err := p.client.MouseEvent(ctx, x1, y1, true); err != nil {
		return err
	}
	for i := int32(1); i <= swipeSteps; i++ {
		x := x1 + (x2-x1)*i/swipeSteps
		y := y1 + (y2-y1)*i/swipeSteps
		if err := p.client.MouseEvent(ctx, x, y, true); err != nil {
			return err
		}
	}
	return p.client.MouseEvent(ctx, x2, y2, false)
}

// typeText sends one key press per character. NOTE: this assumes the
// emulator's SendKey accepts a single Unicode character as a "key" value for
// ordinary text characters (distinct from named keys like "Home"/"Back") --
// verified empirically against a real booted emulator, not just asserted.
func (p *InputProxy) typeText(ctx context.Context, text string) error {
	for _, r := range text {
		if err := p.client.PressKey(ctx, string(r)); err != nil {
			return err
		}
	}
	return nil
}
