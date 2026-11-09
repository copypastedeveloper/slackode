import { test } from "node:test";
import assert from "node:assert/strict";
import { readLinearConfig, DEFAULT_LINEAR_PORT } from "./config.js";

const CREDS = {
  LINEAR_CLIENT_ID: "id",
  LINEAR_CLIENT_SECRET: "secret",
  LINEAR_WEBHOOK_SECRET: "whsec",
};

test("disabled when no Linear credentials are set", () => {
  assert.equal(readLinearConfig({}), null);
});

test("disabled (not thrown) when only some credentials are set", () => {
  assert.equal(readLinearConfig({ LINEAR_CLIENT_ID: "id" }), null);
  assert.equal(readLinearConfig({ ...CREDS, LINEAR_WEBHOOK_SECRET: " " }), null);
});

test("defaults the port and parses the tool list", () => {
  const config = readLinearConfig({ ...CREDS, LINEAR_AGENT_TOOLS: " linear, sentry ,," });
  assert.deepEqual(config, {
    clientId: "id",
    clientSecret: "secret",
    webhookSecret: "whsec",
    port: DEFAULT_LINEAR_PORT,
    tools: ["linear", "sentry"],
  });
});

test("rejects a bad port", () => {
  assert.equal(readLinearConfig({ ...CREDS, LINEAR_WEBHOOK_PORT: "http" }), null);
  assert.equal(readLinearConfig({ ...CREDS, LINEAR_WEBHOOK_PORT: "70000" }), null);
  assert.equal(readLinearConfig({ ...CREDS, LINEAR_WEBHOOK_PORT: "9090" })?.port, 9090);
});
