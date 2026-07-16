import { REDDIT_FASTPATH_ENABLED, REDDIT_IGNORE_ROBOTS } from "./config.js";
import { readBoundedText, safeFetch, type TierResult } from "./fetch-utils.js";
import { checkRobots } from "./robots.js";

const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
]);
const UA =
  "searxng-mcp/3.15.0 (+https://github.com/TadMSTR/searxng-mcp; personal research)";
const MAX_COMMENTS = 20;

export function isRedditHost(url: string): boolean {
  if (!REDDIT_FASTPATH_ENABLED) return false;
  try {
    return REDDIT_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Append `.json` to the path (Reddit's public JSON view), preserving the query.
function toJsonUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith(".json")) return parsed.toString();
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}.json`;
    return parsed.toString();
  } catch {
    return null;
  }
}

interface RedditPost {
  title?: string;
  author?: string;
  subreddit?: string;
  selftext?: string;
  score?: number;
  num_comments?: number;
}
interface RedditComment {
  author?: string;
  body?: string;
  score?: number;
}
interface RedditListing<T> {
  data?: { children?: Array<{ data?: T }> };
}

// Parse the [post, comments] array Reddit returns for a thread URL into the
// standard fetch-result shape. Returns null for any other response shape.
function parseThread(data: unknown): { title: string; text: string } | null {
  if (!Array.isArray(data) || data.length < 2) return null;
  const post = (data[0] as RedditListing<RedditPost>)?.data?.children?.[0]
    ?.data;
  if (!post?.title) return null;

  const parts: string[] = [`# ${post.title}`];
  const meta: string[] = [];
  if (post.author) meta.push(`by u/${post.author}`);
  if (post.subreddit) meta.push(`in r/${post.subreddit}`);
  if (typeof post.score === "number") meta.push(`${post.score} pts`);
  if (meta.length) parts.push(meta.join(" · "));
  if (post.selftext?.trim()) parts.push(post.selftext.trim());

  const children =
    (data[1] as RedditListing<RedditComment>)?.data?.children ?? [];
  const comments: string[] = [];
  for (const child of children) {
    const c = child?.data;
    if (!c?.body || c.author === "AutoModerator") continue;
    comments.push(
      `u/${c.author ?? "?"} (${c.score ?? 0} pts): ${c.body.trim()}`,
    );
    if (comments.length >= MAX_COMMENTS) break;
  }
  if (comments.length) {
    parts.push(`## Top comments\n\n${comments.join("\n\n")}`);
  }

  return { title: post.title, text: parts.join("\n\n") };
}

/**
 * Best-effort Reddit fetch via the public `.json` endpoint. Returns null (caller
 * falls through to the normal cascade) if the feature is disabled, robots.txt
 * disallows the path (unless REDDIT_IGNORE_ROBOTS), the request is rate-limited
 * (429), or the response isn't a parseable thread.
 */
export async function redditFetch(
  url: string,
  maxChars = 8000,
): Promise<TierResult | null> {
  if (!REDDIT_FASTPATH_ENABLED) return null;
  const jsonUrl = toJsonUrl(url);
  if (!jsonUrl) return null;

  if (!REDDIT_IGNORE_ROBOTS) {
    const robots = await checkRobots(jsonUrl, "searxng-mcp");
    if (!robots.allowed) return null;
  }

  try {
    const res = await safeFetch(jsonUrl, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    // Reddit rate-limits datacenter IPs aggressively — fall through rather than
    // erroring so the standard cascade can try.
    if (res.status === 429 || !res.ok) return null;

    // Bounded read (2 MB cap) before JSON.parse so an oversized/adversarial
    // thread response can't consume unbounded memory (audit LOW).
    const data = JSON.parse(await readBoundedText(res)) as unknown;
    const parsed = parseThread(data);
    if (!parsed) return null;

    return { title: parsed.title, url, text: parsed.text.slice(0, maxChars) };
  } catch {
    return null;
  }
}
