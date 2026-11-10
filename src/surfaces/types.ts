/**
 * Somewhere people talk to the bot (Slack, Linear, ...). The turn runner owns
 * the turn lifecycle; a surface only says where the turn lives and renders it.
 */

export interface Surface {
  readonly kind: string;
  /** Conversation → OpenCode session mapping key; replies with the same key continue the session. */
  readonly threadKey: string;
  /** Config scope (see src/scope-config.ts). For Slack, the channel ID. */
  readonly scopeId: string;
  /** Run registry key, so Stop / keep-waiting controls can find this run. */
  readonly runKey: string;

  /** OpenCode is restarting, so the turn didn't run. */
  restarting?(): Promise<void>;
  /** Called often; the surface should throttle. */
  progress?(status: string): void;
  begin?(): void;
  /** Always called once after `begin`, whether the turn answered, threw or was stopped. */
  end?(): Promise<void>;
  stopped?(): Promise<void>;
  /** `capped`: best-effort answer cut short by the time limit. */
  reply(markdown: string, meta: { sessionId: string; capped: boolean }): Promise<void>;
}
