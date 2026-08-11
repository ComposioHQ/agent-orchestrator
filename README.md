<div align="center">
  <img src="assets/ao-logo.svg" alt="Agent Orchestrator" width="144" height="144" />

# Agent Orchestrator

### The orchestration layer for parallel AI coding agents

[![GitHub stars](https://img.shields.io/github/stars/Untrivial-ai/agent-orchestrator?style=flat&logo=github)](https://github.com/Untrivial-ai/agent-orchestrator/stargazers)
[![GitHub rank](https://img.shields.io/badge/GitHub%20rank-Top%206k%20by%20stars-181717?style=flat&logo=github)](https://github.com/search?q=stars%3A%3E9365&type=repositories)
[![GitHub release](https://img.shields.io/github/v/release/Untrivial-ai/agent-orchestrator?style=flat&logo=github)](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest)
[![GitHub downloads](https://img.shields.io/github/downloads/Untrivial-ai/agent-orchestrator/total?style=flat&logo=github)](https://github.com/Untrivial-ai/agent-orchestrator/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat)](LICENSE)
[![X](https://img.shields.io/badge/@aoagents-555?style=flat&logo=x&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-555?style=flat&logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)

Run Claude Code, Codex, Cursor, opencode, and other coding agents in parallel.<br />
Git-backed sessions get isolated worktrees; Scratch sessions get AO-managed branchless directories.<br />
Every session gets a live interface and its own feedback loop.

[**Download AO**](#install) &nbsp;&bull;&nbsp; [Documentation](https://aoagents.dev/docs) &nbsp;&bull;&nbsp; [Releases](https://github.com/Untrivial-ai/agent-orchestrator/releases) &nbsp;&bull;&nbsp; [Contributing](CONTRIBUTING.md) &nbsp;&bull;&nbsp; [Discord](https://discord.com/invite/UZv7JjxbwG)

**English** · [简体中文](translations/README.zh-CN.md) · [日本語](translations/README.ja.md) · [한국어](translations/README.ko.md) · [Español](translations/README.es.md) · [Français](translations/README.fr.md) · [Deutsch](translations/README.de.md) · [Português (Brasil)](translations/README.pt-BR.md)

<br />

<img src="docs/assets/readme/dashboard.png" alt="Agent Orchestrator dashboard showing parallel coding agent sessions" width="100%" />
</div>

## Run more agents without managing more terminals

Agent Orchestrator is a local agent IDE for running AI coding agents in parallel. For Git-backed sessions, it brings an isolated worktree, branch, and pull request together with the Chat or terminal interface, browser preview, and feedback state in one supervisor. Scratch sessions use AO-managed branchless directories without pull request operations.

The agents still do the coding. AO provides the control layer around them:

- **Work in parallel without collisions** — Git-backed sessions get their own branch and worktree; every session gets its own terminal
- **See what needs attention** — track which agents are working, waiting, finished, or blocked
- **Close the feedback loop** — route CI failures, review comments, and merge conflicts back to the right session
- **Use the right agent for each task** — supervise different agent CLIs from one desktop app

Instead of coordinating a pile of agent terminals by hand, you get one visible, managed workflow.

## Features

<table>
  <tr>
    <td width="36%" valign="middle">
      <h3>Parallel agent sessions</h3>
      <p>Start multiple coding agents from the same project without mixing files, branches, terminals, or pull request state.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="Agent Orchestrator board with multiple parallel sessions" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="36%" valign="middle">
      <h3>Chat and terminal control</h3>
      <p>Use a structured Chat controller or attach to the agent's native terminal UI while keeping session and pull request state in view.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Session terminal inside Agent Orchestrator" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="36%" valign="middle">
      <h3>Review feedback loops</h3>
      <p>Run reviewer agents, inspect review status, and route requested changes back to the worker that owns them.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="Session summary showing pull request and reviewer status" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="36%" valign="middle">
      <h3>In-app browser preview</h3>
      <p>Preview a session's local app beside its interface so UI work, browser state, and agent output stay together.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="Browser preview tab showing a local app preview" width="100%" />
    </td>
  </tr>
</table>

## How AO works

1. Add a project and start one or more agent sessions from the desktop app or CLI.
2. AO creates an isolated worktree for each Git-backed session, or an AO-managed branchless directory for Scratch, then launches the selected Chat or terminal interface.
3. The local daemon watches controller activity, pull requests, CI, review feedback, and merge conflicts.
4. The app and CLI keep every session visible and let you send follow-up instructions to the right agent.

AO stays local and supervisory: your coding agents keep doing the implementation while AO organizes their workspaces, state, interfaces, and feedback.

## Supported agents

**26 coding agents supported** through one supervised workflow.

<table>
  <tr>
    <td align="center" width="25%"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="Claude Code" height="28" /><br /><sub><b>Claude Code</b></sub></td>
    <td align="center" width="25%"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="Codex" height="28" /><br /><sub><b>Codex</b></sub></td>
    <td align="center" width="25%"><img src="frontend/src/renderer/assets/agents/cursor.svg" alt="Cursor" height="28" /><br /><sub><b>Cursor</b></sub></td>
    <td align="center" width="25%"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="opencode" height="28" /><br /><sub><b>opencode</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="frontend/src/renderer/assets/agents/aider.png" alt="Aider" height="28" /><br /><sub><b>Aider</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/copilot.svg" alt="GitHub Copilot" height="28" /><br /><sub><b>GitHub Copilot</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/grok.png" alt="Grok" height="28" /><br /><sub><b>Grok</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/kimi.png" alt="Kimi" height="28" /><br /><sub><b>Kimi</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="frontend/src/renderer/assets/agents/pi.png" alt="Pi" height="28" /><br /><sub><b>Pi</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/amp.svg" alt="Amp" height="28" /><br /><sub><b>Amp</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/auggie.svg" alt="Auggie" height="28" /><br /><sub><b>Auggie</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/droid.png" alt="Droid" height="28" /><br /><sub><b>Droid</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="frontend/src/renderer/assets/agents/crush.png" alt="Crush" height="28" /><br /><sub><b>Crush</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/cline.svg" alt="Cline" height="28" /><br /><sub><b>Cline</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/goose.svg" alt="Goose" height="28" /><br /><sub><b>Goose</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/qwen.png" alt="Qwen" height="28" /><br /><sub><b>Qwen</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="frontend/src/renderer/assets/agents/continue.png" alt="Continue" height="28" /><br /><sub><b>Continue</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/devin.png" alt="Devin" height="28" /><br /><sub><b>Devin</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/kiro.png" alt="Kiro" height="28" /><br /><sub><b>Kiro</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/kilocode.svg" alt="Kilo Code" height="28" /><br /><sub><b>Kilo Code</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="frontend/src/renderer/assets/agents/vibe.png" alt="Vibe" height="28" /><br /><sub><b>Vibe</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/muse.png" alt="Muse" height="28" /><br /><sub><b>Muse</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/agy.png" alt="Agy" height="28" /><br /><sub><b>Agy</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/autohand.svg" alt="Autohand" height="28" /><br /><sub><b>Autohand</b></sub></td>
  </tr>
  <tr>
    <td></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/kimchi.svg" alt="Kimchi" height="28" /><br /><sub><b>Kimchi</b></sub></td>
    <td align="center"><img src="frontend/src/renderer/assets/agents/prime-agent.png" alt="Prime Agent" height="28" /><br /><sub><b>Prime Agent</b></sub></td>
    <td></td>
  </tr>
</table>

[Browse agent setup guides →](https://aoagents.dev/docs/plugins/agents)

**Use the interface that fits the moment: structured Chat or the agent's native terminal UI.**

## Install

Download the latest desktop build for your platform. The desktop app is the recommended, auto-updating install path.

| Platform              | Download                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple silicon) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.dmg)   |
| macOS (Intel)         | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.dmg)     |
| Windows               | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux (AppImage)      | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |
| Linux (Debian/Ubuntu) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb)      |
| Linux (Fedora/RHEL)   | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.rpm)      |

Open Agent Orchestrator and point it at the repository you want AO to manage. The desktop app runs the daemon for you, so no CLI is required. See the [installation guide](https://aoagents.dev/docs/installation) for agent CLI setup and troubleshooting.

<details>
<summary>Install via npm (legacy CLI, no longer recommended)</summary>

`0.10.0` was the final version published to npm. The frozen `@aoagents/ao` package remains available for existing users who already have `ao` on their `PATH`; `ao start` fetches and opens the desktop build. For new setups, use the desktop download above.

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## Develop and contribute

Contributions are welcome across code, docs, triage, examples, and tests.

```bash
git clone https://github.com/Untrivial-ai/agent-orchestrator.git
cd agent-orchestrator
```

Start with the [development guide](docs/development.md) for prerequisites, local setup, and test commands. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and use [GitHub Issues](https://github.com/Untrivial-ai/agent-orchestrator/issues) for bugs and feature requests.

## Documentation

| Document                                                         | Start here when you need                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Product documentation](https://aoagents.dev/docs)               | Installation, agent setup, and day-to-day product usage.                                     |
| [docs/architecture.md](docs/architecture.md)                     | Backend mental model, lifecycle, persistence, CDC, status derivation, and daemon boundaries. |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | Package ownership and where each backend concern belongs.                                    |
| [docs/cli/README.md](docs/cli/README.md)                         | CLI behavior and daemon route mapping.                                                       |
| [docs/development.md](docs/development.md)                       | Prerequisites, build steps, running tests, and troubleshooting for local development.        |
| [docs/STATUS.md](docs/STATUS.md)                                 | What currently ships on `main` and what remains in flight.                                   |

## Follow the journey

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="assets/tweet2.png" height="330" alt="Agent Orchestrator journey update on X" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="assets/tweet1.png" height="330" alt="Agent Orchestrator journey update on X" />
      </a>
    </td>
  </tr>
</table>

## Community

Join [Discord](https://discord.com/invite/UZv7JjxbwG) for help and contributor discussion, follow [@aoagents](https://x.com/aoagents) for updates, or start a conversation in [GitHub Issues](https://github.com/Untrivial-ai/agent-orchestrator/issues).

## Anonymous telemetry

AO uses privacy-preserving product usage and reliability metrics—designed to exclude PII and project content—to understand adoption and improve the product. [Learn more about telemetry and privacy](docs/telemetry.md).

## License

Agent Orchestrator is available under the [Apache License 2.0](LICENSE).
