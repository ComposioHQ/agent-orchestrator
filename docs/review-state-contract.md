# Review approval display contract

AO keeps the review UI and the Kanban board focused on direct review facts. It does not introduce a frontend presentation model that combines review approval with CI, mergeability, pull-request lifecycle, comment delivery, or review-cycle history.

## Source of truth

The daemon exposes the same review outcome through two purpose-specific responses:

| Consumer | Source | Display |
| --- | --- |
| Kanban card and lane | Derived `WorkspaceSession.status` | `approved`, `changes_requested`, or `review_pending` |
| AO Reviews view | `PRReviewState.status` and its runs | Per-PR approved, changes requested, running, failed, cancelled, or not run |

The Kanban board already consumes `WorkspaceSession.status`; it must not fetch every session's Reviews endpoint to recreate the same result. The Reviews view consumes the per-PR response because it needs reviewer and run detail that a board card does not.

## Consumers

- Kanban cards display **Approved**, **Changes requested**, or **Review pending** from the session status already used to place cards in lanes.
- The Reviews view continues to render the daemon's review and run facts directly, including operational states such as running, failed, and cancelled.
- No review-specific frontend abstraction sits between either consumer and its direct source.

## Deliberate omissions

CI, mergeability, pull-request lifecycle, unresolved comments, review cycles, reviewed commit, and injection delivery remain independent facts. A future screen that needs to combine them should define that presentation at the concrete consumer rather than extending this approval contract speculatively.
