# searxng-mcp reranker

A small CPU-only reranking service. searxng-mcp sends it a query and a list of
search-result snippets; it returns them reordered by relevance.

This is the component that separates searxng-mcp from a plain SearXNG wrapper,
and until v3.25.0 it was the one component an adopter could not obtain — the
docs pointed at a compose file in another repository whose `build: .` had no
`Dockerfile` beside it (vikunja#692). It now lives here.

## Run it

```bash
docker compose up          # from this directory
```

Or pull the published image instead of building:

```bash
docker run -d -p 127.0.0.1:8787:8787 ghcr.io/tadmstr/searxng-mcp-reranker:latest
```

Then point searxng-mcp at it:

```bash
RERANKER_URL=http://localhost:8787     # this is already the default
```

Nothing else is required. There is no API key, no GPU, and no external service.

## The contract

`POST /v1/rerank` — Jina-compatible, so anything that speaks Jina's reranking
API can talk to it.

```jsonc
// request
{
  "query": "how do I train a dog",
  "documents": ["Bananas are a yellow fruit.", "Puppy obedience training uses ..."],
  "top_n": 5,               // optional, truncates the result list
  "return_documents": false // optional, echoes the text back
}
```

```jsonc
// response — sorted by relevance_score, descending
{
  "model": "flashrank",
  "results": [
    { "index": 1, "relevance_score": 0.9633, "document": null },
    { "index": 0, "relevance_score": 0.0000, "document": null }
  ],
  "usage": { "total_tokens": 39 }
}
```

`index` refers to the position in the request's `documents` array, so the
caller can map scores back to its own objects. `usage.total_tokens` is a rough
character-count estimate, present for API compatibility — nothing is billed.

`documents` accepts plain strings or objects with a `text` key; anything else
is stringified.

`GET /health` returns `{"status": "ok", "model_loaded": true}`. Prefer
`model_loaded` over the bare status: it is the field that distinguishes a
container that is serving from one that is up but reranking nothing.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `RERANKER_MODEL` | `ms-marco-MiniLM-L-12-v2` | Any FlashRank model name. Changing it discards the pre-baked model — see below. |
| `RERANKER_CACHE_DIR` | `/opt/flashrank` | Where the model lives. Read at build *and* run time. |
| `RERANKER_MAX_DOCUMENTS` | `1000` | Requests with more documents are rejected with 422. |
| `RERANKER_MAX_DOC_CHARS` | `20000` | Longer documents are **truncated**, not rejected. Also caps `query` length, which *is* rejected. |
| `RERANKER_MAX_BODY_BYTES` | `4194304` (4 MB) | Bodies over this are rejected with 413. |

### Request bounds

The defaults are far above real use and exist for the deployment you have not
thought about yet. Measured against the SearXNG that feeds this service: ~30
documents per rerank, longest document ~430 characters, ~6.7 KB total — so the
caps leave roughly 30×, 45× and 600× headroom and cannot affect normal traffic.

Oversized *documents* are truncated rather than refused, because anything past
this length is already beyond what the cross-encoder reads (FlashRank's
`max_length` is 512 tokens) and refusing would turn a harmless long snippet
into a failed search.

Two things the body cap does not do, stated because "there is a size limit"
reads as stronger than it is:

- It reads `Content-Length`, so a **chunked** request slips past it. Such a
  request is still bounded by the document caps once parsed — later, not never.
- A body **substantially** over the cap is answered while the client is still
  sending, so the client sees a connection reset rather than the 413. A body
  slightly over gets a clean 413. Either way the request is rejected without
  being processed.

## The model is baked into the image

The default model (~100 MB) is downloaded at build time, not on first start.

This is deliberate. With a first-run download, a fresh boot leaves the reranker
absent for 30–60 seconds, during which searxng-mcp degrades to SearXNG's own
result ordering behind a single throttled log line — results get quietly worse
and nothing says so. Baking costs image size and buys a container that is
ready in about two seconds and needs no network to start at all.

Verified: the image starts and serves under `docker run --network none`.

Two consequences worth knowing:

- **Setting `RERANKER_MODEL` to something else re-introduces the download.**
  Only the default model is baked. A different model will be fetched on first
  start, with the cold start and the network dependency that implies.
- **`RERANKER_CACHE_DIR` is read by both the build and the app**, so they
  cannot drift. Do not point it at `/tmp` — that is FlashRank's own default
  and is exactly the path a runtime is most likely to replace with a tmpfs,
  which would hide the baked model and silently restore the download.

## Security

**There is no authentication.** Any caller that can reach the port can submit
arbitrary text and consume CPU. The compose file publishes on `127.0.0.1` only,
and that is not incidental — do not move it to `0.0.0.0` without putting
something in front of it.

The container runs as an unprivileged user (uid 10001) and the model directory
is read-only to it. Python dependencies are pinned so that pulling this tag
later gives the versions it was tested with.

## Cost

Zero. It is a CPU cross-encoder — no API key, no per-request charge, no
external call. Reranking a page of results takes tens of milliseconds.
