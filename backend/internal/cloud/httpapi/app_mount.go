package httpapi

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// appPathPrefix is the path space the shared application API owns. It is the
// daemon's own prefix on purpose: a hosted client and a desktop client speak
// the identical API, so nothing above the transport has to know which one it
// is talking to.
const appPathPrefix = "/api/v1"

// orgHeader selects which organization a request acts on, for a principal who
// belongs to more than one. It carries either the organization id or its slug.
const orgHeader = "X-AO-Org"

// appHandler wraps the shared application API in the control plane's
// authentication and tenant resolution.
//
// Order matters and is the whole point of this file: authenticate, resolve the
// tenant, and only then let the request reach a controller. Every store the
// application API was composed with reads its organization scope back out of
// the request context (see internal/tenant), so a request that got this far
// without a tenant identity cannot silently run an unscoped query — the stores
// fail it with ErrNoTenant.
func (s *Server) appHandler() http.Handler {
	if s.app == nil {
		return nil
	}
	return middleware.RequestID(s.requirePrincipal(s.requireTenant(s.app)))
}

// requireTenant resolves the organization a request acts on and puts it, with
// the authenticated user, on the request context.
//
// Memberships are read from the store on every request rather than taken from
// the access token: a revoked membership must stop working immediately, not at
// the next token refresh. A principal who belongs to exactly one organization
// needs no header; one who belongs to several must name the organization,
// because guessing would silently write a session into the wrong tenant. A
// named organization the principal does not belong to is refused — that is the
// cross-tenant case, and it is a 403, not a 404, because the caller is
// authenticated and the answer does not depend on whether the org exists.
func (s *Server) requireTenant(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := principalFromContext(r.Context())
		if !ok {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
			return
		}
		memberships, err := s.store.ListMemberships(r.Context(), principal)
		if err != nil {
			s.internalError(w, r, "list memberships", err)
			return
		}
		if len(memberships) == 0 {
			writeError(w, r, http.StatusForbidden, "forbidden", "NO_ORG_MEMBERSHIP",
				"this account belongs to no organization")
			return
		}

		requested := strings.TrimSpace(r.Header.Get(orgHeader))
		membership, failure := selectMembership(memberships, requested)
		if failure != nil {
			writeError(w, r, failure.status, failure.kind, failure.code, failure.message)
			return
		}

		identity := tenant.Identity{
			OrgID:   membership.OrgID,
			OrgSlug: membership.OrgSlug,
			UserID:  principal.UserID,
			Role:    membership.Role,
		}
		ctx := tenant.WithIdentity(r.Context(), identity)
		if _, resolved := tenant.FromContext(ctx); !resolved {
			// Only reachable if the store returned a membership with a blank
			// org id, which would otherwise hand the stores an unscoped
			// context. Fail the request instead.
			s.logger.Error("tenant identity incomplete", "request_id", requestID(r), "user_id", principal.UserID)
			writeError(w, r, http.StatusInternalServerError, "internal_error", "INTERNAL_ERROR", "internal server error")
			return
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// tenantFailure is a resolution outcome that must be reported to the caller.
type tenantFailure struct {
	status  int
	kind    string
	code    string
	message string
}

// selectMembership picks the organization a request acts on. requested may be
// an organization id or slug; empty means "use my only organization".
func selectMembership(memberships []domain.Membership, requested string) (domain.Membership, *tenantFailure) {
	if requested == "" {
		if len(memberships) != 1 {
			return domain.Membership{}, &tenantFailure{
				status:  http.StatusBadRequest,
				kind:    "bad_request",
				code:    "ORG_REQUIRED",
				message: "this account belongs to multiple organizations; set the " + orgHeader + " header",
			}
		}
		return memberships[0], nil
	}
	for _, membership := range memberships {
		if membership.OrgID == requested || strings.EqualFold(membership.OrgSlug, requested) {
			return membership, nil
		}
	}
	return domain.Membership{}, &tenantFailure{
		status:  http.StatusForbidden,
		kind:    "forbidden",
		code:    "ORG_FORBIDDEN",
		message: "this account is not a member of the requested organization",
	}
}

// isAppPath reports whether a request belongs to the shared application API.
func isAppPath(path string) bool {
	return path == appPathPrefix || strings.HasPrefix(path, appPathPrefix+"/")
}
