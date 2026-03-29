import type { PRInfo } from "../types.js";

export type ParsedPrUrl = Pick<PRInfo, "owner" | "repo" | "number" | "url">;

const GITHUB_PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const BITBUCKET_PR_URL_REGEX = /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/;
const GITLAB_MR_URL_REGEX = /gitlab\.[^/]*\/([^/]+)\/([^/]+)\/-\/merge_requests\/(\d+)/;
const TRAILING_NUMBER_REGEX = /\/(\d+)$/;

export function parsePrFromUrl(prUrl: string): ParsedPrUrl | null {
  const githubMatch = prUrl.match(GITHUB_PR_URL_REGEX);
  if (githubMatch) {
    const [, owner, repo, prNumber] = githubMatch;
    return { owner, repo, number: parseInt(prNumber, 10), url: prUrl };
  }

  const bitbucketMatch = prUrl.match(BITBUCKET_PR_URL_REGEX);
  if (bitbucketMatch) {
    const [, workspace, repo, prNumber] = bitbucketMatch;
    return { owner: workspace, repo, number: parseInt(prNumber, 10), url: prUrl };
  }

  const gitlabMatch = prUrl.match(GITLAB_MR_URL_REGEX);
  if (gitlabMatch) {
    const [, namespace, repo, mrNumber] = gitlabMatch;
    return { owner: namespace, repo, number: parseInt(mrNumber, 10), url: prUrl };
  }

  const trailingNumberMatch = prUrl.match(TRAILING_NUMBER_REGEX);
  if (trailingNumberMatch) {
    return { owner: "", repo: "", number: parseInt(trailingNumberMatch[1], 10), url: prUrl };
  }

  return null;
}
