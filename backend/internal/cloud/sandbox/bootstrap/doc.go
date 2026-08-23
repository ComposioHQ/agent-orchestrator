// Package bootstrap is the sandbox's init: the process that runs when a
// Daytona sandbox starts, brings the workload up in order, and tells the
// control plane when the sandbox can actually be used.
//
// It exists because creating a sandbox is not the same thing as having one. A
// provider Create that ignored Command and Args would return a healthy-looking
// sandbox with nothing running inside it, and the control plane would mark a
// session ready that has no daemon, no agent, and no terminal.
//
// What it supervises, in order:
//
//  1. The AO daemon (`ao start`), on loopback, exactly as it runs on a laptop.
//     Nothing about the daemon is cloud-aware; the sandbox is just another
//     machine it happens to be running on.
//  2. The agent harness, if the placement declares one.
//
// Each step may declare a readiness probe, and a step is not started until the
// previous one has passed its own. That ordering is the point: the published
// mux listener relays to the daemon's loopback /mux, so reporting ready before
// the daemon answers would publish a terminal endpoint that 502s.
//
// # No restart policy, deliberately
//
// A step that exits is a failed sandbox, reported as such and left dead. This
// package does not restart anything. A daemon that crashed took the session's
// tmux server, its panes, and its agent process with it; restarting it in place
// would produce a sandbox that looks healthy and has silently lost the work the
// user is looking at. The control plane already knows how to replace a failed
// sandbox, and that is the path that keeps its records honest.
//
// # Secrets
//
// Secrets arrive in the environment and in owner-only files (see
// runtime.CreateRequest), never in argv — the compute plane enforces that at
// the create call and this package holds the same line on the way back down:
// child processes inherit secrets through their environment, and neither a
// secret value nor a secret-bearing environment is ever logged. Redact and
// TestBootstrapNeverLogsSecretValues are what keep that true as steps are
// added.
package bootstrap
