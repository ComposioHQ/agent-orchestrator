// Package scm implements the hosted control plane's SCM credential boundary.
//
// The boundary exists so tenant compute never holds a durable, broadly scoped
// SCM credential. Its rules:
//
//   - There is no shared operator token. Every credential handed to a sandbox
//     is minted from a GitHub App installation that the tenant organization
//     itself linked.
//   - A credential is scoped to one repository and one permission set, and it
//     expires on the provider's own installation-token clock (one hour).
//   - Repository access is default-deny. An installation may see a repository
//     without AO being allowed to clone or push it; an organization admin must
//     allowlist it first.
//   - Webhooks can only narrow access. They may suspend an installation or
//     drop a repository, never mark one allowed.
//   - Token material never reaches a log line, an error envelope, the database,
//     or a process argument vector.
//
// The app private key is loaded from Secrets Manager or the process
// environment by the caller and is never written back out.
package scm
