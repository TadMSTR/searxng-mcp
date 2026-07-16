import { YOUTUBE_IGNORE_ROBOTS, YOUTUBE_TRANSCRIPT_ENABLED } from "./config.js";
import { readBoundedText, safeFetch, type TierResult } from "./fetch-utils.js";
import { checkRobots } from "./robots.js";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const YOUTUBE_ORIGIN = "https://www.youtube.com";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const UA =
  "searxng-mcp/3.15.0 (+https://github.com/TadMSTR/searxng-mcp; personal research)";

export function isYouTubeHost(url: string): boolean {
  if (!YOUTUBE_TRANSCRIPT_ENABLED) return false;
  try {
    const { hostname } = new URL(url);
    return YOUTUBE_HOSTS.has(hostname) || hostname === "youtu.be";
  } catch {
    return false;
  }
}

/** Pull the 11-char video id from any common YouTube URL form. */
export function extractVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname === "youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0];
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }
  const v = parsed.searchParams.get("v");
  if (v && VIDEO_ID_RE.test(v)) return v;
  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  const m = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
  if (m && VIDEO_ID_RE.test(m[1])) return m[1];
  return null;
}

// Decode HTML entities (incl. numeric). Applied twice because timedtext
// content is double-encoded (e.g. `&amp;#39;` → `&#39;` → `'`).
function decodeEntitiesOnce(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) =>
      String.fromCodePoint(Number.parseInt(d, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function decodeEntities(s: string): string {
  return decodeEntitiesOnce(decodeEntitiesOnce(s));
}

// Balanced-bracket extraction of the JSON array following `marker` in a blob of
// HTML. More robust than a non-greedy regex against nested arrays/strings.
function extractBalancedArray(html: string, marker: string): string | null {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const open = html.indexOf("[", start);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = open; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return html.slice(open, k + 1);
    }
  }
  return null;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

// Prefer a manual English track; fall back to any English, then any track.
function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  const withUrl = tracks.filter((t) => t.baseUrl);
  return (
    withUrl.find((t) => t.languageCode === "en" && t.kind !== "asr") ??
    withUrl.find((t) => t.languageCode?.startsWith("en")) ??
    withUrl[0]
  );
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title>([^<]*)<\/title>/);
  if (!m) return null;
  return (
    decodeEntities(m[1])
      .replace(/\s*-\s*YouTube\s*$/, "")
      .trim() || null
  );
}

function parseTranscriptXml(xml: string): string {
  const segments: string[] = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null = re.exec(xml);
  while (m !== null) {
    const text = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
    if (text) segments.push(text);
    m = re.exec(xml);
  }
  return segments.join(" ");
}

/**
 * Best-effort YouTube transcript fetch. Returns null (caller falls through to
 * the normal cascade) if the feature is disabled, the URL has no video id, no
 * captions are available, or the unofficial endpoints fail/shape-change.
 */
export async function youtubeFetch(
  url: string,
  maxChars = 8000,
): Promise<TierResult | null> {
  if (!YOUTUBE_TRANSCRIPT_ENABLED) return null;
  const videoId = extractVideoId(url);
  if (!videoId) return null;

  // The transcript lives under /api/timedtext, which YouTube's robots.txt
  // disallows. Respect that unless the operator opted in.
  if (!YOUTUBE_IGNORE_ROBOTS) {
    const robots = await checkRobots(
      `${YOUTUBE_ORIGIN}/api/timedtext`,
      "searxng-mcp",
    );
    if (!robots.allowed) return null;
  }

  try {
    const watchRes = await safeFetch(`${YOUTUBE_ORIGIN}/watch?v=${videoId}`, {
      headers: { "User-Agent": UA, "Accept-Language": "en" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!watchRes.ok) return null;
    const html = await readBoundedText(watchRes);

    const arrJson = extractBalancedArray(html, '"captionTracks":');
    if (!arrJson) return null;
    const tracks = JSON.parse(arrJson) as CaptionTrack[];
    const track = pickCaptionTrack(tracks);
    if (!track?.baseUrl) return null;

    const ttRes = await safeFetch(track.baseUrl, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!ttRes.ok) return null;
    const xml = await readBoundedText(ttRes);
    const transcript = parseTranscriptXml(xml);
    if (!transcript) return null;

    const title = extractTitle(html) ?? url;
    return {
      title,
      url,
      text: `Transcript:\n\n${transcript}`.slice(0, maxChars),
    };
  } catch {
    return null;
  }
}
