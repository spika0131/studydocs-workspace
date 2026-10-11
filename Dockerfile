FROM python:3.12-slim

WORKDIR /app

# Install system ffmpeg and Deno JS runtime (used by yt-dlp EJS challenge solver)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    unzip \
    ca-certificates \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && rm -rf /var/lib/apt/lists/*

# Ensure writable cache directory for non-root containers (e.g. Hugging Face Spaces UID 1000)
ENV HOME=/tmp
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade -r requirements.txt

COPY server.py .
COPY static ./static

RUN chmod -R 777 /app

# Default to 7860 for Hugging Face Spaces; Render/Railway override $PORT automatically
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-7860}"]
