package notification

import "github.com/aoagents/agent-orchestrator/backend/internal/ports"

// Store is the notification service's read persistence surface.
type Store = ports.NotificationReader
