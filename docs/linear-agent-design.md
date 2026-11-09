# Linear agent

## Goal

Let people ask Slackode questions from Linear as well as Slack. They @mention it in an issue comment, or delegate an issue to it, and it answers in the issue thread. A reply continues the conversation, and **Stop** cancels the run.

## Why the agent platform rather than comment webhooks

Linear's [agent platform](https://linear.app/developers/agents) gives an app its own identity. People can mention it and delegate to it without it taking a seat. Linear sends one `AgentSessionEvent` per conversation turn, and the app answers by posting activities: thoughts, actions, a response, or an error. Linear renders those as a live progress view, then posts the response as a comment.

Plain comment webhooks would mean a bot user posing as a person. We would have to filter every comment in the workspace for mentions, avoid reply loops, and rebuild the thread ourselves.

## Flow

```
Linear ──POST /webhooks/linear──▶ server.ts ── verify HMAC + timestamp ──▶ 200
                                     │ (async)
                                     ▼
                                  agent.ts ── thought "Looking into this…" (within 10s)
                                     │
                                     ├─ getOrCreateSession("linear:<agentSessionId>")
                                     ├─ askQuestion({ agent: "linear", customContextPrefix, onProgress, abortSignal })
                                     │     └─ throttled ephemeral thought/action activities
                                     └─ response (or error) activity ──▶ Linear posts it as a comment
```

| Event | Handling |
|---|---|
| `created` (mention or delegation) | Post a thought immediately: Linear marks a session unresponsive after about 10 seconds without one. Ask `promptContext`, the issue and thread as Linear formats them. If it's missing, fall back to the issue and comment. |
| `prompted` (reply in the thread) | Ask `agentActivity.content.body` in the same OpenCode session. If a turn is already running, queue the reply behind it. |
| `prompted` with `signal: "stop"` | Abort the running turn, both locally and on the server, drop queued replies, and post a response confirming the stop. The stopped turn waits for that abort, then aborts once more. That covers a prompt that reached the server after the first abort. Turns run one at a time per session, so a reply sent right after Stop can't start until both aborts have landed. |

## Decisions

- **Ingress.** Socket Mode has no Linear equivalent. Linear only delivers webhooks, which have to be answered within 5 seconds. We add a small `node:http` listener: `GET /health` and `POST /webhooks/linear`. It replies 200 as soon as the signature checks out and hands the event off without waiting. Operators should route only the webhook path from the internet.
- **Verification.** `Linear-Signature` is an HMAC-SHA256 over the raw body, compared in constant time. `webhookTimestamp` must be within 60 seconds. Repeat deliveries are dropped by `Linear-Delivery` ID, and repeat events by action plus activity ID. Bodies are capped at 1 MB and never logged.
- **Auth.** Slackode uses the OAuth client-credentials grant. The app token is stateless: no install redirect and no refresh token to persist. It's renewed on a 401 or an hour before it expires. Only events whose `organizationId` and `appUserId` match the token's `viewer` are handled.
- **No new dependencies.** It uses `fetch` and `node:crypto`. `@linear/sdk` would pull in a large dependency tree for two mutations and the image's npm audit gate.
- **Agent.** A single `linear` agent: the read-only `build` agent plus the tools in `LINEAR_AGENT_TOOLS`, with `scheduler*` off. The scheduler tools take Slack channel and user IDs, which a Linear conversation doesn't have.
- **Prompt.** `buildPrefix` takes an optional `surface`. For Linear it swaps the Slack formatting rules for Markdown, and replaces the Slack ID context block with the asker and the issue. It also includes any workspace agent guidance and says that scheduling has to happen in Slack.
- **Sessions and analytics.** Thread key `linear:<agentSessionId>` on pseudo channel `linear`. These reuse the existing `sessions` table, compaction flag, wedged-session cleanup and `turns` analytics, with user `linear:<linearUserId>`.
- **Startup.** The listener starts before OpenCode, so load balancer health checks pass during boot. Events that arrive early get their thought posted, then wait until OpenCode is ready.

## Out of scope

- Coding sessions or `config`/`tool` commands from Linear.
- Mapping Linear users to Slack roles: everyone in the workspace gets the same read-only Q&A as any Slack channel member.
- Installs into other Linear workspaces, which would need the authorization-code flow.
