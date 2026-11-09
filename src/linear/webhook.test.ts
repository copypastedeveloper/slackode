import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyLinearWebhook, MAX_WEBHOOK_SKEW_MS } from "./webhook.js";

const SECRET = "test-signing-secret";
const NOW = 1_800_000_000_000;

function sign(body: Buffer, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function body(fields: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ type: "AgentSessionEvent", action: "created", webhookTimestamp: NOW, ...fields }));
}

test("accepts a correctly signed, fresh payload", () => {
  const raw = body();
  const result = verifyLinearWebhook(raw, sign(raw), SECRET, NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.payload.action, "created");
});

test("rejects a signature made with another secret", () => {
  const raw = body();
  const result = verifyLinearWebhook(raw, sign(raw, "someone-else"), SECRET, NOW);
  assert.deepEqual(result, { ok: false, reason: "signature mismatch" });
});

test("rejects a tampered body", () => {
  const raw = body();
  const signature = sign(raw);
  const tampered = body({ action: "prompted" });
  assert.equal(verifyLinearWebhook(tampered, signature, SECRET, NOW).ok, false);
});

test("rejects a missing or non-hex signature", () => {
  const raw = body();
  assert.equal(verifyLinearWebhook(raw, undefined, SECRET, NOW).ok, false);
  assert.equal(verifyLinearWebhook(raw, "not-hex!", SECRET, NOW).ok, false);
  assert.equal(verifyLinearWebhook(raw, sign(raw).slice(0, 10), SECRET, NOW).ok, false);
});

test("rejects a payload outside the replay window", () => {
  const stale = body({ webhookTimestamp: NOW - MAX_WEBHOOK_SKEW_MS - 1 });
  assert.deepEqual(verifyLinearWebhook(stale, sign(stale), SECRET, NOW), {
    ok: false,
    reason: "timestamp outside replay window",
  });
  const future = body({ webhookTimestamp: NOW + MAX_WEBHOOK_SKEW_MS + 1 });
  assert.equal(verifyLinearWebhook(future, sign(future), SECRET, NOW).ok, false);
  const missing = Buffer.from(JSON.stringify({ type: "AgentSessionEvent" }));
  assert.equal(verifyLinearWebhook(missing, sign(missing), SECRET, NOW).ok, false);
});

test("rejects a signed body that isn't a JSON object", () => {
  const notJson = Buffer.from("hello");
  assert.equal(verifyLinearWebhook(notJson, sign(notJson), SECRET, NOW).ok, false);
  const array = Buffer.from("[1,2]");
  assert.equal(verifyLinearWebhook(array, sign(array), SECRET, NOW).ok, false);
});
