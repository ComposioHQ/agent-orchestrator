//go:build windows

package portscan

import "context"

// Windows detects nothing yet. Its socket enumeration and process walk land
// together in a follow-up (GetExtendedTcpTable plus CreateToolhelp32Snapshot);
// until then every anchor returns empty, which is the package's normal result
// rather than an error.

func listeners(_ context.Context, _ map[int]bool) []boundPort { return nil }

func processTable(_ context.Context) []process { return nil }

func workspaceProcesses(_ context.Context, _ []process, _ string) []int { return nil }
