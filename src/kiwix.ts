import { KIWIX_URL } from "./config.js";
import { runReadability } from "./extractors/readability.js";
import type { TierResult } from "./fetch-utils.js";

// Hostnames served by Kiwix, mapped to stable ZIM book names.
// Book names are stable because kiwix-serve runs with --nodatealiases (-z),
// which strips date suffixes from ZIM filenames.
const KIWIX_HOST_PREFIXES: Record<string, string> = {
  "en.wikipedia.org": "wikipedia_en_all_mini",
  "wikipedia.org": "wikipedia_en_all_mini",
  "stackoverflow.com": "stackoverflow.com_en_all",
  "wiki.archlinux.org": "archlinux.wiki_en_all",
};

export function isKiwixHost(url: string): boolean {
  if (!KIWIX_URL) return false;
  try {
    const { hostname } = new URL(url);
    return hostname in KIWIX_HOST_PREFIXES;
  } catch {
    return false;
  }
}

export async function kiwixFetch(
  url: string,
  maxChars = 8000,
): Promise<TierResult | null> {
  if (!KIWIX_URL) return null;
  try {
    const parsed = new URL(url);
    const bookName = KIWIX_HOST_PREFIXES[parsed.hostname];
    if (!bookName) return null;

    // Path mapping:
    //   Wikipedia:  /wiki/<Title>    → /content/<book>/A/<Title>
    //   Arch Wiki:  /title/<Title>   → /content/<book>/A/<Title>
    //   Stack Overflow: /questions/<id>/<slug> → /content/<book>/A/Questions/<id>
    //   (SO path structure in the ZIM differs — strip leading segment and use as-is)
    const articlePath = parsed.pathname.replace(/^\/(wiki|title)\//, "");
    const kiwixUrl = `${KIWIX_URL}/content/${bookName}/A/${articlePath}`;

    const resp = await fetch(kiwixUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;

    const html = await resp.text();
    if (!html) return null;

    const readable = runReadability(html, url);
    if (!readable?.text) return null;

    return {
      title: readable.title ?? url,
      url,
      text: readable.text.slice(0, maxChars),
      html,
    };
  } catch {
    return null;
  }
}
