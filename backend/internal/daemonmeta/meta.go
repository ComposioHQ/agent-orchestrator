package daemonmeta

// ServiceName identifies the AO daemon in loopback health/readiness probes.
// The CLI uses it with the reported PID to avoid signaling an unrelated process
// when a stale run-file's PID has been reused.
const ServiceName = "agent-orchestrator-daemon"

// APIVersion is the daemon API compatibility version, exposed on /healthz and
// /readyz. Remote clients (e.g. a desktop app attached to a headless daemon
// over Tailscale) compare it against the version they support and report a
// clear upgrade mismatch instead of failing later on individual routes.
// Increment it on breaking daemon API changes; additive changes do not bump it.
const APIVersion = 1
