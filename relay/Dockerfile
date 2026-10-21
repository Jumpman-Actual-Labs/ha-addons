FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep procps curl \
      pandoc python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages python-docx==1.1.2 openpyxl==3.1.5 python-pptx==1.0.2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY app/ ./

# Credentials, sessions and history live in /data, which survives restarts and updates.
ENV NODE_ENV=production \
    HOME=/data/home \
    CODEX_HOME=/data/home/.codex \
    USE_BUILTIN_RIPGREP=0

CMD ["node", "server.js"]
