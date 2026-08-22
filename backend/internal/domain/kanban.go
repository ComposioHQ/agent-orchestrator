package domain

import "github.com/aoagents/agent-orchestrator/backend/pkg/contract"

// KanbanColumn is the derived delivery-lifecycle placement of a session.
type KanbanColumn = contract.KanbanColumn

// Kanban columns.
const (
	KanbanBuilding    = contract.KanbanBuilding
	KanbanValidating  = contract.KanbanValidating
	KanbanNeedsReview = contract.KanbanNeedsReview
	KanbanReady       = contract.KanbanReady
	KanbanArchive     = contract.KanbanArchive
)
