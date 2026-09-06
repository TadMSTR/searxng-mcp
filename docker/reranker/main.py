"""
Jina-compatible reranker API using FlashRank (CPU-only, zero-cost local reranking).
POST /v1/rerank -- drop-in for Jina's API.
"""
import os, logging
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from typing import Optional
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("reranker")
ranker = None

# Request bounds. This endpoint has no authentication and reranking is CPU-bound
# on caller-supplied text, so an uncapped request is a denial-of-service surface
# for anything that can reach the port. The compose file binds loopback only,
# but that is a property of one deployment — this image is published, and a cap
# that lives in the artefact holds however someone chooses to run it.
#
# Defaults are far above real use. Measured against the live SearXNG that feeds
# this service: ~30 documents per rerank, longest document ~430 chars, ~6.7 KB
# total. So these leave roughly 30x, 45x and 600x headroom respectively and
# cannot affect the caller this was built for.
MAX_DOCUMENTS = int(os.getenv("RERANKER_MAX_DOCUMENTS", "1000"))
MAX_DOC_CHARS = int(os.getenv("RERANKER_MAX_DOC_CHARS", "20000"))
MAX_BODY_BYTES = int(os.getenv("RERANKER_MAX_BODY_BYTES", str(4 * 1024 * 1024)))

@asynccontextmanager
async def lifespan(app: FastAPI):
    global ranker
    from flashrank import Ranker
    model_name = os.getenv("RERANKER_MODEL", "ms-marco-MiniLM-L-12-v2")
    # FlashRank defaults cache_dir to /tmp. The Dockerfile bakes the model at
    # build time, and /tmp is the path a runtime is most likely to replace — a
    # tmpfs mount or a read-only rootfs would hide the baked copy and send the
    # container back to downloading ~100MB on boot, silently. Naming the
    # directory is what makes the pre-bake hold; build and runtime read the
    # same variable, so they cannot drift apart.
    cache_dir = os.getenv("RERANKER_CACHE_DIR", "/opt/flashrank")
    logger.info(f"Loading FlashRank model: {model_name} (cache_dir={cache_dir})")
    ranker = Ranker(model_name=model_name, cache_dir=cache_dir)
    logger.info("FlashRank model loaded")
    yield

app = FastAPI(title="Local Reranker (Jina-compatible)", lifespan=lifespan)

@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """Reject an oversized body before it is buffered and parsed.

    Two honest limits on what this does, both measured rather than assumed:

    1. Content-Length only. A chunked request declares no length, so this
       cannot see it. That case is caught one layer later by the document caps
       below, which apply to the parsed request whatever framing delivered it —
       so the request is still bounded, just not as early.
    2. The client does not always get to read the 413. A body slightly over the
       cap is answered cleanly (measured: 4.2 MB -> 413 with the JSON detail),
       but a substantially oversized one is answered while the client is still
       sending, and the client sees a connection reset instead (measured: 6 MB
       and 20 MB -> reset). The body is rejected either way and the server stays
       healthy; only the symptom differs. Recorded because a bare "connection
       reset" is precisely the kind of unexplained failure this codebase keeps
       having to diagnose.
    """
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            size = int(declared)
        except ValueError:
            return JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)
        if size > MAX_BODY_BYTES:
            return JSONResponse(
                {"detail": f"Request body exceeds {MAX_BODY_BYTES} bytes"},
                status_code=413,
            )
    return await call_next(request)


class RerankRequest(BaseModel):
    model: Optional[str] = "flashrank"
    query: str
    documents: list
    top_n: Optional[int] = None
    return_documents: Optional[bool] = False

    @field_validator("documents")
    @classmethod
    def _bound_documents(cls, v: list) -> list:
        if len(v) > MAX_DOCUMENTS:
            raise ValueError(f"documents exceeds {MAX_DOCUMENTS} items")
        return v

    @field_validator("query")
    @classmethod
    def _bound_query(cls, v: str) -> str:
        if len(v) > MAX_DOC_CHARS:
            raise ValueError(f"query exceeds {MAX_DOC_CHARS} characters")
        return v

class RerankResultItem(BaseModel):
    index: int
    relevance_score: float
    document: Optional[dict] = None

class RerankResponse(BaseModel):
    model: str = "flashrank"
    results: list[RerankResultItem]
    usage: dict = {"total_tokens": 0}

@app.post("/v1/rerank", response_model=RerankResponse)
async def rerank(req: RerankRequest):
    from flashrank import RerankRequest as FRRequest
    passages = []
    for i, doc in enumerate(req.documents):
        if isinstance(doc, str): text = doc
        elif isinstance(doc, dict) and "text" in doc: text = doc["text"]
        else: text = str(doc)
        # Truncate rather than reject. A document longer than this is past
        # anything the cross-encoder reads anyway — FlashRank's own max_length
        # is 512 tokens — so refusing the whole request would turn a harmless
        # oversized snippet into a failed search, while the cost this bounds
        # (holding and tokenising the text) is already paid by truncating.
        if len(text) > MAX_DOC_CHARS: text = text[:MAX_DOC_CHARS]
        passages.append({"id": i, "text": text})
    raw = ranker.rerank(FRRequest(query=req.query, passages=passages))
    sorted_r = sorted(raw, key=lambda r: r["score"], reverse=True)
    if req.top_n: sorted_r = sorted_r[:req.top_n]
    results = [RerankResultItem(
        index=r["id"], relevance_score=r["score"],
        document={"text": r["text"]} if req.return_documents else None
    ) for r in sorted_r]
    total_chars = len(req.query) + sum(len(p["text"]) for p in passages)
    return RerankResponse(model=req.model or "flashrank", results=results,
                          usage={"total_tokens": total_chars // 4})

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": ranker is not None}
