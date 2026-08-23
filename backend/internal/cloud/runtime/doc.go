// Package runtime owns AO Cloud's compute plane: the isolated sandboxes that
// host a workspace's coordinator and its worker agents.
//
// Boundaries this package deliberately keeps:
//
//   - It never holds durable product state. Projects, sessions, prompts, PR
//     facts, and lifecycle history live in the control plane's database. A
//     sandbox is disposable; losing or reaping one must lose nothing but a
//     checkout, a cache, and live processes.
//   - It talks to a Provider through one narrow port, so the Daytona adapter
//     can be swapped or faked without the lifecycle rules changing.
//   - It persists placement facts through one narrow, consumer-owned Store
//     port. The package does not import a database driver.
//   - Coordinators and workers get SEPARATE sandboxes with SEPARATE, scoped
//     capabilities. A worker cannot call coordinator operations, and neither
//     can reach another session's credentials.
//
// The load-bearing ordering rule is: the database row is written BEFORE the
// provider is asked to create anything, and deleted AFTER the provider
// confirms removal. That makes every failure mode converge under the
// reconciler in reaper.go: a crash between the two leaves either a row with no
// sandbox (repaired on the next pass) or, when a create response is lost, a
// labelled sandbox with no row (reaped as an orphan after a grace period).
package runtime
