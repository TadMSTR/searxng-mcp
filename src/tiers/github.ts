import { GITHUB_TOKEN } from "../config.js";
import { assertPublicUrl, safeFetch, USER_AGENT } from "../fetch-utils.js";
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

// SSRF-02: redirect: "manual" + explicit 3xx rejection prevents a public
// GitHub URL from redirecting to an internal address and bypassing
// assertPublicUrl (which only validates the original URL). Location header
// is deliberately not echoed in the error — that would leak an internal
// address to the MCP caller (OE-02).
async function fetchWithRedirectGuard(
  url: string,
  headers: Record<string, string>,
  errorPrefix: string,
): Promise<Response> {
  // safeFetch routes through the DNS-validating dispatcher so the GITHUB_TOKEN
  // is never sent to a private address if a GitHub host resolves internally.
  const res = await safeFetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${errorPrefix}: redirect not followed (${res.status})`);
  }
  if (!res.ok)
    throw new Error(`${errorPrefix}: ${res.status} ${res.statusText}`);
  return res;
}

/** Fetch a raw.githubusercontent.com URL directly — no rewrite needed. */
async function fetchRawContent(
  url: string,
  maxChars: number,
): Promise<{ title: string; url: string; text: string }> {
  const res = await fetchWithRedirectGuard(
    url,
    rawHeaders(),
    "GitHub raw fetch error",
  );
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
  const res = await fetchWithRedirectGuard(
    url,
    apiHeaders(),
    "GitHub API error",
  );
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
  // Defensive SSRF guard (SSRF-08) — fetch.ts's fetchPage() already calls
  // assertPublicUrl before dispatching here, but githubFetch is exported so
  // this protects against future direct callers.
  assertPublicUrl(url);
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
  const res = await fetchWithRedirectGuard(
    apiUrl,
    apiHeaders(),
    "GitHub API error",
  );
  const data = (await res.json()) as GitHubReadmeResponse;
  const text = Buffer.from(data.content, "base64")
    .toString("utf-8")
    .slice(0, maxChars);
  return { title: `${owner}/${repo} — ${data.name}`, url: data.html_url, text };
}
