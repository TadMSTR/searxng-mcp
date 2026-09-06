FROM python:3.12-slim

# Versions pinned to what the four-week-running deployment resolved to on
# 2026-09-06. The original was unpinned, which is fine for a compose file you
# rebuild yourself and not fine for an image other people pull: an adopter
# pulling this tag a year from now should get the reranker that was tested,
# not whatever FlashRank has since become.
ENV RERANKER_MODEL=ms-marco-MiniLM-L-12-v2 \
    RERANKER_CACHE_DIR=/opt/flashrank \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN pip install --no-cache-dir \
      fastapi==0.141.1 \
      "uvicorn[standard]==0.52.4" \
      FlashRank==0.2.10

COPY main.py .

# Bake the model into the image (~100MB) rather than downloading it on first
# start. The cold start it removes is 30-60s during which the reranker is
# absent and results quietly fall back to SearXNG's own ordering behind a
# single throttled log line — a silent quality regression on every fresh boot,
# which is the failure shape this repo keeps finding elsewhere. It also drops
# a runtime network dependency, so the container works on an air-gapped host.
#
# RERANKER_CACHE_DIR is read here and by main.py, so the baked path and the
# loaded path cannot drift. Baking into FlashRank's /tmp default would be
# undone by any runtime that mounts a tmpfs over /tmp.
RUN python -c "import os; from flashrank import Ranker; \
      Ranker(model_name=os.environ['RERANKER_MODEL'], cache_dir=os.environ['RERANKER_CACHE_DIR'])"

# Unprivileged at runtime. The model directory is read-only to this user by
# design — everything it needs was baked above, so a write attempt here would
# mean the pre-bake had silently missed.
RUN useradd --system --uid 10001 --no-create-home reranker \
    && chown -R root:root "$RERANKER_CACHE_DIR" \
    && chmod -R a+rX "$RERANKER_CACHE_DIR"
USER 10001

EXPOSE 8787
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8787"]
