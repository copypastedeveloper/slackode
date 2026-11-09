import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityQueue, LinearClient, type ActivityContent, type ActivityOpts, type LinearApi } from "./client.js";

function recordingApi(failFirst = 0) {
  const calls: Array<{ content: ActivityContent; opts: ActivityOpts }> = [];
  let failures = failFirst;
  const api: LinearApi = {
    createActivity: async (_sessionId, content, opts = {}) => {
      calls.push({ content, opts });
      if (failures > 0) {
        failures--;
        throw new Error("socket hang up");
      }
    },
  };
  return { api, calls };
}

test("a retried activity reuses its ID so a lost response can't post it twice", async () => {
  const { api, calls } = recordingApi(1);
  const queue = new ActivityQueue(api, "session-1", [0]);
  await queue.push({ type: "response", body: "answer" });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].opts.id);
  assert.equal(calls[1].opts.id, calls[0].opts.id);
});

test("each activity gets its own ID", async () => {
  const { api, calls } = recordingApi();
  const queue = new ActivityQueue(api, "session-1", []);
  await queue.push({ type: "thought", body: "one" });
  await queue.push({ type: "response", body: "two" });
  assert.notEqual(calls[0].opts.id, calls[1].opts.id);
});

test("ephemeral activities aren't retried, and are skipped once superseded", async () => {
  const { api, calls } = recordingApi(1);
  const queue = new ActivityQueue(api, "session-1", [0, 0]);
  await queue.push({ type: "thought", body: "progress" }, { ephemeral: true });
  assert.equal(calls.length, 1, "a failed ephemeral update is dropped, not retried");

  const { api: api2, calls: calls2 } = recordingApi();
  const queue2 = new ActivityQueue(api2, "session-2", []);
  void queue2.push({ type: "thought", body: "first" });
  void queue2.push({ type: "thought", body: "stale progress" }, { ephemeral: true });
  await queue2.push({ type: "response", body: "answer" });
  assert.deepEqual(calls2.map((c) => (c.content as { body: string }).body), ["first", "answer"]);
});

test("the client gets a new token and retries once on a 401, even without a JSON body", async () => {
  const requests: Array<{ url: string; auth?: string; body: string }> = [];
  let tokens = 0;
  let graphqlCalls = 0;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url: href, auth: headers.Authorization, body: String(init?.body ?? "") });
    if (href.endsWith("/oauth/token")) {
      tokens++;
      return new Response(JSON.stringify({ access_token: `token-${tokens}`, expires_in: 2_592_000 }), { status: 200 });
    }
    graphqlCalls++;
    if (graphqlCalls === 1) return new Response("Unauthorized", { status: 401 });
    return new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), { status: 200 });
  }) as typeof fetch;

  const client = new LinearClient("id", "secret", fakeFetch);
  await client.createActivity("session-1", { type: "response", body: "hi" }, { id: "activity-1" });

  assert.equal(tokens, 2);
  const graphqlRequests = requests.filter((r) => r.url.endsWith("/graphql"));
  assert.deepEqual(graphqlRequests.map((r) => r.auth), ["Bearer token-1", "Bearer token-2"]);
  const sent = JSON.parse(graphqlRequests[1].body) as { variables: { input: Record<string, unknown> } };
  assert.deepEqual(sent.variables.input, {
    agentSessionId: "session-1",
    content: { type: "response", body: "hi" },
    id: "activity-1",
  });
  const tokenRequest = new URLSearchParams(requests[0].body);
  assert.equal(tokenRequest.get("grant_type"), "client_credentials");
  assert.equal(tokenRequest.get("scope"), "read,write,app:mentionable,app:assignable");
});
