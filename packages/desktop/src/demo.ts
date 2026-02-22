import { probeShellCapabilities, selectShellProfile } from "./index.js";

async function main(): Promise<void> {
  const capabilities = await probeShellCapabilities();
  for (const capability of capabilities) {
    const status = capability.available ? "available" : `missing (${capability.reason ?? "unknown"})`;
    console.log(`${capability.profile.id}: ${status}`);
  }

  const selected = await selectShellProfile();
  console.log(`selected profile: ${selected.profileId} -> ${selected.resolvedPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
