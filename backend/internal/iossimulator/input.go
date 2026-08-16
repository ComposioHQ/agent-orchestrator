package iossimulator

import "fmt"

type Input struct {
	Action  string  `json:"action"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	X2      float64 `json:"x2"`
	Y2      float64 `json:"y2"`
	Text    string  `json:"text"`
	KeyCode int     `json:"keyCode"`
}

func (m *Manager) Input(input Input) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.device.DeviceID == "" {
		return fmt.Errorf("iOS Simulator is not started")
	}
	state, err := m.deviceState(m.device.DeviceID)
	if err != nil {
		return err
	}
	if state != "Booted" {
		return fmt.Errorf("iOS Simulator is not booted")
	}
	if m.screenshotWidth > 0 && m.screenshotHeight > 0 {
		bounds, err := simulatorWindowBounds()
		if err != nil {
			return fmt.Errorf("find Simulator window: %w", err)
		}
		input.X = bounds.X + input.X/float64(m.screenshotWidth)*bounds.Width
		input.Y = bounds.Y + input.Y/float64(m.screenshotHeight)*bounds.Height
		input.X2 = bounds.X + input.X2/float64(m.screenshotWidth)*bounds.Width
		input.Y2 = bounds.Y + input.Y2/float64(m.screenshotHeight)*bounds.Height
	}
	switch input.Action {
	case "tap":
		return tap(input.X, input.Y)
	case "swipe":
		return swipe(input.X, input.Y, input.X2, input.Y2)
	case "text":
		return text(input.Text)
	case "key":
		return key(input.KeyCode)
	default:
		return fmt.Errorf("unsupported iOS input action %q", input.Action)
	}
}
