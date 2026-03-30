import { describe, it, expect } from "vitest";
import { parsePrFromUrl } from "../utils/pr.js";

describe("parsePrFromUrl", () => {
  describe("GitHub URLs", () => {
    it("parses standard GitHub PR URL", () => {
      const result = parsePrFromUrl("https://github.com/org/repo/pull/42");
      expect(result).toEqual({
        owner: "org",
        repo: "repo",
        number: 42,
        url: "https://github.com/org/repo/pull/42",
      });
    });
  });

  describe("GitLab URLs", () => {
    it("parses GitLab cloud MR URL", () => {
      const result = parsePrFromUrl("https://gitlab.com/mygroup/myrepo/-/merge_requests/100");
      expect(result).toEqual({
        owner: "gitlab.com/mygroup",
        repo: "myrepo",
        number: 100,
        url: "https://gitlab.com/mygroup/myrepo/-/merge_requests/100",
      });
    });

    it("parses self-hosted GitLab MR URL", () => {
      const result = parsePrFromUrl(
        "https://gitlab.corp.com/team/project/-/merge_requests/55",
      );
      expect(result).toEqual({
        owner: "gitlab.corp.com/team",
        repo: "project",
        number: 55,
        url: "https://gitlab.corp.com/team/project/-/merge_requests/55",
      });
    });

    it("parses GitLab MR URL with subgroups", () => {
      const result = parsePrFromUrl(
        "https://gitlab.com/org/sub-group/deep/repo/-/merge_requests/7",
      );
      expect(result).toEqual({
        owner: "gitlab.com/org/sub-group/deep",
        repo: "repo",
        number: 7,
        url: "https://gitlab.com/org/sub-group/deep/repo/-/merge_requests/7",
      });
    });
  });

  describe("trailing number fallback", () => {
    it("falls back to trailing number for unknown URL formats", () => {
      const result = parsePrFromUrl("https://unknown.host/some/path/123");
      expect(result).toEqual({
        owner: "",
        repo: "",
        number: 123,
        url: "https://unknown.host/some/path/123",
      });
    });
  });

  describe("invalid URLs", () => {
    it("returns null for URLs with no number", () => {
      const result = parsePrFromUrl("https://example.com/no-number-here");
      expect(result).toBeNull();
    });
  });
});
