import { OLLAMA_URL } from "./config.js";
import type { OllamaGenerateResponse, OllamaChatResponse, Citation, SummaryResult } from "./types.js";

export async function expandQuery(query: string): Promise<string[]> {
  if (!OLLAMA_URL) return [];
  const prompt =
    `Generate 2-3 search query variants for the query below. ` +
    `Output ONLY the variant queries, one per line. No numbering, no explanations, no extra text.\n\n` +
    `Original query: ${query}\n\n` +
    `Variant types:\n` +
    `- Technical rephrasing: use precise technical terms\n` +
    `- Product/specific: include product names or version numbers if applicable\n` +
    `- Community: how someone would phrase it in a forum or community\n\n` +
    `Output 2 or 3 variants only:`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3:4b",
        prompt,
        stream: false,
        options: { think: false },
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

    const data = (await res.json()) as OllamaGenerateResponse;
    return data.response
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== query)
      .slice(0, 3);
  } catch {
    // Timeout, connection refused, or any error — fall back to original query
    return [];
  }
}

export async function summarizePages(
  query: string,
  pages: Array<{ title: string; url: string; text: string }>
): Promise<SummaryResult> {
  if (!OLLAMA_URL) return { summary: "", citations: [] };
  if (pages.length === 0) {
    return { summary: "No content to summarize.", citations: [] };
  }

  const MAX_CHARS_PER_PAGE = 4000;
  const pageBlocks = pages
    .map((p, i) =>
      `[Source ${i + 1}] ${p.title}\nURL: ${p.url}\n\n${p.text.slice(0, MAX_CHARS_PER_PAGE)}`
    )
    .join("\n\n---\n\n");

  const prompt =
    `You are a research assistant. Synthesize the sources below to answer the query.\n\n` +
    `Query: ${query}\n\n` +
    `Sources:\n${pageBlocks}\n\n` +
    `Respond with JSON only, no markdown fences, matching this exact schema:\n` +
    `{"summary":"<synthesized answer>","citations":[{"url":"<url>","title":"<title>","key_facts":["<fact>"]}]}\n` +
    `Include only sources that contributed to the answer. key_facts: 1-3 short phrases per source.`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3:14b",
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { think: false },
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

    const data = (await res.json()) as OllamaChatResponse;
    const raw = (data.message.content.match(/\{[\s\S]*\}/) ?? [data.message.content])[0];
    const parsed = JSON.parse(raw) as SummaryResult;
    return {
      summary: parsed.summary ?? "",
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    };
  } catch {
    // Ollama unavailable, timeout, or parse error — return null to signal fallback
    return { summary: "", citations: [] };
  }
}

export function formatSummaryResult(result: SummaryResult): string {
  if (!result.summary) return "";
  const citationText = result.citations
    .map((c: Citation) => {
      const facts = c.key_facts.map((f) => `     - ${f}`).join("\n");
      return `  - ${c.title}\n    URL: ${c.url}\n${facts}`;
    })
    .join("\n\n");
  return `## Summary\n\n${result.summary}\n\n## Sources\n\n${citationText}`;
}
