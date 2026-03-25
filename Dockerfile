# Build stage
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN npm audit --omit=dev
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Runtime stage
FROM node:22-slim
RUN apt-get update && apt-get install -y curl git python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && mv /root/.local/bin/uvx /usr/local/bin/uvx \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai

# Create non-root user
RUN useradd -m -s /bin/bash appuser

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json opencode.json tools.json entrypoint.sh ./
COPY .opencode/ .opencode/
RUN chmod +x entrypoint.sh

# Create directories the app needs and give appuser ownership
RUN mkdir -p /app/repo /app/repos /app/knowledge /home/appuser/.local/share/opencode \
    && chown -R appuser:appuser /app /home/appuser

# Pre-download the embedding model so there's no first-use latency
RUN node -e "const{pipeline}=require('@huggingface/transformers');pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2').then(()=>console.log('Model cached'))"

USER appuser
CMD ["./entrypoint.sh"]
