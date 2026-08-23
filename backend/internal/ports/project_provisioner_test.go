package ports

import "testing"

func TestProjectProvisionTerminalStates(t *testing.T) {
	t.Parallel()
	terminal := map[ProjectProvisionState]bool{
		ProjectProvisionIntentRecorded:        false,
		ProjectProvisionPlacementProvisioning: false,
		ProjectProvisionPlacementReady:        false,
		ProjectProvisionMaterializing:         false,
		ProjectProvisionFinalizing:            false,
		ProjectProvisionFinalized:             true,
		ProjectProvisionCompensationPending:   false,
		ProjectProvisionCompensating:          false,
		ProjectProvisionCompensated:           true,
		ProjectProvisionRetryPending:          false,
		ProjectProvisionFailed:                true,
	}
	for state, want := range terminal {
		if got := state.Terminal(); got != want {
			t.Errorf("%q.Terminal() = %v, want %v", state, got, want)
		}
	}
}
