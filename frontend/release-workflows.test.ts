import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("desktop release workflows", () => {
  const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
  const artifactBuilder = path.join(workflowsDirectory, "build-artifacts.yml");

  async function readWorkflows() {
    const names = (await readdir(workflowsDirectory)).filter((name) =>
      /\.ya?ml$/.test(name),
    );
    return Promise.all(
      names.map(async (name) => ({
        name,
        contents: await readFile(path.join(workflowsDirectory, name), "utf8"),
      })),
    );
  }

  it("removes obsolete public release mutation workflows", async () => {
    for (const name of [
      "frontend-release.yml",
      "feature-release-cleanup.yml",
    ]) {
      await expect(
        stat(path.join(workflowsDirectory, name)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("prevents a public desktop tag publisher from returning", async () => {
    const workflows = await readWorkflows();

    expect(workflows.map(({ contents }) => contents).join("\n")).not.toContain(
      "desktop-v*",
    );
  });

  it("prevents public workflows from mutating releases or release tags", async () => {
    const workflows = await readWorkflows();
    const mutationPatterns = [
      /gh release (?:create|delete|edit|publish|upload)\b/,
      /gh api(?=[^\n]*(?:releases|git\/refs\/tags))(?=[^\n]*(?:(?:--method|-X)\s+(?:DELETE|PATCH|POST|PUT)))[^\n]*/,
      /curl(?=[^\n]*(?:releases|git\/refs\/tags))(?=[^\n]*(?:(?:--request|-X)\s*(?:DELETE|PATCH|POST|PUT)))[^\n]*/,
      /github\.rest\.repos\.(?:createRelease|deleteRelease|updateRelease|uploadReleaseAsset)\b/,
      /uses:\s*(?:actions\/create-release|ncipollo\/release-action|softprops\/action-gh-release)@/,
      /electron-forge publish/,
      /npm run publish/,
    ];
    const violations = workflows.flatMap(({ name, contents }) =>
      mutationPatterns
        .filter((pattern) => pattern.test(contents))
        .map((pattern) => `${name}: ${pattern.source}`),
    );

    expect(violations).toEqual([]);
  });

  it("prevents write-enabled public release workflows", async () => {
    const workflows = await readWorkflows();
    const violations = workflows
      .filter(
        ({ contents }) =>
          /contents:\s*write/.test(contents) &&
          /(?:\brelease\b|git\/refs\/tags)/i.test(contents),
      )
      .map(({ name }) => name);

    expect(violations).toEqual([]);
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
