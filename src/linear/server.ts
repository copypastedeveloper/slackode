/**
 * HTTP listener for Linear: GET /health for the load balancer, and
 * POST /webhooks/linear. Linear wants a 200 within 5 seconds, so a verified
 * event is acknowledged first and handled afterwards.
 */
import http from "node:http";
import { verifyLinearWebhook } from "./webhook.js";

export const WEBHOOK_PATH = "/webhooks/linear";
const MAX_BODY_BYTES = 1024 * 1024;

function reply(res: http.ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

export function createLinearServer(opts: {
  webhookSecret: string;
  onEvent: (payload: Record<string, unknown>) => void;
}): http.Server {
  return http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health" && req.method === "GET") return reply(res, 200, "ok");
    if (path !== WEBHOOK_PATH || req.method !== "POST") return reply(res, 404);

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(res, 413);
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (res.headersSent) return;
      const signature = req.headers["linear-signature"];
      const result = verifyLinearWebhook(
        Buffer.concat(chunks),
        Array.isArray(signature) ? signature[0] : signature,
        opts.webhookSecret,
      );
      if (!result.ok) {
        // Never log the body: it carries issue and comment content.
        console.warn(`[linear] Rejected webhook: ${result.reason}`);
        return reply(res, 401);
      }
      reply(res, 200, "ok");
      setImmediate(() => opts.onEvent(result.payload));
    });
  });
}

export function listen(server: http.Server, port: number, host = "0.0.0.0"): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
