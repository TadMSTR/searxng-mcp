# searxng-mcp documentation

The [README](../README.md) covers what searxng-mcp is and how to get it running. Everything
past that point lives here.

| Document | What is in it |
|----------|---------------|
| [Configuration](configuration.md) | Every environment variable, and the setup for each optional backing service (SearXNG, reranker, Firecrawl, Crawl4AI, Kiwix, Hister, Valkey, Ollama). |
| [Tools](tools.md) | Full per-tool parameter reference for all seven MCP tools, plus GitHub URL handling. |
| [Deployment](deployment.md) | Install from npm or source, stdio and HTTP transports, HTTP authentication, and MCP client recipes for Claude Code, Claude Desktop and LibreChat. |
| [Architecture](architecture.md) | The fetch cascade and tier semantics, adblocking, data-driven tier routing, the domain capability database, every fast path, resilience, and observability. |
| [Reranker](../docker/reranker/README.md) | The bundled CPU-only reranking service: the `/v1/rerank` contract, the model, why it is baked into the image, and how to run or pull it. |
| [Security](security.md) | SSRF handling, redirect protection, transport exposure, bounded reads, dependency auditing, credential handling and input validation. Vulnerability reporting is in [`SECURITY.md`](../SECURITY.md). |

## Where to start

- **Running it for the first time:** the README's Quick Start, then [Configuration](configuration.md).
- **Wiring it into a client:** [Deployment](deployment.md).
- **Working out why a fetch returned what it did:** [Architecture](architecture.md) — the tier
  cascade and the domain capability database are the two things that decide it.
- **Reviewing it before deploying:** [Security](security.md).
