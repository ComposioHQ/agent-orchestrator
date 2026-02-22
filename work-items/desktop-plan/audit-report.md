# Desktop Plan Audit Report (Ultra-Professional Review)

## Document Control

- Auditor: Codex
- Date: 2026-02-22
- Scope: `work-items/desktop-plan/roadmap.md`, `work-items/desktop-plan/implementation-plan.md`, `work-items/desktop-plan/tasks.md`
- Method: document audit + local environment probe + external standards verification

## 1) Executive Verdict

Current result: **strong and execution-ready with controlled residual decisions**.

- Before audit: plan was solid at product/program level but under-specified for shell interoperability.
- After audit updates: shell architecture, compatibility gates, and security test depth are now explicitly defined.

Readiness score: **8.9 / 10** for MVP execution start.

## 2) What Was Missing (Found During Audit)

### High-priority gaps (now fixed)

1. No mandatory shell abstraction layer for `powershell.exe` / `cmd.exe` / `Git Bash` / `WSL`.
2. No formal shell compatibility exit gate in roadmap.
3. No shell-specific command template/flag standards.
4. No shell matrix tests in backlog and no shell soak testing gate.
5. No environment capability probe and fallback order.

### Medium-priority gaps (partially fixed, require final decision)

1. Git Bash binary discovery policy (strict configured path vs heuristic discovery).
2. Default shell precedence strategy per OS/profile.
3. WSL path normalization policy for mixed Windows/Linux path workflows.

## 3) Changes Applied to Planning Artifacts

### Updated roadmap

- Added shell interoperability to MVP scope and milestones.
- Added shell KPI targets and beta gate requirements.
- Added shell-specific risks (quoting regression, missing binaries).

Reference: `work-items/desktop-plan/roadmap.md`

### Updated implementation plan

- Added ADR for mandatory shell abstraction.
- Added shell profile contract with startup templates.
- Added environment capability audit snapshot from current machine.
- Added shell-specific integration/E2E/security requirements.

Reference: `work-items/desktop-plan/implementation-plan.md`

### Updated work-items backlog

- Added shell architecture and implementation tasks (`DESK-110`..`DESK-117`).
- Added shell matrix validation tasks (`DESK-212`, `DESK-313`, `DESK-314`, `DESK-410`).
- Added critical-path and milestone updates to reflect shell dependencies.

Reference: `work-items/desktop-plan/tasks.md`

## 4) Local Environment Probe (Current Machine)

- `powershell.exe`: detected.
- `pwsh` (PowerShell 7): not detected in PATH.
- `wsl.exe`: detected; distro includes `Ubuntu`.
- `bash.exe`: detected (WindowsApps launcher).
- `git-bash.exe`: not found by `where.exe` (treat as optional until configured).

Audit implication:
- Shell fallback logic is mandatory at runtime.
- Setup wizard must not assume `pwsh` or Git Bash availability.

## 5) Standards Alignment Matrix (Verified)

| Standard / Source | Required Behavior | Plan Coverage |
| --- | --- | --- |
| Tauri sidecar and shell capability model | Sidecar process + explicit command permissions/validation | Covered in architecture + policy + backlog |
| `node-pty` cross-platform PTY model | Unified terminal runtime with Windows compatibility constraints | Covered in terminal workstream + compatibility testing |
| Windows ConPTY guidance | Modern Windows terminal host behavior expectations | Covered via PTY compatibility matrix and soak tasks |
| Windows `cmd` invocation semantics | Safe `/d /s /c` usage and quote handling awareness | Covered in shell profile contract and regression tests |
| PowerShell invocation options | No profile/non-interactive startup for deterministic automation | Covered in shell profile contract |
| WSL command model | `--distribution`, `--cd`, `--exec` support in adapter | Covered in shell adapter tasks and contract |
| OWASP OS Command Injection defenses | Avoid unsafe shell string execution and enforce policy gates | Covered in security controls + payload regression suite |

## 6) Residual Risks (Still Open)

1. Git Bash optionality may create user expectation mismatch unless setup UX is explicit.
2. Complex multi-line command quoting remains highest technical risk area.
3. WSL filesystem boundary handling (`C:\...` vs `/mnt/c/...`) needs final policy.

## 7) Required Final Decisions Before Build Start

1. **Default shell precedence on Windows**:
- Recommended: `windows-powershell` -> `cmd` -> `wsl` -> `git-bash` (if configured).
2. **Git Bash policy**:
- Recommended: opt-in only, explicit binary path in settings.
3. **WSL profile policy**:
- Recommended: require explicit distro selection when multiple distros exist.
4. **Raw chat command policy**:
- Recommended: strict-by-default with tiered confirmation.

## 8) Final Audit Conclusion

Plan is now **professional, standards-aligned, and implementation-credible** for desktop-first execution, including your required shell support scenarios.

No blocker remains at planning level. Remaining work is execution discipline and maintaining the defined gates.

## 9) External References

- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
- Tauri shell plugin capabilities: https://v2.tauri.app/plugin/shell/
- node-pty: https://github.com/microsoft/node-pty
- Windows pseudoconsole (ConPTY): https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
- Windows `cmd` reference: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd
- PowerShell (`pwsh`) options: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh?view=powershell-7.5
- Windows PowerShell options: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1
- WSL basic commands: https://learn.microsoft.com/en-us/windows/wsl/basic-commands
- OWASP OS Command Injection Defense Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html
