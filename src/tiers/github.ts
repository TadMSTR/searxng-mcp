import { GITHUB_TOKEN } from "../config.js";
import {
  assertPublicUrl,
  readBoundedText,
  safeFetch,
  USER_AGENT,
} from "../fetch-utils.js";
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

/**
 * Whether the fast path can serve this URL *as the page it names*. Every
 * raw.githubusercontent.com and api.github.com URL qualifies. On github.com
 * only these shapes do: a repo root (README), a `blob` file (raw content), a
 * `tree` directory (that directory's README, else its file listing) and the
 * release pages (`/releases`, `/releases/latest`, `/releases/tag/<tag>`, read
 * from the releases API — the rendered page buries the notes under ~100 lines
 * of site navigation, and GitHub's robots.txt points crawlers at the API).
 *
 * Every github.com URL used to be claimed, and every shape but `blob` was
 * answered with the repo-root README: `…/valkey/releases` returned Valkey's
 * README with nothing to say it was not the release notes, so an agent read it
 * as the answer. Shapes not listed above — issues, pulls, commits, wiki, owner
 * pages, release asset downloads — now fall through to the normal cascade,
 * which renders the actual page.
 */
export function isGithubFastPathUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!GITHUB_HOSTS.has(parsed.hostname)) return false;
  if (parsed.hostname !== "github.com") return true;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length === 2) return true;
  if (parts[2] === "releases") return releasesApiPath(parts.slice(3)) !== null;
  return parts.length >= 4 && (parts[2] === "blob" || parts[2] === "tree");
}

/** API path suffix for a github.com release page, or null for shapes this tier
 * does not serve (e.g. `/releases/download/...` asset links). */
function releasesApiPath(rest: string[]): string | null {
  if (rest.length === 0) return "/releases?per_page=10";
  if (rest.length === 1 && rest[0] === "latest") return "/releases/latest";
  if (rest.length >= 2 && rest[0] === "tag")
    return `/releases/tags/${rest.slice(1).join("/")}`;
  return null;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
}

function renderRelease(r: GitHubRelease): string {
  const heading =
    r.name && r.name !== r.tag_name ? `${r.tag_name} — ${r.name}` : r.tag_name;
  const flags = [r.prerelease && "pre-release", r.draft && "draft"]
    .filter(Boolean)
    .join(", ");
  const date = r.published_at?.slice(0, 10) ?? "unpublished";
  return `## ${heading}\n${date}${flags ? ` (${flags})` : ""} · ${r.html_url}\n\n${(r.body ?? "").trim()}`;
}

/** Release notes as markdown, newest first — the list (10 most recent), the
 * latest release, or one tag. */
async function fetchReleases(
  owner: string,
  repo: string,
  rest: string[],
  pageUrl: string,
  maxChars: number,
): Promise<{ title: string; url: string; text: string }> {
  const suffix = releasesApiPath(rest);
  if (suffix === null) {
    throw new Error(`GitHub fast path does not handle this URL: ${pageUrl}`);
  }
  const res = await fetchWithRedirectGuard(
    `https://api.github.com/repos/${owner}/${repo}${suffix}`,
    apiHeaders(),
    "GitHub API error",
  );
  const data = JSON.parse(await readBoundedText(res)) as
    | GitHubRelease
    | GitHubRelease[];
  const releases = Array.isArray(data) ? data : [data];
  const text =
    releases.length > 0
      ? releases.map(renderRelease).join("\n\n---\n\n").slice(0, maxChars)
      : "This repository has no published releases.";
  const which = rest.length === 0 ? "releases" : (rest.at(-1) ?? "releases");
  return { title: `${owner}/${repo} — ${which}`, url: pageUrl, text };
}

/** File listing for a tree directory that has no README. */
async function fetchDirectoryListing(
  owner: string,
  repo: string,
  branch: string,
  dirPath: string[],
  pageUrl: string,
  maxChars: number,
): Promise<{ title: string; url: string; text: string }> {
  const dir = dirPath.join("/");
  const res = await fetchWithRedirectGuard(
    `https://api.github.com/repos/${owner}/${repo}/contents/${dir}?ref=${branch}`,
    apiHeaders(),
    "GitHub API error",
  );
  const entries = JSON.parse(await readBoundedText(res)) as Array<{
    name: string;
    type: string;
  }>;
  const lines = entries.map((e) => `- ${e.name}${e.type === "dir" ? "/" : ""}`);
  const text =
    `No README in ${dir || "/"} at ${branch}. Directory listing:\n\n${lines.join("\n")}`.slice(
      0,
      maxChars,
    );
  return { title: `${owner}/${repo}/${dir} (${branch})`, url: pageUrl, text };
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
  // Bounded read before the slice: res.text() materialised the whole file
  // first, so the slice was capping the *result*, not the read. The 2 MB
  // default is far above any reachable maxChars (schema max is 10000 tokens =
  // 40000 chars), so nothing that used to be returned is lost.
  const text = (await readBoundedText(res)).slice(0, maxChars);
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
  // Bounded read before JSON.parse — same pattern as tiers/firecrawl.ts.
  // res.json() has no size limit of its own.
  const data = JSON.parse(await readBoundedText(res)) as Record<
    string,
    unknown
  >;

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

  // github.com — blob URL rewrite, release notes, or a repo-root / directory
  // README fetch. Refuse any other shape rather than answer it with the root
  // README (see isGithubFastPathUrl); fetchPage never routes one here.
  if (!isGithubFastPathUrl(url)) {
    throw new Error(`GitHub fast path does not handle this URL: ${url}`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  // parts: [owner, repo], [owner, repo, "blob"|"tree", branch, ...path] or
  // [owner, repo, "releases", ...]
  if (parts[2] === "releases") {
    return fetchReleases(parts[0], parts[1], parts.slice(3), url, maxChars);
  }

  if (parts.length >= 4 && parts[2] === "blob") {
    // Rewrite blob URL to raw content
    const [owner, repo, , branch, ...filePath] = parts;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.join("/")}`;
    return fetchRawContent(rawUrl, maxChars);
  }

  // Repo root, or a tree directory — fetch that directory's README via the
  // GitHub API. A tree URL used to get the repo-root README whatever directory
  // it named.
  const [owner, repo, , branch, ...dirPath] = parts;
  let apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  if (parts[2] === "tree") {
    if (dirPath.length > 0) apiUrl += `/${dirPath.join("/")}`;
    apiUrl += `?ref=${branch}`;
  }
  let res: Response;
  try {
    res = await fetchWithRedirectGuard(
      apiUrl,
      apiHeaders(),
      "GitHub API error",
    );
  } catch (err) {
    // A directory with no README: list its files instead. The rendered tree
    // page is no fallback — robots.txt disallows /*/tree/ for crawlers.
    if (
      parts[2] === "tree" &&
      err instanceof Error &&
      err.message.startsWith("GitHub API error: 404")
    ) {
      return fetchDirectoryListing(owner, repo, branch, dirPath, url, maxChars);
    }
    throw err;
  }
  // Bounded read before JSON.parse — see fetchApiUrl above.
  const data = JSON.parse(await readBoundedText(res)) as GitHubReadmeResponse;
  const text = Buffer.from(data.content, "base64")
    .toString("utf-8")
    .slice(0, maxChars);
  return { title: `${owner}/${repo} — ${data.name}`, url: data.html_url, text };
}
