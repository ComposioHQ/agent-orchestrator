# Cloud execution readiness

This checklist is the release gate for Cloud sandbox execution. A checked item
must have an automated test or a recorded live verification; implementation
alone is not sufficient.

## Provisioning and lifecycle

- [x] CreateOS responses are decoded through their JSend envelope and list
  pagination follows the provider's offset/limit contract.
- [ ] Reconciliation remains single-owner while a slow provider operation runs,
  including across multiple control-plane replicas.
- [ ] Repair and recreation launch the replacement worker with the newly issued,
  one-time bootstrap ticket.
- [ ] Session deletion retains durable session/event history and releases quota
  only after provider deletion is observed.
- [ ] Concurrent session creation cannot exceed the organization sandbox quota.
- [ ] Provider auto-pause is disabled. Heartbeats record liveness only.
- [ ] Local Docker and hosted NodeOps use the same provider lifecycle contract.

## Worker and execution

- [ ] The control-plane and worker artifacts both contain the `ao-worker`
  binary expected by their startup configuration.
- [ ] A local session creates one least-privilege worker container and one
  persistent workspace, and teardown leaves neither compute nor orphan state.
- [ ] Queued turns are fenced to the current worker epoch and can be recovered
  after worker replacement without duplicate completion.
- [ ] Claude Code, Codex, and Cursor launch through the shared public runtime,
  with deterministic fake-binary tests for launch, output, cancellation, and
  failure.
- [ ] Only the selected harness credential is delivered to the current worker;
  plaintext credentials are not logged, stored in events, or returned with
  cacheable headers.
- [ ] Session modes and denied-command policy fail closed for each supported
  harness.

## Source control and orchestration

- [ ] GitHub checkout credentials are bound to the worker's organization,
  project, repository grant, environment, and current epoch.
- [ ] Clone/fetch uses an askpass-style helper; tokens never enter URLs, argv,
  git configuration, logs, or durable events.
- [ ] Repository identity is checked before an existing workspace is reused.
- [ ] Orchestrators can list/spawn/message only sessions in the same
  organization and project.

## API, UI, and operations

- [ ] Public OpenAPI and `@aoagents/cloud-client` artifacts describe the worker,
  cancellation, SCM, terminal, and workspace operations used by Cloud.
- [x] Execution controls are enabled only when the API advertises a working
  execution capability.
- [ ] CI runs non-superuser PostgreSQL lifecycle tests, Docker lifecycle E2E,
  fake harness tests, policy/security tests, image builds, and contract drift
  checks.
- [ ] Deployment builds and digest-pins separate control-plane and worker
  artifacts and validates every required secret before changing ECS.
- [ ] Local acceptance passes from registration through repository checkout,
  first and follow-up turns, cancellation, restart recovery, and teardown.
- [ ] Hosted NodeOps acceptance passes against the live provider.

The final item may remain unchecked only when NodeOps credentials are
unavailable. In that case the provider conformance suite, deployment
configuration, and all local acceptance checks remain mandatory.
