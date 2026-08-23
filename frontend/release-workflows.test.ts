import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("desktop release workflows", () => {
  for (const workflow of ["build-artifacts.yml", "frontend-release.yml"]) {
    it(`${workflow} requires the AO Cloud endpoint and Google client ID`, async () => {
      const contents = await readFile(
        path.join(repositoryRoot, ".github", "workflows", workflow),
        "utf8",
      );

      expect(contents).toContain(
        "VITE_AO_CLOUD_API_URL: ${{ vars.VITE_AO_CLOUD_API_URL }}",
      );
      expect(contents).toContain(
        "VITE_AO_CLOUD_GOOGLE_CLIENT_ID: ${{ vars.VITE_AO_CLOUD_GOOGLE_CLIENT_ID }}",
      );
      expect(contents).toContain(
        "Repository variables VITE_AO_CLOUD_API_URL and VITE_AO_CLOUD_GOOGLE_CLIENT_ID are required",
      );
    });
  }
});
