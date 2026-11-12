import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { registerSurface, surfaceCanSchedule } from "./registry.js";
import { resolveAgent } from "../db/channels.js";
import { setActiveTools } from "../active-tools.js";

describe("surface registry", () => {
  it("lets registered surfaces turn scheduling off; Slack keeps it", () => {
    registerSurface({ id: "test-surface", name: "Test", scheduling: false });
    assert.equal(surfaceCanSchedule("test-surface"), false);
    assert.equal(surfaceCanSchedule("slack"), true);
  });
});

describe("resolveAgent", () => {
  setActiveTools(["linear", "sentry"]);

  it("maps tools to build variants, or the default agent without tools", () => {
    assert.equal(resolveAgent(undefined, ["sentry", "linear"]), "build-linear-sentry");
    assert.equal(resolveAgent(undefined, []), undefined);
  });

  it("uses the scheduler-free family for surfaces that can't schedule", () => {
    assert.equal(resolveAgent(undefined, ["linear"], false), "build-noscheduler-linear");
    assert.equal(resolveAgent(undefined, undefined, false), "build-noscheduler");
  });

  it("drops inactive tools and prefers a configured agent", () => {
    assert.equal(resolveAgent(undefined, ["linear", "gone"], false), "build-noscheduler-linear");
    assert.equal(resolveAgent("custom", ["linear"], false), "custom");
  });
});
