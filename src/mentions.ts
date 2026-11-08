/**
 * Mention policy for agent-written Slack messages.
 *
 * The agent tags people with `<@U123>` and user groups with `<!subteam^S123>`.
 * Before posting, every mention is checked against the channel's policy:
 *
 *   - tag:     every known person/group mention pings.
 *   - suggest: people already in the conversation ping; anyone else (and every
 *              group) is rendered as a bold name and offered as a "Loop in"
 *              button, so a human decides before someone outside gets pinged.
 *   - off:     nothing pings; mentions are rendered as names.
 *
 * Always, regardless of mode:
 *   - @here / @channel / @everyone never ping (both `<!here>` and the plain
 *     `@here` that markdown-to-slack-blocks would turn into a broadcast).
 *   - IDs the directory doesn't know are treated as fabricated and dropped.
 *   - When the triggering message came from another bot, bot mentions are
 *     rendered as names so two agents can't ping-pong each other forever.
 */
import type { KnownBlock } from "@slack/types";
import { Action } from "./constants.js";
import type { MentionMode } from "./db/directory.js";

export interface DirectoryLookup {
  user(id: string): { label: string; isBot: boolean } | undefined;
  group(id: string): { handle: string } | undefined;
}

export interface MentionPolicy {
  mode: MentionMode;
  /** User IDs that may be pinged in suggest mode (asker + thread participants). */
  participants: ReadonlySet<string>;
  /** The bot's own user ID — never rendered as a live mention. */
  botUserId?: string;
  /** Triggering message came from a bot: never ping bots back (loop guard). */
  triggeredByBot?: boolean;
}

export interface MentionSuggestion {
  kind: "user" | "group";
  id: string;
  label: string;
}

export interface MentionResult {
  markdown: string;
  /** Number of mentions left live (these will notify someone). */
  liveCount: number;
  /** People/groups the agent wanted to tag but policy held back. */
  suggestions: MentionSuggestion[];
}

/** Cap on live pings per response, to stop a runaway list of tags. */
export const MAX_LIVE_MENTIONS = 5;
/** Cap on "Loop in" buttons per response. */
export const MAX_SUGGESTIONS = 5;

const USER_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const GROUP_RE = /<!subteam\^(S[A-Z0-9]+)(?:\|[^>]*)?>/g;
const SLACK_BROADCAST_RE = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
// Plain-text broadcasts that markdown-to-slack-blocks converts into real ones.
const PLAIN_BROADCAST_RE = /(^|[^\w@])@(here|channel|everyone)\b/gi;
const ZWSP = "​";

function name(label: string): string {
  return `**${label.replace(/\*/g, "")}**`;
}

export function applyMentionPolicy(
  markdown: string,
  policy: MentionPolicy,
  lookup: DirectoryLookup,
): MentionResult {
  const suggestions = new Map<string, MentionSuggestion>();
  let liveCount = 0;

  const suggest = (s: MentionSuggestion) => {
    if (policy.mode === "suggest" && !suggestions.has(s.id) && suggestions.size < MAX_SUGGESTIONS) {
      suggestions.set(s.id, s);
    }
  };

  let out = markdown
    .replace(SLACK_BROADCAST_RE, (_m, kind: string) => `@${ZWSP}${kind}`)
    .replace(PLAIN_BROADCAST_RE, (_m, pre: string, kind: string) => `${pre}@${ZWSP}${kind}`);

  out = out.replace(USER_RE, (_m, id: string) => {
    if (id === policy.botUserId) return name(lookup.user(id)?.label ?? "me");
    const known = lookup.user(id);
    const isParticipant = policy.participants.has(id);
    // Unknown and not seen in the conversation: most likely a made-up ID.
    if (!known && !isParticipant) return "a teammate";
    const label = known?.label ?? "teammate";
    const isBot = known?.isBot ?? false;

    let live: boolean;
    if (policy.mode === "off") live = false;
    else if (isBot && policy.triggeredByBot) live = false;
    else if (policy.mode === "tag") live = true;
    else live = isParticipant;

    if (live && liveCount < MAX_LIVE_MENTIONS) {
      liveCount++;
      return `<@${id}>`;
    }
    if (!isParticipant) suggest({ kind: "user", id, label });
    return name(label);
  });

  out = out.replace(GROUP_RE, (_m, id: string) => {
    const known = lookup.group(id);
    if (!known) return "a team";
    const label = `@${known.handle}`;
    if (policy.mode === "tag" && liveCount < MAX_LIVE_MENTIONS) {
      liveCount++;
      // No `|label`: a pipe inside a table cell would split the cell.
      return `<!subteam^${id}>`;
    }
    suggest({ kind: "group", id, label });
    return name(label);
  });

  return { markdown: out, liveCount, suggestions: [...suggestions.values()] };
}

/** Matches any live person/group mention left in a rendered message. */
export function hasLiveMention(text: string): boolean {
  return /<@[UW][A-Z0-9]+>|<!subteam\^S[A-Z0-9]+>/.test(text);
}

/** Encode a Loop-in button value: kind:id:label (label is display-only). */
export function encodeLoopIn(s: MentionSuggestion): string {
  return `${s.kind}:${s.id}:${s.label}`.slice(0, 2000);
}

export function decodeLoopIn(value: string): MentionSuggestion | null {
  const m = value.match(/^(user|group):([A-Z0-9]+):(.*)$/s);
  if (!m) return null;
  const kind = m[1] as "user" | "group";
  const id = m[2];
  if (kind === "user" && !/^[UW]/.test(id)) return null;
  if (kind === "group" && !id.startsWith("S")) return null;
  return { kind, id, label: m[3] };
}

/** Actions block with one "Loop in" button per held-back suggestion. */
export function buildLoopInBlock(suggestions: MentionSuggestion[]): KnownBlock | null {
  if (suggestions.length === 0) return null;
  return {
    type: "actions",
    elements: suggestions.slice(0, MAX_SUGGESTIONS).map((s, i) => ({
      type: "button" as const,
      action_id: `${Action.LOOP_IN_PREFIX}${i}`,
      text: { type: "plain_text" as const, text: `Loop in ${s.label}`.slice(0, 75), emoji: true },
      value: encodeLoopIn(s),
    })),
  };
}

/** The mention token to post when a human clicks "Loop in". */
export function mentionToken(s: MentionSuggestion): string {
  return s.kind === "user" ? `<@${s.id}>` : `<!subteam^${s.id}>`;
}
