import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("desktop release workflows", () => {
  const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
  const artifactBuilder = path.join(workflowsDirectory, "build-artifacts.yml");

  it("removes the obsolete public desktop publisher", async () => {
    await expect(
      stat(path.join(workflowsDirectory, "frontend-release.yml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prevents a public desktop tag publisher from returning", async () => {
    const workflowNames = (await readdir(workflowsDirectory)).filter((name) =>
      /\.ya?ml$/.test(name),
    );
    const contents = await Promise.all(
      workflowNames.map((name) =>
        readFile(path.join(workflowsDirectory, name), "utf8"),
      ),
    );

    expect(contents.join("\n")).not.toContain("desktop-v*");
  });

  it("keeps the conductor artifact builder dispatchable and read-only", async () => {
    const contents = await readFile(artifactBuilder, "utf8");

    expect(contents).toContain("workflow_dispatch:");
    expect(contents).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(contents).not.toContain("contents: write");
    expect(contents).not.toContain("${{ secrets.");
    expect(contents).not.toMatch(
      /(?:gh release|electron-forge publish|npm run publish)/,
    );
  });

  it("requires the WorkOS client ID for unsigned artifacts", async () => {
    const contents = await readFile(artifactBuilder, "utf8");

    expect(contents).toContain(
      "VITE_WORKOS_CLIENT_ID: ${{ vars.VITE_WORKOS_CLIENT_ID }}",
    );
    expect(contents).toContain(
      "Repository variable VITE_WORKOS_CLIENT_ID is required",
    );
  });
});
