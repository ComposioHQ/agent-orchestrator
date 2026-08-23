// Package ticket mints and verifies the one-time credentials that authorize a
// single connection to a sandbox's published listener.
//
// The problem it solves is narrow and specific. A hosted terminal pane does not
// travel through the control plane: the desktop dials the sandbox's own
// published /mux directly (see the /mux classification in
// internal/httpd/routescope.go). Something therefore has to authorize that dial
// at the sandbox, and it cannot be the sandbox capability from
// internal/cloud/capability — that credential is long-lived, it authorizes
// control-plane operations, and handing a copy to every client that wants a
// terminal would turn a UI affordance into a durable compute credential.
//
// A ticket is the opposite of a capability in every property that matters here:
//
//   - It is SHORT-LIVED. Seconds to a couple of minutes, enforced twice — the
//     issuer sets the expiry and the verifier independently refuses any ticket
//     whose claimed lifetime exceeds MaxTTL, so a control-plane bug cannot mint
//     a ticket that outlives the tab it was made for.
//   - It is SINGLE-USE. Verify consumes the ticket id; a second presentation is
//     rejected as a replay even while the ticket is otherwise still valid. A
//     ticket captured from a URL, a proxy log, or a screen share buys the
//     captor nothing once the legitimate client has connected.
//   - It is BOUND to one sandbox placement. The session id (and, when the
//     verifier is configured with one, the runtime id) is inside the MAC, so a
//     ticket for another tenant's sandbox does not verify here even though both
//     sandboxes run the same binary.
//
// Verification is OFFLINE. The sandbox holds a per-sandbox HMAC key delivered
// once at launch through the bootstrap environment, and checks the MAC itself
// rather than redeeming the ticket against the control plane. That is a
// deliberate availability decision: a terminal must keep attaching while the
// control plane is redeploying, and a redemption round-trip would put the
// control plane on the hot path of every pane open for no security gain — the
// MAC already proves the control plane minted it.
//
// The key is per-sandbox, never per-deployment. A leaked key forges tickets for
// exactly one sandbox, which is a sandbox whose own listener the leaker could
// already reach.
package ticket
