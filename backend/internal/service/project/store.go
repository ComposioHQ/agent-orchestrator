package project

import "github.com/aoagents/agent-orchestrator/backend/internal/ports"

// Store is the durable project persistence surface required by Service.
type Store = ports.ProjectStore
