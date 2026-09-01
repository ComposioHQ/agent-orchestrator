import { describe, expect, it } from "vitest";
import { remotelessDefaultBranchCandidate } from "../components/CreateProjectFlow";
import type { ImportFolderScan } from "../../preload";

type ScanRepo = ImportFolderScan["repos"][number];

function repo(overrides: Partial<ScanRepo> = {}): ScanRepo {
	return {
		name: "repo",
		path: "/repo",
		relativePath: ".",
		branch: "auto",
		remote: "",
		hasRemote: false,
		hasCommit: true,
		checkedOutBranch: "trunk",
		status: "ok",
		...overrides,
	};
}

describe("remotelessDefaultBranchCandidate", () => {
	it("offers the checked-out branch for a committed remote-less repository", () => {
		expect(remotelessDefaultBranchCandidate(repo({ checkedOutBranch: "trunk" }))).toBe("trunk");
	});

	it("offers nothing when a remote exists", () => {
		expect(
			remotelessDefaultBranchCandidate(repo({ hasRemote: true, remote: "https://example.com/repo.git" })),
		).toBeNull();
	});

	it("offers nothing for an unborn repository", () => {
		expect(remotelessDefaultBranchCandidate(repo({ hasCommit: false }))).toBeNull();
	});

	it("offers nothing for a detached HEAD", () => {
		expect(remotelessDefaultBranchCandidate(repo({ checkedOutBranch: "" }))).toBeNull();
	});

	it("offers nothing when the scan has no repository", () => {
		expect(remotelessDefaultBranchCandidate(undefined)).toBeNull();
	});
});
