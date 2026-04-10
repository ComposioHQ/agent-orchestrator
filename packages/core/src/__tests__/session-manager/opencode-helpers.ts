import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function installMockOpencode(
  tmpDir: string,
  sessionListJson: string,
  deleteLogPath: string,
  listDelaySeconds = 0,
  listLogPath?: string,
): string {
  const binDir = join(tmpDir, "mock-bin");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "opencode");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "$1" == "session" && "$2" == "list" ]]; then',
      listLogPath ? `  printf '%s\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'` : "",
      listDelaySeconds > 0 ? `  sleep ${listDelaySeconds}` : "",
      `  printf '%s\n' '${sessionListJson.replace(/'/g, "'\\''")}'`,
      "  exit 0",
      "fi",
      'if [[ "$1" == "session" && "$2" == "delete" ]]; then',
      `  printf '%s\n' "$*" >> '${deleteLogPath.replace(/'/g, "'\\''")}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(scriptPath, 0o755);
  return binDir;
}

export function installMockOpencodeSequence(
  tmpDir: string,
  sessionListJsons: string[],
  deleteLogPath: string,
  listLogPath?: string,
): string {
  const binDir = join(tmpDir, "mock-bin-sequence");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "opencode");
  const sequencePath = join(tmpDir, `opencode-sequence-${randomUUID()}.txt`);
  writeFileSync(sequencePath, "0\n", "utf-8");

  const cases = sessionListJsons
    .map((entry, index) => {
      const escaped = entry.replace(/'/g, "'\\''");
      return `if [[ "$idx" == "${index}" ]]; then printf '%s\\n' '${escaped}'; exit 0; fi`;
    })
    .join("\n");
  const final = sessionListJsons.at(-1)?.replace(/'/g, "'\\''") ?? "[]";

  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "$1" == "session" && "$2" == "list" ]]; then',
      listLogPath ? `  printf '%s\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'` : "",
      `  seq_file='${sequencePath.replace(/'/g, "'\\''")}'`,
      '  idx=$(cat "$seq_file")',
      "  next=$((idx + 1))",
      '  printf "%s\n" "$next" > "$seq_file"',
      `  ${cases}`,
      `  printf '%s\\n' '${final}'`,
      "  exit 0",
      "fi",
      'if [[ "$1" == "session" && "$2" == "delete" ]]; then',
      `  printf '%s\n' "$*" >> '${deleteLogPath.replace(/'/g, "'\\''")}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ]
      .filter(Boolean)
      .join("\n"),
    "utf-8",
  );
  chmodSync(scriptPath, 0o755);
  return binDir;
}

export function installMockOpencodeWithNotFoundDelete(
  tmpDir: string,
  sessionListJson: string,
): string {
  const binDir = join(tmpDir, "mock-bin-not-found");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "opencode");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "$1" == "session" && "$2" == "list" ]]; then',
      `  printf '%s\n' '${sessionListJson.replace(/'/g, "'\\''")}'`,
      "  exit 0",
      "fi",
      'if [[ "$1" == "session" && "$2" == "delete" ]]; then',
      '  printf "Error: Session not found: %s\\n" "$3" >&2',
      "  exit 1",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(scriptPath, 0o755);
  return binDir;
}

export function installMockGit(
  tmpDir: string,
  remoteBranches: string[],
): string {
  const binDir = join(tmpDir, "mock-git-bin");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "git");
  const refs = remoteBranches
    .map((branch) => `deadbeef\trefs/heads/${branch}`)
    .join("\\n")
    .replace(/'/g, "'\\''");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "$1" == "ls-remote" && "$2" == "--heads" && "$3" == "origin" ]]; then',
      `  printf '%b\\n' '${refs}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(scriptPath, 0o755);
  return binDir;
}
