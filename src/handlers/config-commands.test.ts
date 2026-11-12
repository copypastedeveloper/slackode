import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

process.env.SESSIONS_DB_PATH = ":memory:";
const { handleConfigCommand } = await import("./config-commands.js");
const { setChannelTools, setSurfaceTools, getEffectiveTools, setRole } = await import("../sessions.js");
const { registerSurface } = await import("../surfaces/registry.js");

const run = (cmd: string, channel = "C1", user = "U-admin") => handleConfigCommand(cmd, channel, "general", user);

describe("surface default tools", () => {
  before(() => {
    setRole("U-admin", "admin", "test");
    registerSurface({ id: "other", name: "Other", scheduling: false });
    setSurfaceTools("slack", ["linear", "sentry"]);
  });

  it("apply to scopes without their own tools, per surface", async () => {
    assert.deepEqual(getEffectiveTools("slack", "C1"), ["linear", "sentry"]);
    assert.equal(getEffectiveTools("other", "x"), undefined);
    assert.match((await run("config get tools"))!, /default tools apply: `linear`, `sentry`/);
  });

  it("are replaced by a channel's own tools, including none", async () => {
    setChannelTools("C2", "other", ["sentry"]);
    assert.deepEqual(getEffectiveTools("slack", "C2"), ["sentry"]);

    assert.match((await run("config set tools none", "C3"))!, /turned off/);
    assert.deepEqual(getEffectiveTools("slack", "C3"), []);
    assert.match((await run("config clear tools", "C3"))!, /default tools apply/);
    assert.deepEqual(getEffectiveTools("slack", "C3"), ["linear", "sentry"]);
  });

  it("are set per surface by admins and readable by anyone", async () => {
    assert.match((await run("config set tools none --surface other"))!, /Other default tools set to none/);
    assert.deepEqual(getEffectiveTools("other", "x"), []);
    setSurfaceTools("other", ["sentry"]); // `config set tools` checks names against the tools table
    assert.match((await run("config get tools --surface slack", "C1", "U-user"))!, /Slack default tools: `linear`, `sentry`/);
    assert.match((await run("config clear tools --surface slack", "C1", "U-user"))!, /requires \*admin\*/);
    assert.match((await run("config list tools"))!, /Default tools by surface:\*\n• Other → `sentry`\n• Slack → `linear`, `sentry`/);
  });

  it("reject unknown surfaces and non-tool commands", async () => {
    assert.match((await run("config get tools --surface nope"))!, /Unknown surface `nope`/);
    assert.match((await run("config set prompt hi --surface slack"))!, /only applies to tools/);
  });
});
