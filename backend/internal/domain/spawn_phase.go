package domain

// SpawnPhase is how far a session's spawn got, durably. It exists so a daemon
// crash (or a cancelled request) at any point between "seed row created" and
// "controller committed" leaves an unambiguous instruction for the next boot:
// finish the launch, or clean the attempt up.
//
// It is a durable fact, not a derived status. The user-facing status is still
// derived at read time; this only tells the recovery path and the UI which
// facts about the session are trustworthy.
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

// Valid reports whether p is one of the known phases.
func (p SpawnPhase) Valid() bool {
	switch p {
	case SpawnPhasePreparing, SpawnPhaseWorkspaceReady, SpawnPhaseControllerReady:
		return true
	default:
		return false
	}
}

// NormalizeSpawnPhase maps an empty or unrecognized stored value to
// SpawnPhaseControllerReady. Rows written before the column existed describe
// fully launched sessions, and an unknown value from a newer build must not
// make an established session look half-spawned.
func NormalizeSpawnPhase(p SpawnPhase) SpawnPhase {
	if p.Valid() {
		return p
	}
	return SpawnPhaseControllerReady
}

// SpawnCheckpointedWorkspace reports whether the session's recorded workspace
// facts were durably checkpointed, i.e. the worktree is known to belong to this
// session. Callers use it before offering worktree-scoped affordances such as
// opening a shell.
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

// SpawnHasControllerIdentity reports whether a durable controller owner exists
// for this session: a terminal runtime generation, or a Chat controller
// generation. controller_ready must never be published without one.
func (r SessionRecord) SpawnHasControllerIdentity() bool {
	if NormalizeSessionMode(r.Mode) == SessionModeChat {
		return r.Metadata.ControllerGeneration != ""
	}
	return r.Metadata.RuntimeLaunchID != "" || r.Metadata.RuntimeHandleID != ""
}

// SpawnWorkspaceCheckpoint is the set of facts that become durable the instant
// a spawn's workspace exists. They are written together so a crash can never
// leave a worktree on disk that the database cannot attribute to a session, nor
// a session that claims a branch it never created.
type SpawnWorkspaceCheckpoint struct {
	WorkspacePath     string
	WorkspaceRepoPath string
	Branch            string
	// Prompt is the original spawn prompt. Recovery replays it only when the
	// provider never received it, which is why it must survive the crash.
	Prompt string
	Model  string
}
