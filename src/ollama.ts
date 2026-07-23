import {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_DISABLE_THINKING,
  LLM_MODEL,
  OLLAMA_API_KEY,
  OLLAMA_EXPAND_MODEL,
  OLLAMA_SUMMARIZE_MODEL,
  OLLAMA_URL,
} from "./config.js";
import { logThrottled } from "./log.js";
import type {
  Citation,
  OllamaChatResponse,
  OllamaGenerateResponse,
  SummaryResult,
} from "./types.js";

type ChatMessage = { role: string; content: string };

// F-01 (security audit, PR #15/#16): LLM_API_KEY over a plain-http
// LLM_BASE_URL transmits the bearer token in cleartext. Not a merge
// blocker — many LLM_BASE_URL deployments are on a trusted internal
// network — but worth a loud one-time warning so it's a deliberate choice.
let warnedCleartextLlmCredential = false;

function warnIfCleartextLlmCredential(): void {
  if (warnedCleartextLlmCredential) return;
  if (LLM_API_KEY && LLM_BASE_URL.startsWith("http://")) {
    warnedCleartextLlmCredential = true;
    console.error(
      `[searxng-mcp] LLM_API_KEY is set with a plain-http LLM_BASE_URL ("${LLM_BASE_URL}") — the bearer token will transmit in cleartext. Use an https:// LLM_BASE_URL, or confirm this is an internal/trusted network.`,
    );
  }
}

/**
 * Run a chat completion and return the assistant text.
 *
 * Prefers an OpenAI-compatible endpoint (`LLM_BASE_URL`) so an already-loaded
 * vLLM / llama.cpp / LM Studio model can be reused; otherwise falls back to the
 * Ollama `/api/chat` endpoint. Both suppress reasoning traces.
 */
async function llmChat(
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<string> {
  if (LLM_BASE_URL) {
    warnIfCleartextLlmCredential();
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LLM_API_KEY && { Authorization: `Bearer ${LLM_API_KEY}` }),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: 0.2,
        ...(LLM_DISABLE_THINKING
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`LLM error: ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  }
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(OLLAMA_API_KEY && { Authorization: `Bearer ${OLLAMA_API_KEY}` }),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { think: false },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = (await res.json()) as OllamaChatResponse;
  return data.message.content;
}

export async function expandQuery(query: string): Promise<string[]> {
  if (!OLLAMA_URL && !LLM_BASE_URL) return [];
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
    let text: string;
    if (LLM_BASE_URL) {
      text = await llmChat(
        LLM_MODEL || OLLAMA_EXPAND_MODEL,
        [{ role: "user", content: prompt }],
        12000,
      );
    } else {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(OLLAMA_API_KEY && { Authorization: `Bearer ${OLLAMA_API_KEY}` }),
        },
        body: JSON.stringify({
          model: OLLAMA_EXPAND_MODEL,
          prompt,
          stream: false,
          options: { think: false },
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
      text = ((await res.json()) as OllamaGenerateResponse).response;
    }
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== query)
      .slice(0, 3);
  } catch (err) {
    // Timeout, connection refused, or any error — fall back to original query.
    logThrottled(
      "degrade:ollama-expand",
      `query expansion unavailable — searching the original query only: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export async function summarizePages(
  query: string,
  pages: Array<{ title: string; url: string; text: string }>,
): Promise<SummaryResult> {
  if (!OLLAMA_URL && !LLM_BASE_URL) return { summary: "", citations: [] };
  if (pages.length === 0) {
    return { summary: "No content to summarize.", citations: [] };
  }

  const MAX_CHARS_PER_PAGE = 4000;
  const pageBlocks = pages
    .map(
      (p, i) =>
        `[Source ${i + 1}] ${p.title}\nURL: ${p.url}\n\n${p.text.slice(0, MAX_CHARS_PER_PAGE)}`,
    )
    .join("\n\n---\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a research assistant. Synthesize the provided sources to answer the query. " +
        "Respond with JSON only, no markdown fences, matching this exact schema: " +
        '{"summary":"<synthesized answer>","citations":[{"url":"<url>","title":"<title>","key_facts":["<fact>"]}]} ' +
        "Include only sources that contributed to the answer. key_facts: 1-3 short phrases per source.",
    },
    {
      role: "user",
      content: `Query: ${query}\n\nSources:\n${pageBlocks}`,
    },
  ];

  try {
    const content = await llmChat(
      LLM_MODEL || OLLAMA_SUMMARIZE_MODEL,
      messages,
      45000,
    );
    const raw = (content.match(/\{[\s\S]*\}/) ?? [content])[0];
    // The model controls this JSON, so treat it as untrusted and normalize
    // each citation to the Citation contract here — the trust boundary. A
    // model may return a citation without `key_facts` (or url/title), which
    // previously reached formatSummaryResult and crashed it on
    // `c.key_facts.map(...)`.
    const parsed = JSON.parse(raw) as {
      summary?: unknown;
      citations?: unknown;
    };
    const citations: Citation[] = Array.isArray(parsed.citations)
      ? parsed.citations.map((c): Citation => {
          const entry = (c ?? {}) as {
            url?: unknown;
            title?: unknown;
            key_facts?: unknown;
          };
          const url = typeof entry.url === "string" ? entry.url : "";
          return {
            url,
            title: typeof entry.title === "string" ? entry.title : url,
            key_facts: Array.isArray(entry.key_facts)
              ? entry.key_facts.filter(
                  (f): f is string => typeof f === "string",
                )
              : [],
          };
        })
      : [];
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      citations,
    };
  } catch (err) {
    // Ollama unavailable, timeout, or parse error — signal fallback to raw pages.
    logThrottled(
      "degrade:ollama-summarize",
      `summarization unavailable — returning raw pages instead of a synthesis: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { summary: "", citations: [] };
  }
}

export function formatSummaryResult(result: SummaryResult): string {
  if (!result.summary) return "";
  const citationText = (result.citations ?? [])
    .map((c: Citation) => {
      const facts = (Array.isArray(c.key_facts) ? c.key_facts : [])
        .map((f) => `     - ${f}`)
        .join("\n");
      return `  - ${c.title}\n    URL: ${c.url}\n${facts}`;
    })
    .join("\n\n");
  return `## Summary\n\n${result.summary}\n\n## Sources\n\n${citationText}`;
}
