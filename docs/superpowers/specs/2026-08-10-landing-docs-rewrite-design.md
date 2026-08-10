# Landing Documentation Rewrite Design

## Goal

Replace the landing documentation's retired TypeScript, Next.js, YAML, and plugin-marketplace model with an accurate description of the current desktop-first AO product.

## Information architecture

The docs navigation is organized around user intent:

1. Getting started: overview, installation, quickstart, platforms.
2. Using AO: desktop workspace, Chat and Terminal UI sessions, reviews, browser preview, notifications, and mobile pairing.
3. Guides: parallel work, roles, CI/review loops, multi-project use, and interface switching.
4. Reference: optional Cobra CLI, project settings, architecture, troubleshooting, migration, and changelog.
5. Built-in capabilities: supported agent harnesses, GitHub integration, worktrees, terminal runtimes, and notification surfaces.

Unsupported GitLab/Linear runtime claims, external notifier plugins, plugin authoring/install commands, selectable runtime/workspace plugins, public dashboard hosting, legacy Next.js ports, and current-use YAML examples are removed.

## Sources of truth

- `README.md` for distribution, public product behavior, privacy, and license.
- `docs/STATUS.md` for shipped versus in-flight capabilities.
- `docs/architecture.md` and ADRs for daemon, storage, lifecycle, interfaces, browser, and LAN security boundaries.
- `docs/cli/README.md` plus `backend/internal/cli/` for the exact command surface.
- `backend/internal/domain/projectconfig.go` and controllers for project configuration.
- Current Electron/mobile source for visible labels and flows when canonical prose is absent.

## Content rules

- Desktop app is the canonical install; npm `0.10.0` is a frozen legacy bridge.
- The Electron app owns the loopback Go daemon. All state is under `~/.ao`.
- User-facing sessions are Chat or Terminal UI. Chat support and interface-switch limitations are explicit.
- GitHub SCM behavior is documented as shipped. Tracker mirroring and unsupported integrations are not advertised.
- The primary daemon listener remains unauthenticated loopback-only. Connect Mobile is the only documented off-device path and uses the opt-in authenticated LAN listener.
- Commands and flags must match Cobra source exactly.
- Destructive cleanup instructions include explicit data-loss warnings.

## Verification

- Read every retained MDX page after edits.
- Search for banned stale concepts and inspect every remaining match.
- Validate navigation metadata and internal `/docs/` links against retained files.
- Run landing/frontend typecheck and build checks appropriate to MDX changes.
