import type { PullRequestData, PullRequestFile } from "./types.js"

const PR_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i

export function parsePullRequestUrl(url: string): {
  owner: string
  repo: string
  number: number
} {
  const match = url.trim().match(PR_URL_RE)
  if (!match) {
    throw new Error(
      `Expected a GitHub PR URL like https://github.com/owner/repo/pull/123, got: ${url}`
    )
  }
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  }
}

export async function fetchPullRequest(url: string): Promise<PullRequestData> {
  const { owner, repo, number } = parsePullRequestUrl(url)
  const headers = githubHeaders()

  const [prRes, filesRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers,
    }),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
      { headers }
    ),
  ])

  if (!prRes.ok) {
    throw new Error(
      `GitHub PR fetch failed (${prRes.status}): ${await prRes.text()}`
    )
  }
  if (!filesRes.ok) {
    throw new Error(
      `GitHub PR files fetch failed (${filesRes.status}): ${await filesRes.text()}`
    )
  }

  const pr = (await prRes.json()) as {
    html_url: string
    number: number
    title: string
    body: string | null
    user: { login: string }
    base: { ref: string }
    head: { ref: string }
  }
  const filesJson = (await filesRes.json()) as Array<{
    filename: string
    status: string
    additions: number
    deletions: number
    patch?: string
  }>

  const files: PullRequestFile[] = filesJson.slice(0, 40).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: truncate(f.patch ?? "", 3500),
  }))

  return {
    url: pr.html_url,
    owner,
    repo,
    number: pr.number,
    title: pr.title,
    body: truncate(pr.body ?? "", 6000),
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    files,
  }
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cursor-cookbook-pr-explainer-video",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(truncated)`
}
