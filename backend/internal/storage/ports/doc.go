// Package storageports declares the durable-state contracts AO services depend
// on: projects, sessions, session worktrees, and conversations.
//
// Two implementations satisfy them. The local desktop daemon uses the SQLite
// store in internal/storage/sqlite/store; the hosted control plane uses the
// tenant-scoped PostgreSQL store in internal/cloud/postgres. Services and the
// HTTP API are the only consumers of both — there is no second API and no
// dual-write or synchronisation layer between the two stores. A deployment
// runs exactly one of them.
//
// The ports are deliberately narrow: they contain the methods services already
// call, in the signatures services already use, so adopting them is a type
// assertion rather than a rewrite. Anything a service does not need stays off
// the port even when SQLite happens to implement it.
//
// # Tenancy
//
// Port signatures carry no tenant arguments. In local mode there is no tenant;
// in cloud mode the tenant rides on the context (see Tenant and WithTenant) and
// the PostgreSQL store projects it onto the PostgreSQL session variables that
// row-level security reads. A missing tenant is an error in cloud mode, never a
// silently unscoped query.
//
// # Conformance
//
// internal/storage/conformance holds the one behavioural test suite both
// implementations must pass. New port methods belong in that suite before they
// gain a second implementation.
package storageports
