import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createLinearServer, listen, MAX_BODY_BYTES } from "./server.js";

const SECRET = "server-test-secret";

async function withServer(
  fn: (base: string, events: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const events: Array<Record<string, unknown>> = [];
  const server = createLinearServer({ webhookSecret: SECRET, onEvent: (p) => events.push(p) });
  await listen(server, 0, "127.0.0.1");
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, events);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function signedRequest(payload: Record<string, unknown>, delivery?: string): RequestInit {
  const raw = JSON.stringify({ webhookTimestamp: Date.now(), ...payload });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Linear-Signature": crypto.createHmac("sha256", SECRET).update(raw).digest("hex"),
  };
  if (delivery) headers["Linear-Delivery"] = delivery;
  return { method: "POST", headers, body: raw };
}

const tick = () => new Promise((r) => setImmediate(r));

test("GET /health returns 200", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });
});

test("unknown paths and methods are rejected", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/webhooks/other`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/webhooks/linear`)).status, 405);
  });
});

test("an unsigned webhook gets 401 and is not handed off", async () => {
  await withServer(async (base, events) => {
    const res = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      body: JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: Date.now() }),
    });
    assert.equal(res.status, 401);
    await tick();
    assert.equal(events.length, 0);
  });
});

test("a signed webhook gets 200 and is handed off once per delivery", async () => {
  await withServer(async (base, events) => {
    const first = await fetch(`${base}/webhooks/linear`, signedRequest({ type: "AgentSessionEvent" }, "delivery-1"));
    assert.equal(first.status, 200);
    const retry = await fetch(`${base}/webhooks/linear`, signedRequest({ type: "AgentSessionEvent" }, "delivery-1"));
    assert.equal(retry.status, 200);
    await tick();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "AgentSessionEvent");
  });
});

test("an oversized body is rejected with 413", async () => {
  await withServer(async (base, events) => {
    const res = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    assert.equal(res.status, 413);
    await tick();
    assert.equal(events.length, 0);
  });
});
