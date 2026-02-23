/**
 * Simple in-memory per-user rate limiter using a sliding window.
 * Tracks timestamps of recent requests per user and rejects if the
 * count exceeds the configured limit within the window.
 */

const DEFAULT_MAX_REQUESTS = 20;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface RateLimitConfig {
  maxRequests?: number;
  windowMs?: number;
}

const userTimestamps: Map<string, number[]> = new Map();

/**
 * Check if a user is within their rate limit.
 * Returns { allowed: true } if the request is permitted,
 * or { allowed: false, retryAfterMs } if rate-limited.
 */
export function checkRateLimit(
  userId: string,
  config?: RateLimitConfig
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const maxRequests = config?.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();
  const cutoff = now - windowMs;

  // Get existing timestamps and prune expired ones
  let timestamps = userTimestamps.get(userId) ?? [];
  timestamps = timestamps.filter((t) => t > cutoff);

  if (timestamps.length >= maxRequests) {
    // Rate limited — tell the user when they can retry
    const oldestInWindow = timestamps[0];
    const retryAfterMs = oldestInWindow + windowMs - now;
    userTimestamps.set(userId, timestamps);
    return { allowed: false, retryAfterMs };
  }

  // Allow the request and record the timestamp
  timestamps.push(now);
  userTimestamps.set(userId, timestamps);
  return { allowed: true };
}

/**
 * Format a retryAfterMs value into a human-readable string.
 */
export function formatRetryAfter(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "about a minute";
  return `about ${minutes} minutes`;
}
