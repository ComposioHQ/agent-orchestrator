package iossimulator

import "testing"

func TestManagerStartCreatesAndBootsDevice(t *testing.T) {
	var calls []string
	m := NewWithRunner(func(name string, args ...string) ([]byte, error) {
		calls = append(calls, name+" "+join(args))
		switch join(args) {
		case "simctl list devicetypes -j":
			return []byte(`{"devicetypes":[{"identifier":"iphone.old","name":"iPhone 14"},{"identifier":"iphone.new","name":"iPhone 15"}]}`), nil
		case "simctl list runtimes -j":
			return []byte(`{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-17-0","isAvailable":true},{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-0","isAvailable":true}]}`), nil
		case "simctl create AO iPhone iphone.new com.apple.CoreSimulator.SimRuntime.iOS-18-0":
			return []byte("device-1\n"), nil
		case "simctl list devices -j":
			return []byte(`{"devices":{"runtime":[{"udid":"device-1","state":"Shutdown"}]}}`), nil
		default:
			return nil, nil
		}
	})
	status, err := m.Start()
	if err != nil {
		t.Fatal(err)
	}
	if status.DeviceID != "device-1" || status.State != "Booted" {
		t.Fatalf("unexpected status: %+v", status)
	}
	if len(calls) == 0 {
		t.Fatal("expected simctl calls")
	}
}

func join(parts []string) string {
	result := ""
	for i, part := range parts {
		if i > 0 {
			result += " "
		}
		result += part
	}
	return result
}
