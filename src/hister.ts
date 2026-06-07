import { HISTER_TOKEN, HISTER_URL } from "./config.js";
import type { TierResult } from "./fetch-utils.js";

/**
 * Fetch page content from the Hister browsing-history index via its MCP endpoint.
 *
 * Uses the `url:` field filter to find an exact URL match — pages that Ted's Firefox
 * extension has already indexed. Returns null if Hister is not configured, the URL is
 * not in the index, or the call fails for any reason.
 */
export async function histerFetch(
  url: string,
  maxChars = 8000,
): Promise<TierResult | null> {
  if (!HISTER_URL || !HISTER_TOKEN) return null;
  try {
    const resp = await fetch(`${HISTER_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HISTER_TOKEN}`,
        Origin: "hister://",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search",
          arguments: {
            query: `url:${url}`,
            fields: ["text"],
            limit: 1,
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      jsonrpc: string;
      id: number;
      result?: { content?: Array<{ type: string; text: string }> };
      error?: unknown;
    };

    if (data.error || !data.result?.content?.length) return null;

    const content = data.result.content.find((c) => c.type === "text");
    if (!content?.text || !content.text.startsWith("Found")) return null;

    const raw = content.text;

    // Verify the returned URL is an exact match — url: filter should guarantee
    // this, but check explicitly to avoid serving a different page's content.
    const urlMatch = raw.match(/^\s*URL:\s*(.+)$/m);
    if (!urlMatch || urlMatch[1].trim() !== url) return null;

    // Title is the first numbered result line: "1. <title>"
    const titleMatch = raw.match(/^1\.\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : url;

    // Text follows the "   Text: " marker and runs to end of response.
    const textStart = raw.indexOf("\n   Text: ");
    if (textStart === -1) return null;
    const text = raw.slice(textStart + "\n   Text: ".length).trim();

    if (!text) return null;

    return {
      title,
      url,
      text: text.slice(0, maxChars),
    };
  } catch {
    return null;
  }
}
