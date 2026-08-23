package domain

import "testing"

func TestNotificationTypeValidAndNeedsResolution(t *testing.T) {
	tests := []struct {
		typ             NotificationType
		valid           bool
		needsResolution bool
	}{
		{NotificationNeedsInput, true, true},
		{NotificationTurnComplete, true, true},
		{NotificationReadyToMerge, true, true},
		{NotificationPRMerged, true, false},
		{NotificationPRClosedUnmerged, true, false},
		{"unknown", false, false},
	}

	for _, tt := range tests {
		t.Run(string(tt.typ), func(t *testing.T) {
			if got := tt.typ.Valid(); got != tt.valid {
				t.Fatalf("Valid() = %v, want %v", got, tt.valid)
			}
			if got := tt.typ.NeedsResolution(); got != tt.needsResolution {
				t.Fatalf("NeedsResolution() = %v, want %v", got, tt.needsResolution)
			}
		})
	}
}
