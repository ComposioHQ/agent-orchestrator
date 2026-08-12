package httpapi

import "testing"

func TestSupportedInteractivePolicyFailsClosed(t *testing.T) {
	tests := []struct {
		name    string
		request createSessionRequest
		want    bool
	}{
		{name: "standard", request: createSessionRequest{Mode: "standard"}, want: true},
		{name: "trusted", request: createSessionRequest{Mode: "trusted"}, want: true},
		{name: "read only", request: createSessionRequest{Mode: "read-only"}},
		{
			name: "command deny rules",
			request: createSessionRequest{
				Mode: "standard", DeniedCommands: []string{"git push:*"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := supportedInteractivePolicy(test.request); got != test.want {
				t.Fatalf("supportedInteractivePolicy() = %t, want %t", got, test.want)
			}
		})
	}
}
