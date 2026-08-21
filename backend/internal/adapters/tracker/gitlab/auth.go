package gitlab

import (
	scmgitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/gitlab"
)

// ErrNoToken re-exports the SCM provider's canonical sentinel so the
// tracker and SCM adapter share one error identity. Callers that need to
// distinguish "no token" from other failures should use
// errors.Is(err, scmgitlab.ErrNoToken) regardless of whether the failure
// originated in the tracker or the SCM provider.
var ErrNoToken = scmgitlab.ErrNoToken

// DefaultTokenSource returns the default credential chain used by the tracker
// for gitlab.com: AO_GITLAB_TOKEN → GITLAB_TOKEN → glab scoped to gitlab.com.
// This mirrors the SCM provider's chain so both adapters honor the same
// precedence.
//
// Self-managed hosts are not covered here: they get their own chain from
// scmgitlab.HostTokenSource, wired per host by the daemon.
func DefaultTokenSource() scmgitlab.TokenSource {
	return scmgitlab.DotComTokenSource()
}
