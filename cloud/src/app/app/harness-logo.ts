const harnessLogoNames: Readonly<Record<string, string>> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  cursor: "cursor",
};

export function harnessLogoSource(provider: string) {
  const logoName = harnessLogoNames[provider];
  return logoName ? `/agents/${logoName}.svg` : undefined;
}
