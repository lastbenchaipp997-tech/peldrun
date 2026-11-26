# syntax=docker/dockerfile:1
# PELDRUN backend (FastAPI). Build context: repository root.
#   docker build -f docker/backend.Dockerfile -t peldrun-backend .
#   --build-arg INSTALL_BROWSERS=0   skip Chromium (much smaller; the browser tool will not work)
FROM python:3.12-slim-bookworm

ARG INSTALL_BROWSERS=1
ARG TARGETARCH

ENV PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PELDRUN_STORAGE_ROOT=/data/storage

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Exact, hash-checked versions (same lock files the desktop app uses).
COPY desktop/locks/linux-x64.txt desktop/locks/linux-arm64.txt /tmp/locks/
RUN case "$TARGETARCH" in \
      amd64) LOCK=linux-x64 ;; \
      arm64) LOCK=linux-arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && pip install --require-hashes --no-deps -r "/tmp/locks/$LOCK.txt"

# Chromium + its system libraries (version follows the pinned playwright package).
RUN if [ "$INSTALL_BROWSERS" = "1" ]; then playwright install --with-deps chromium; fi

WORKDIR /app
COPY backend /app/backend
COPY config /app/config

# Never bake credentials from the repository's config into an image.
RUN sed -Ei 's/^(\s*[A-Za-z0-9_.-]*(api_key|apikey|token|secret|password|access_key)[A-Za-z0-9_.-]*\s*=\s*)"[^"]+"/\1""/I' /app/config/*.toml 2>/dev/null || true

RUN useradd --create-home --uid 10001 peldrun \
 && mkdir -p /data/storage /ms-playwright \
 && chown -R peldrun:peldrun /app /data /ms-playwright
USER peldrun

WORKDIR /app/backend
EXPOSE 8088
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8088/api/health', timeout=4).status == 200 else 1)"

CMD ["python", "-c", "import uvicorn; uvicorn.run('omweb.main:app', host='0.0.0.0', port=8088, reload=False)"]
