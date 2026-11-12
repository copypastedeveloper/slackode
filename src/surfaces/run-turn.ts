/** The turn runner wired to the real OpenCode client, session store and run registry. */
import { TURN_HARD_CAP_MS } from "../constants.js";
import { askQuestion, abortSessionServerSide } from "../opencode.js";
import { isRestarting, waitForRestart } from "../opencode-server.js";
import { registerRun, getRun, removeRun } from "../run-registry.js";
import {
  getOrCreateSession, deleteSessionMapping, isSessionCompacted, setSessionCompacted,
} from "../sessions.js";
import { createTurnRunner } from "../turn-runner.js";
import { resolveScopeConfig } from "../scope-config.js";

export const { runTurn, stopThread } = createTurnRunner({
  ask: askQuestion,
  abortServerSide: (sessionId) => abortSessionServerSide(sessionId),
  isRestarting,
  waitForRestart,
  sessions: {
    getOrCreate: getOrCreateSession,
    remove: deleteSessionMapping,
    isCompacted: isSessionCompacted,
    setCompacted: setSessionCompacted,
  },
  runs: { register: registerRun, get: getRun, remove: removeRun },
  resolveScope: resolveScopeConfig,
  turnCapMs: TURN_HARD_CAP_MS,
});
