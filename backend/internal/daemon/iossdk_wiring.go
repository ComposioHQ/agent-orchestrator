package daemon

import "github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"

// IOSDevice is kept as a singleton so the daemon and future lifecycle manager
// share one toolchain boundary.
func IOSDevice() *controllers.IOSDeviceController { return &controllers.IOSDeviceController{} }
