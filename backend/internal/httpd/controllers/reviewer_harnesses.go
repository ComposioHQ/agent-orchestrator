package controllers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

// ReviewerHarnessesController owns the /reviewer-harnesses route. It reuses
// AgentsController's inventory (the same Catalog dependency, injected the same
// way) rather than a standalone reviewer catalog: reviewer harnesses are agent
// harnesses that also appear in domain.AllReviewerHarnesses, so this filters
// the live Supported/Installed/Authorized probe results down to that set
// instead of returning static build-time ids with no readiness data.
type ReviewerHarnessesController struct {
	Catalog AgentCatalog
}

// Register mounts the reviewer harness catalog route on the supplied router.
func (c *ReviewerHarnessesController) Register(r chi.Router) {
	r.Get("/reviewer-harnesses", c.list)
}

func (c *ReviewerHarnessesController) list(w http.ResponseWriter, r *http.Request) {
	if c.Catalog == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/reviewer-harnesses")
		return
	}
	inventory, err := c.Catalog.List(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, filterReviewerInventory(inventory))
}

// filterReviewerInventory narrows an agent inventory to entries that are also
// valid reviewer harnesses, preserving the Supported/Installed/Authorized
// split so a reviewer picker gets the same readiness signal a worker picker
// does.
func filterReviewerInventory(in agentsvc.Inventory) agentsvc.Inventory {
	return agentsvc.Inventory{
		Supported:  filterReviewerInfos(in.Supported),
		Installed:  filterReviewerInfos(in.Installed),
		Authorized: filterReviewerInfos(in.Authorized),
	}
}

func filterReviewerInfos(in []agentsvc.Info) []agentsvc.Info {
	out := make([]agentsvc.Info, 0, len(in))
	for _, info := range in {
		if domain.ReviewerHarness(info.ID).IsKnown() {
			out = append(out, info)
		}
	}
	return out
}
