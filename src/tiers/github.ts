import { GITHUB_TOKEN } from "../config.js";
import { USER_AGENT } from "../fetch-utils.js";
import type { GitHubReadmeResponse } from "../types.js";

export async function githubFetch(
  url: string,
  maxChars = 8000,
): Promise<{ title: string; url: string; text: string }> {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  // parts: [owner, repo] or [owner, repo, "blob"|"tree", branch, ...path]

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  if (parts.length >= 4 && parts[2] === "blob") {
    // Rewrite blob URL to raw content
    const [owner, repo, , branch, ...filePath] = parts;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.join("/")}`;
    const rawHeaders: Record<string, string> = { "User-Agent": USER_AGENT };
    if (GITHUB_TOKEN) rawHeaders.Authorization = `Bearer ${GITHUB_TOKEN}`;
    const res = await fetch(rawUrl, {
      headers: rawHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok)
      throw new Error(
        `GitHub raw fetch error: ${res.status} ${res.statusText}`,
      );
    const text = (await res.text()).slice(0, maxChars);
    const fileName = filePath[filePath.length - 1] ?? url;
    return { title: fileName, url: rawUrl, text };
  }

  // Repo root or tree — fetch README via GitHub API
  const [owner, repo] = parts;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const res = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok)
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as GitHubReadmeResponse;
  const text = Buffer.from(data.content, "base64")
    .toString("utf-8")
    .slice(0, maxChars);
  return { title: `${owner}/${repo} — ${data.name}`, url: data.html_url, text };
}
