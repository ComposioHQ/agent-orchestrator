package domain

// SpawnPhase is how far a session's spawn got, durably, so a crash between
// "seed row created" and "controller committed" leaves the next boot an
// unambiguous instruction: finish the launch, or clean the attempt up.
type SpawnPhase string

// Spawn phases, in the order a successful spawn passes through them.
const (
	// SpawnPhasePreparing is the seed row. No workspace is confirmed to belong
	// to this session yet, so nothing outside the row may be destroyed on its
	// behalf.
	SpawnPhasePreparing SpawnPhase = "preparing"
	// SpawnPhaseWorkspaceReady means the worktree, branch, and the original
	// prompt are checkpointed. The workspace is real and holds user-visible
	// state, so recovery must reopen it rather than delete it.
	SpawnPhaseWorkspaceReady SpawnPhase = "workspace_ready"
	// SpawnPhaseControllerReady means a controller identity (terminal runtime
	// handle or Chat controller generation) is committed alongside the workspace
	// metadata. Only in this phase may native resume be attempted.
	SpawnPhaseControllerReady SpawnPhase = "controller_ready"
)

// SpawnPhaseTrackingEnabled gates checkpointing and recovery to Cursor, by
// product decision. The failure is NOT Cursor-specific — every harness can
// strand a session on ErrIncompleteHandle — so this limits rollout, not the
// reach of the bug. It is the only harness check in the feature: every consumer
// reads the phase alone, so an untracked harness stays controller_ready and
// behaves as before, and widening is a change to this function.
func SpawnPhaseTrackingEnabled(harness AgentHarness) bool {
	return harness == HarnessCursor
}

// InitialSpawnPhase seeds a tracked harness at preparing, and every other
// harness at controller_ready so the phase carries no information for it.
func InitialSpawnPhase(harness AgentHarness) SpawnPhase {
	if SpawnPhaseTrackingEnabled(harness) {
		return SpawnPhasePreparing
	}
	return SpawnPhaseControllerReady
}

// NormalizeSpawnPhase maps an empty or unrecognized stored value to
// SpawnPhaseControllerReady. Rows written before the column existed describe
// fully launched sessions, and an unknown value from a newer build must not
// make an established session look half-spawned.
func NormalizeSpawnPhase(p SpawnPhase) SpawnPhase {
	switch p {
	case SpawnPhasePreparing, SpawnPhaseWorkspaceReady, SpawnPhaseControllerReady:
		return p
	default:
		return SpawnPhaseControllerReady
	}
}

// SpawnCheckpointedWorkspace reports whether the worktree is durably known to
// belong to this session, and so is safe to offer a shell into.
func (r SessionRecord) SpawnCheckpointedWorkspace() bool {
	if r.Metadata.WorkspacePath == "" {
		return false
	}
	switch NormalizeSpawnPhase(r.SpawnPhase) {
	case SpawnPhaseWorkspaceReady, SpawnPhaseControllerReady:
		return true
	default:
		return false
	}
}

// SpawnHasControllerIdentity reports whether a durable controller owner exists.
// controller_ready must never be published without one.
func (r SessionRecord) SpawnHasControllerIdentity() bool {
	if NormalizeSessionMode(r.Mode) == SessionModeChat {
		return r.Metadata.ControllerGeneration != ""
	}
	return r.Metadata.RuntimeLaunchID != "" || r.Metadata.RuntimeHandleID != ""
}

// SpawnWorkspaceCheckpoint is written the instant a spawn's workspace exists,
// as one unit, so a crash cannot leave a worktree no session claims.
type SpawnWorkspaceCheckpoint struct {
	WorkspacePath     string
	WorkspaceRepoPath string
	Branch            string
	// Prompt is the original spawn prompt, replayed only if no provider ever
	// received it — which is why it must survive the crash.
	Prompt string
	Model  string
}
