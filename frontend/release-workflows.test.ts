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

describe("linux package repositories workflow", () => {
	const workflowPath = path.join(
		repositoryRoot,
		".github",
		"workflows",
		"linux-repos.yml",
	);

	it("publishes only for canonical stable releases", async () => {
		const contents = await readFile(workflowPath, "utf8");

		// Nightlies are published as prereleases in this same repo. An apt or dnf
		// user tracking stable must never be handed one, and a fork has neither
		// the signing key nor anywhere to publish.
		expect(contents).toContain("!github.event.repository.fork");
		expect(contents).toContain("!github.event.release.prerelease");
		// The signing key lives behind the same required reviewers as the signed
		// desktop release.
		expect(contents).toContain("environment: release");
	});

	it("keeps the two repository base URLs the README documents", async () => {
		const [workflow, readme] = await Promise.all([
			readFile(workflowPath, "utf8"),
			readFile(path.join(repositoryRoot, "README.md"), "utf8"),
		]);

		// apt resolves a package's Filename against the repository base, so the
		// metadata has to be uploaded to the release the packages live on.
		expect(workflow).toContain("gh release upload");
		expect(workflow).toContain("apt/InRelease");
		expect(readme).toContain(
			"https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/ ./",
		);

		// dnf needs a repodata/ subdirectory, which release assets cannot express,
		// so its metadata is pushed to the linux-repo branch. If that branch name
		// changes, the README's baseurl is stale and every dnf client 404s.
		expect(workflow).toContain("push origin linux-repo");
		expect(readme).toContain(
			"baseurl=https://raw.githubusercontent.com/Untrivial-ai/agent-orchestrator/linux-repo/dnf/",
		);
	});
});
