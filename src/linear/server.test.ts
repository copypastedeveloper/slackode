import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createLinearServer, listen } from "./server.js";

const SECRET = "server-test-secret";

async function withServer(fn: (base: string, events: unknown[]) => Promise<void>): Promise<void> {
  const events: unknown[] = [];
  const server = createLinearServer({ webhookSecret: SECRET, onEvent: (p) => events.push(p) });
  await listen(server, 0, "127.0.0.1");
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, events);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const tick = () => new Promise((r) => setImmediate(r));

test("serves /health, and rejects unknown paths and unsigned webhooks", async () => {
  await withServer(async (base, events) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/other`)).status, 404);
    const unsigned = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      body: JSON.stringify({ webhookTimestamp: Date.now() }),
    });
    assert.equal(unsigned.status, 401);
    await tick();
    assert.equal(events.length, 0);
  });
});

test("a signed webhook gets 200 and is handed off once per delivery", async () => {
  await withServer(async (base, events) => {
    const raw = JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: Date.now() });
    const request = {
      method: "POST",
      headers: {
        "Linear-Signature": crypto.createHmac("sha256", SECRET).update(raw).digest("hex"),
        "Linear-Delivery": "delivery-1",
      },
      body: raw,
    };
    assert.equal((await fetch(`${base}/webhooks/linear`, request)).status, 200);
    assert.equal((await fetch(`${base}/webhooks/linear`, request)).status, 200);
    await tick();
    assert.equal(events.length, 1);
  });
});
