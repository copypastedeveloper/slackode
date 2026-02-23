# Build stage
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Runtime stage
FROM node:22-slim
RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai

# Create non-root user
RUN useradd -m -s /bin/bash appuser

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json opencode.json entrypoint.sh ./
COPY .opencode/ .opencode/
RUN chmod +x entrypoint.sh

# Create directories the app needs and give appuser ownership
RUN mkdir -p /app/repo /app/data /home/appuser/.local/share/opencode \
    && chown -R appuser:appuser /app /home/appuser

USER appuser
CMD ["./entrypoint.sh"]
