import crypto from "node:crypto";

/** Linear's documented replay window for `webhookTimestamp`. */
export const MAX_WEBHOOK_SKEW_MS = 60_000;

export type VerifyResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Verify a Linear webhook delivery.
 *
 * `Linear-Signature` is a hex HMAC-SHA256 of the raw request body, keyed with
 * the webhook signing secret. The HMAC must be computed over the exact bytes
 * received; re-serialising parsed JSON would change them. The payload's
 * `webhookTimestamp` (ms) must be within a minute of now, which bounds replay.
 */
export function verifyLinearWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  now: number = Date.now(),
): VerifyResult {
  if (!signatureHeader || !/^[0-9a-f]+$/i.test(signatureHeader)) {
    return { ok: false, reason: "missing or malformed signature" };
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signatureHeader, "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "body is not a JSON object" };
  }

  const ts = (payload as { webhookTimestamp?: unknown }).webhookTimestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(now - ts) > MAX_WEBHOOK_SKEW_MS) {
    return { ok: false, reason: "timestamp outside replay window" };
  }

  return { ok: true, payload: payload as Record<string, unknown> };
}
