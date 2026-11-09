/**
 * HTTP listener for the Linear surface.
 *
 *   GET  /health           → 200 (load balancer health check)
 *   POST /webhooks/linear  → verify signature, reply 200, then handle async
 *
 * Linear expects a 200 within 5 seconds and retries otherwise, so the event is
 * handed off without waiting for the agent. Everything else is a 404.
 */
import http from "node:http";
import { verifyLinearWebhook } from "./webhook.js";

export const WEBHOOK_PATH = "/webhooks/linear";
export const HEALTH_PATH = "/health";
/** Agent session payloads are small; anything near this is not from Linear. */
export const MAX_BODY_BYTES = 1024 * 1024;
const DELIVERY_ID_LIMIT = 1000;

export interface LinearServerOpts {
  webhookSecret: string;
  onEvent: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function reply(res: http.ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

export function createLinearServer(opts: LinearServerOpts): http.Server {
  const now = opts.now ?? Date.now;
  const deliveries = new Set<string>();

  const rememberDelivery = (id: string): boolean => {
    if (deliveries.has(id)) return false;
    deliveries.add(id);
    if (deliveries.size > DELIVERY_ID_LIMIT) {
      const oldest = deliveries.values().next().value;
      if (oldest !== undefined) deliveries.delete(oldest);
    }
    return true;
  };

  return http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === HEALTH_PATH && (req.method === "GET" || req.method === "HEAD")) {
      reply(res, 200, "ok");
      return;
    }
    if (path !== WEBHOOK_PATH) {
      reply(res, 404);
      return;
    }
    if (req.method !== "POST") {
      reply(res, 405);
      return;
    }

    readBody(req, MAX_BODY_BYTES).then(
      (raw) => {
        const signature = req.headers["linear-signature"];
        const result = verifyLinearWebhook(
          raw,
          Array.isArray(signature) ? signature[0] : signature,
          opts.webhookSecret,
          now(),
        );
        if (!result.ok) {
          // Never log the body: it carries issue and comment content.
          console.warn(`[linear] Rejected webhook: ${result.reason}`);
          reply(res, 401);
          return;
        }

        reply(res, 200, "ok");

        const delivery = req.headers["linear-delivery"];
        const deliveryId = Array.isArray(delivery) ? delivery[0] : delivery;
        if (deliveryId && !rememberDelivery(deliveryId)) return;

        setImmediate(() => opts.onEvent(result.payload));
      },
      (err) => {
        if (err instanceof BodyTooLarge) {
          reply(res, 413);
          return;
        }
        console.warn("[linear] Failed to read webhook body:", err instanceof Error ? err.message : err);
        if (!res.headersSent) reply(res, 400);
      },
    );
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
