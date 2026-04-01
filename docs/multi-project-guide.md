# Multi-Project Guide

AO now supports a global multi-project portfolio.

This means:

- your projects are tracked centrally in `~/.agent-orchestrator/config.yaml`
- each repo can still keep its own `agent-orchestrator.yaml` for repo-specific behavior
- the dashboard, sidebar, project pages, and remote CLI workflows all use the same shared project registry

## For Existing Users

If you already use AO, the good news is that you usually do not need to manually migrate anything.

Your repo joins the new multi-project setup the first time you use it after upgrading:

- run `ao start` inside the repo
- or open the repo from the dashboard with `Open Project`

AO will then:

- detect your existing config
- migrate older config automatically when possible
- register the repo in the global portfolio
- start the main orchestrator

### Existing Repo Flow

From inside an existing repo:

```bash
ao start
```

After that:

- the repo appears in the dashboard
- the repo appears in the sidebar
- you can target it remotely with `ao spawn --project <project-id>`
- you can see it in portfolio-wide status views

### If You Prefer the Dashboard

Open the dashboard and choose `Open Project`.

AO will:

- inspect the selected repo
- migrate older config automatically if needed
- register the project in the global portfolio
- open the project page
- start the main orchestrator

### Legacy Configs

If your repo still uses an older AO config format, AO will try to migrate it automatically on first use.

If the old config is ambiguous, AO will stop and show you exactly what needs to be fixed. In normal cases, no manual config rewrite is needed.

### Important Note

Existing repos do not all appear in the portfolio automatically on upgrade day.

A repo gets added to the new portfolio when you first use it after upgrading:

- by running `ao start`
- or by opening it in the dashboard

This keeps migration gradual and low-risk.

## For New Users

If you are starting fresh, the multi-project model is the default way to use AO.

The intended flow is:

1. Add or open a project
2. AO registers it in your global portfolio
3. AO starts the main orchestrator
4. Use the dashboard, sidebar, and CLI across all your projects

### Ways to Add a Project

You can start with:

- an existing git repo
- a local repo without a remote
- an empty folder

AO can handle all three.

### What Happens When You Add a Project

AO will:

- make sure the project has a usable local `agent-orchestrator.yaml`
- register the project in `~/.agent-orchestrator/config.yaml`
- open the project page
- ensure the main orchestrator is running

If the folder is empty, AO can initialize it for you and treat it as a local-only project.

## Day-to-Day Usage

Once a project has been registered, you can:

- open it from the dashboard portfolio
- switch to it from the sidebar
- spawn work remotely with `ao spawn --project <project-id>`
- inspect portfolio-wide status with `ao status --portfolio`
- manage projects with `ao project ...`

## Mental Model

Think about AO like this:

- global config: project identity and portfolio membership
- local repo config: repo-specific behavior
- dashboard and CLI: two interfaces over the same shared project registry

## Where Things Live

Global portfolio registry:

- `~/.agent-orchestrator/config.yaml`

Per-repo config:

- `<repo>/agent-orchestrator.yaml`

## In Short

For existing users:

- use AO normally
- the repo will be added to the global portfolio on first use

For new users:

- add a project once
- AO registers it and starts the main orchestrator
- use it everywhere from the dashboard or CLI
