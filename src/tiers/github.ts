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
  // A repo-root query can name another document (`?tab=security-ov-file`
  // shows the security policy), and the README call ignores it.
  if (parts.length === 2) return parsed.search === "";
  // A query changes which releases the page shows (`?page=2`, `?q=`), and the
  // API call below takes none of it: `…/releases?page=2` was answered with
  // page 1 and cached under the page-2 URL. Those go to the cascade.
  if (parts[2] === "releases")
    return parsed.search === "" && releasesApiPath(parts.slice(3)) !== null;
  return parts.length >= 4 && (parts[2] === "blob" || parts[2] === "tree");
}

/**
 * Whether a failed fast path may fall back to the normal cascade: a file, named
 * by a github.com `blob` URL or a raw.githubusercontent.com URL. The cascade
 * renders those as the page they name (the blob page, or the file itself), so
 * a rate limit, timeout or upstream error on the fast path need not fail the
 * fetch.
 *
 * Every other fast-path shape (repo root, tree, releases, api.github.com)
 * keeps failing outright. The cascade would answer those with a page the URL
 * does not name: the rendered repo or release page buries the content under
 * site navigation, robots.txt disallows tree pages, and an API URL rendered
 * as a web page is just its JSON error.
 */
export function githubFallsBackToCascade(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname === "raw.githubusercontent.com") return true;
  if (parsed.hostname !== "github.com") return false;
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length >= 4 && parts[2] === "blob";
}

/**
 * The GitHub fast path failed for a URL that does not fall back. The message
 * names the tier's reason (scrubbed and bounded by runTier), so the caller sees
 * "GitHub raw fetch error: 404 Not Found" rather than only that it failed.
 */
export class GithubFastPathError extends Error {
  readonly metricErrorType = "github_fetch_failed";
  constructor(reason: string) {
    super(`GitHub fast-path fetch failed: ${reason}`);
    this.name = "GithubFastPathError";
  }
}

/** API path suffix for a github.com release page, or null for shapes this tier
 * does not serve (e.g. `/releases/download/...` asset links). `rest` is
 * decoded (see decodeSegment); each tag segment is encoded on its own. */
function releasesApiPath(rest: string[]): string | null {
  if (rest.length === 0) return "/releases?per_page=10";
  if (rest.length === 1 && rest[0] === "latest") return "/releases/latest";
  if (rest.length >= 2 && rest[0] === "tag")
    return `/releases/tags/${encodePath(rest.slice(1))}`;
  return null;
}

/** A GitHub owner or repository name. */
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

function isGithubName(name: string | undefined): name is string {
  return (
    name !== undefined &&
    GITHUB_NAME.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

/** A URL path segment decoded once; a malformed escape is kept as written. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Whether a decoded segment would change the shape of the API path it is put
 * in. The WHATWG parser resolves dot segments before this tier sees them, but
 * an escaped separator survives parsing, and a segment that decodes to one
 * can name a different API path from the one the URL shows.
 */
function isUnsafeSegment(value: string, allowSlash = false): boolean {
  return (
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("\\") ||
    (!allowSlash && value.includes("/"))
  );
}

function refuse(reason: string, url: string): never {
  throw new Error(`GitHub fast path refuses this URL (${reason}): ${url}`);
}

/** Decoded segments joined into a path, each encoded on its own. */
function encodePath(segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

/**
 * Whether `GITHUB_TOKEN` may be sent with a request to `url`: only for the
 * repository endpoints this tier builds itself.
 *
 * - `api.github.com/repos/{owner}/{repo}/readme[/{dir...}]`
 * - `api.github.com/repos/{owner}/{repo}/contents[/{path...}]`
 * - `api.github.com/repos/{owner}/{repo}/releases`, `/releases/latest`,
 *   `/releases/tags/{tag...}`
 * - `api.github.com/repos/{owner}/{repo}/git/matching-refs/{heads|tags}/{ref}`
 * - `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}`
 *
 * A caller can name any api.github.com URL. Any URL not listed here is
 * fetched without the token, so public API data still works and private data
 * gets GitHub's 401 or 404. The match is by shape, not by who built the URL:
 * a caller-named URL of a listed shape gets the token for any repository the
 * token can read.
 */
export function githubAuthAllowed(url: URL): boolean {
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return false;
  }
  const raw = url.pathname.split("/").slice(1);
  // `contents/` is the repository root's listing.
  if (raw.length > 1 && raw.at(-1) === "") raw.pop();
  const segments: string[] = [];
  for (const segment of raw) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (isUnsafeSegment(value)) return false;
    segments.push(value);
  }
  if (url.hostname === "raw.githubusercontent.com") {
    const [owner, repo] = segments;
    return segments.length >= 4 && isGithubName(owner) && isGithubName(repo);
  }
  if (url.hostname !== "api.github.com") return false;
  const [root, owner, repo, kind, ...rest] = segments;
  if (root !== "repos" || !isGithubName(owner) || !isGithubName(repo)) {
    return false;
  }
  switch (kind) {
    case "readme":
    case "contents":
      return true;
    case "releases":
      return (
        rest.length === 0 ||
        (rest.length === 1 && rest[0] === "latest") ||
        (rest.length >= 2 && rest[0] === "tags")
      );
    case "git":
      return (
        rest.length === 3 &&
        rest[0] === "matching-refs" &&
        (rest[1] === "heads" || rest[1] === "tags")
      );
    default:
      return false;
  }
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
  const res = await fetchApi(
    `https://api.github.com/repos/${owner}/${repo}${suffix}`,
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

/**
 * File listing for a tree directory that has no README. `branch` and
 * `dirPath` are decoded.
 *
 * A tree URL can name a file: GitHub redirects the page to the blob, and the
 * Contents API answers with one object instead of a list. That used to throw a
 * TypeError from `entries.map`. A file is now fetched as its blob URL would
 * be; any other single entry (a symlink or submodule) is reported as such.
 */
async function fetchDirectoryListing(
  owner: string,
  repo: string,
  branch: string,
  dirPath: string[],
  pageUrl: string,
  maxChars: number,
): Promise<{ title: string; url: string; text: string }> {
  const dir = dirPath.join("/");
  const res = await fetchApi(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(dirPath)}?ref=${encodeURIComponent(branch)}`,
  );
  const data = JSON.parse(await readBoundedText(res)) as unknown;
  if (!Array.isArray(data)) {
    const type = (data as { type?: unknown } | null)?.type;
    if (type === "file") {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodePath([...branch.split("/"), ...dirPath])}`;
      return { ...(await fetchRawContent(rawUrl, maxChars)), url: pageUrl };
    }
    throw new Error(
      `GitHub tree URL does not name a directory (${typeof type === "string" ? type : "unknown type"}): ${pageUrl}`,
    );
  }
  const entries = data as Array<{
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

/**
 * Split a `tree` URL's path after `tree/` into the ref and the directory.
 *
 * A ref can contain slashes (`feature/topic`, `release/3.31.0`), and the URL
 * gives no boundary between ref and path. Taking the first segment as the ref
 * sent `ref=feature` for a branch named `feature/topic`, so the request failed,
 * or named another ref's directory when both existed. When there is more than
 * one segment, ask the API which branches and tags start with the first one
 * and take the longest that the path begins with on a segment boundary,
 * across both namespaces. A tie is one name, and GitHub resolves it as it
 * resolves any `ref=`.
 *
 * A failed lookup (error status, network error, a body that is not a list)
 * throws. Falling back to the first segment could serve another ref's
 * directory under this URL with nothing to say so.
 *
 * `rest` is decoded (see decodeSegment), and so are the ref and directory
 * returned.
 */
async function splitTreeRef(
  owner: string,
  repo: string,
  rest: string[],
): Promise<{ ref: string; dirPath: string[] }> {
  const fallback = { ref: rest[0] ?? "", dirPath: rest.slice(1) };
  if (rest.length < 2) return fallback;
  const names = new Set<string>();
  for (const kind of ["heads", "tags"]) {
    let data: unknown;
    try {
      const res = await fetchApi(
        `https://api.github.com/repos/${owner}/${repo}/git/matching-refs/${kind}/${encodeURIComponent(rest[0])}`,
      );
      data = JSON.parse(await readBoundedText(res));
    } catch (err) {
      throw new Error(
        `GitHub ref lookup failed (${kind}): ${err instanceof Error ? err.message : String(err)}. ` +
          "The ref in this tree URL cannot be told apart from its path.",
      );
    }
    if (!Array.isArray(data)) {
      throw new Error(
        `GitHub ref lookup failed (${kind}): response is not a list. ` +
          "The ref in this tree URL cannot be told apart from its path.",
      );
    }
    const prefix = `refs/${kind}/`;
    for (const r of data) {
      const ref = (r as { ref?: unknown })?.ref;
      if (typeof ref === "string" && ref.startsWith(prefix)) {
        names.add(ref.slice(prefix.length));
      }
    }
  }
  for (let k = rest.length; k >= 2; k--) {
    if (names.has(rest.slice(0, k).join("/"))) {
      return { ref: rest.slice(0, k).join("/"), dirPath: rest.slice(k) };
    }
  }
  return fallback;
}

/** The token, for the URLs githubAuthAllowed accepts. */
function authHeader(url: string): Record<string, string> {
  return GITHUB_TOKEN && githubAuthAllowed(new URL(url))
    ? { Authorization: `Bearer ${GITHUB_TOKEN}` }
    : {};
}

function rawHeaders(url: string): Record<string, string> {
  return { "User-Agent": USER_AGENT, ...authHeader(url) };
}

function apiHeaders(url: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
    ...authHeader(url),
  };
}

function fetchApi(url: string): Promise<Response> {
  return fetchWithRedirectGuard(url, apiHeaders(url), "GitHub API error");
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
    rawHeaders(url),
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
 * responses; falls back to pretty-printed JSON for other endpoints. The token
 * goes only with the endpoint shapes githubAuthAllowed names. */
async function fetchApiUrl(
  url: string,
  maxChars: number,
): Promise<{ title: string; url: string; text: string }> {
  const res = await fetchApi(url);
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
  const [owner, repo] = parts;
  if (!isGithubName(owner) || !isGithubName(repo)) {
    refuse("owner or repository is not a GitHub name", url);
  }
  // Every later segment is decoded once here and encoded on its own where it
  // is used. A segment that decodes to "/" or a dot segment is refused: it
  // would name another API path than the one this URL shows.
  const rest = parts.slice(3).map(decodeSegment);
  // A tree URL with nothing after its ref sends the ref only as a query
  // value, where a "/" is harmless: `tree/feat%2Fx` is the branch feat/x.
  const allowSlash = parts[2] === "tree" && rest.length === 1;
  if (rest.some((value) => isUnsafeSegment(value, allowSlash))) {
    refuse("a path segment is not a plain name", url);
  }

  if (parts[2] === "releases") {
    return fetchReleases(owner, repo, rest, url, maxChars);
  }

  if (parts.length >= 4 && parts[2] === "blob") {
    // Rewrite blob URL to raw content
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodePath(rest)}`;
    return fetchRawContent(rawUrl, maxChars);
  }

  // Repo root, or a tree directory — fetch that directory's README via the
  // GitHub API. A tree URL used to get the repo-root README whatever directory
  // it named.
  const { ref: branch, dirPath } =
    parts[2] === "tree"
      ? await splitTreeRef(owner, repo, rest)
      : { ref: "", dirPath: [] as string[] };
  let apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  if (parts[2] === "tree") {
    if (dirPath.length > 0) apiUrl += `/${encodePath(dirPath)}`;
    // The WHATWG parser leaves `&` and `=` unescaped in a path, so
    // `…/tree/main&per_page=1/docs` interpolated as-is added a parameter to
    // the API request. The decoded ref is encoded as one value.
    apiUrl += `?ref=${encodeURIComponent(branch)}`;
  }
  let res: Response;
  try {
    res = await fetchApi(apiUrl);
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
