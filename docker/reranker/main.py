"""
Jina-compatible reranker API using FlashRank (CPU-only, zero-cost local reranking).
POST /v1/rerank -- drop-in for Jina's API.
"""
import os, logging
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("reranker")
ranker = None

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

class RerankRequest(BaseModel):
    model: Optional[str] = "flashrank"
    query: str
    documents: list
    top_n: Optional[int] = None
    return_documents: Optional[bool] = False

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
        if isinstance(doc, str): passages.append({"id": i, "text": doc})
        elif isinstance(doc, dict) and "text" in doc: passages.append({"id": i, "text": doc["text"]})
        else: passages.append({"id": i, "text": str(doc)})
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
