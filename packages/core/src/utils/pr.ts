import type { PRInfo } from "../types.js";

export type ParsedPrUrl = Pick<PRInfo, "owner" | "repo" | "number" | "url">;

const GITHUB_PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const TRAILING_NUMBER_REGEX = /\/(\d+)$/;

export function parsePrFromUrl(prUrl: string): ParsedPrUrl | null {
  const githubMatch = prUrl.match(GITHUB_PR_URL_REGEX);
  if (githubMatch) {
    const [, owner, repo, prNumber] = githubMatch;
    return {
      owner,
      repo,
      number: parseInt(prNumber, 10),
      url: prUrl,
    };
  }

  const trailingNumberMatch = prUrl.match(TRAILING_NUMBER_REGEX);
  if (trailingNumberMatch) {
    return {
      owner: "",
      repo: "",
      number: parseInt(trailingNumberMatch[1], 10),
      url: prUrl,
    };
  }

  return null;
}
