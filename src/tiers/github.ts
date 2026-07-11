import { GITHUB_TOKEN } from "../config.js";
import { USER_AGENT } from "../fetch-utils.js";
import type { GitHubReadmeResponse } from "../types.js";

/** Hostnames handled by this tier's fast path. */
export const GITHUB_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "api.github.com",
]);

export function isGithubUrl(url: string): boolean {
  try {
    return GITHUB_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function rawHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

/** Fetch a raw.githubusercontent.com URL directly — no rewrite needed. */
async function fetchRawContent(
  url: string,
  maxChars: number,
): Promise<{ title: string; url: string; text: string }> {
  const res = await fetch(url, {
    headers: rawHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok)
    throw new Error(`GitHub raw fetch error: ${res.status} ${res.statusText}`);
  const text = (await res.text()).slice(0, maxChars);
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] ?? url;
  return { title: fileName, url, text };
}

/** Fetch an api.github.com URL directly. Decodes README-style base64 content
 * responses; falls back to pretty-printed JSON for other endpoints. */
async function fetchApiUrl(
  url: string,
  maxChars: number,
): Promise<{ title: string; url: string; text: string }> {
  const res = await fetch(url, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok)
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as Record<string, unknown>;

  if (
    typeof data.content === "string" &&
    data.encoding === "base64" &&
    typeof data.name === "string"
  ) {
    const text = Buffer.from(data.content, "base64")
      .toString("utf-8")
      .slice(0, maxChars);
    const htmlUrl = typeof data.html_url === "string" ? data.html_url : url;
    return { title: data.name, url: htmlUrl, text };
  }

  const text = JSON.stringify(data, null, 2).slice(0, maxChars);
  return { title: new URL(url).pathname, url, text };
}

export async function githubFetch(
  url: string,
  maxChars = 8000,
): Promise<{ title: string; url: string; text: string }> {
  const parsed = new URL(url);

  if (parsed.hostname === "raw.githubusercontent.com") {
    return fetchRawContent(url, maxChars);
  }

  if (parsed.hostname === "api.github.com") {
    return fetchApiUrl(url, maxChars);
  }

  // github.com — blob URL rewrite or repo-root README fetch
  const parts = parsed.pathname.split("/").filter(Boolean);
  // parts: [owner, repo] or [owner, repo, "blob"|"tree", branch, ...path]

  if (parts.length >= 4 && parts[2] === "blob") {
    // Rewrite blob URL to raw content
    const [owner, repo, , branch, ...filePath] = parts;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.join("/")}`;
    return fetchRawContent(rawUrl, maxChars);
  }

  // Repo root or tree — fetch README via GitHub API
  const [owner, repo] = parts;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const res = await fetch(apiUrl, {
    headers: apiHeaders(),
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
