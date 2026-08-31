package runtimeselect

import "log/slog"

func newDarwinRuntime(legacy, direct routedBackend, log *slog.Logger) *hybridRuntime {
	return newHybridRuntime(legacy, direct, log, "macOS")
}
