# Changelog

## Unreleased

- Added exact, parity-tested hosted `/api/v1` project discovery and session
  lifecycle DTOs, scoped by `X-AO-Org`.
- Aligned project placement create/delete/resume, canonical GitHub App SCM,
  worker, terminal metadata/ticket, sandbox redemption, and credential
  status/delete contracts with their implemented routes.
- Added runtime-neutral Cloud, worker, and sandbox client methods while
  preserving the shared error envelope and existing product DTO field names.
