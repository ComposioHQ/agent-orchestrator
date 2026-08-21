import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("desktop release workflows", () => {
  for (const workflow of ["build-artifacts.yml", "frontend-release.yml"]) {
    it(`${workflow} requires the WorkOS client ID`, async () => {
      const contents = await readFile(
        path.join(repositoryRoot, ".github", "workflows", workflow),
        "utf8",
      );

      expect(contents).toContain(
        "VITE_WORKOS_CLIENT_ID: ${{ vars.VITE_WORKOS_CLIENT_ID }}",
      );
      expect(contents).toContain(
        "Repository variable VITE_WORKOS_CLIENT_ID is required",
      );
    });
  }
});
