import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyLinearWebhook, MAX_WEBHOOK_SKEW_MS } from "./webhook.js";

const SECRET = "test-signing-secret";
const NOW = 1_800_000_000_000;
const sign = (body: Buffer, secret = SECRET) => crypto.createHmac("sha256", secret).update(body).digest("hex");
const body = (webhookTimestamp = NOW) => Buffer.from(JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp }));

test("accepts a correctly signed, fresh payload", () => {
  const raw = body();
  assert.equal(verifyLinearWebhook(raw, sign(raw), SECRET, NOW).ok, true);
});

test("rejects missing, forged, or tampered signatures", () => {
  const raw = body();
  assert.equal(verifyLinearWebhook(raw, undefined, SECRET, NOW).ok, false);
  assert.equal(verifyLinearWebhook(raw, sign(raw, "someone-else"), SECRET, NOW).ok, false);
  assert.equal(verifyLinearWebhook(body(NOW + 1), sign(raw), SECRET, NOW).ok, false);
});

test("rejects a payload outside the replay window", () => {
  const stale = body(NOW - MAX_WEBHOOK_SKEW_MS - 1);
  assert.equal(verifyLinearWebhook(stale, sign(stale), SECRET, NOW).ok, false);
});
