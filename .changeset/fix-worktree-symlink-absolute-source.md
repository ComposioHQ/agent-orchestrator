---
"@aoagents/ao-plugin-workspace-worktree": patch
---

Fix self-referential symlinks when `project.path` is relative. The postCreate hook built `sourcePath` with `join(repoPath, symlinkPath)`, so a relative `project.path` like `"."` produced a relative `sourcePath` such as `"node_modules"`. Symlinks resolve relative to the symlink's own directory, so `<worktree>/node_modules -> node_modules` loops back to itself and the next `pnpm install` fails with `ELOOP: too many symbolic links encountered`. Use `resolve()` so the source is always absolute.
