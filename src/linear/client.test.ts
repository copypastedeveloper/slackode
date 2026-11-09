import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityQueue, type ActivityOpts } from "./client.js";

test("a retried activity reuses its ID, so a lost response can't post it twice", async () => {
  const ids: Array<string | undefined> = [];
  const api = {
    createActivity: async (_sessionId: string, _content: unknown, opts: ActivityOpts = {}) => {
      ids.push(opts.id);
      if (ids.length === 1) throw new Error("socket hang up");
    },
  };
  const queue = new ActivityQueue(api, "session-1", [0]);
  await queue.push({ type: "response", body: "answer" });
  assert.equal(ids.length, 2);
  assert.ok(ids[0]);
  assert.equal(ids[1], ids[0]);
});
