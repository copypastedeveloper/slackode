/**
 * Minimal Linear API client: an app token from the OAuth client-credentials
 * grant, and agent activities. Uses fetch so there are no new dependencies.
 */
import { randomUUID } from "node:crypto";
import { retryWithDelays } from "../../utils/retry.js";

const API_URL = "https://api.linear.app/graphql";
const TOKEN_URL = "https://api.linear.app/oauth/token";
/** `app:mentionable` lets people @mention the agent; `app:assignable` lets them delegate issues to it. */
const SCOPES = "read,write,app:mentionable,app:assignable";
const REQUEST_TIMEOUT_MS = 20_000;
/** Client-credentials tokens last 30 days; renew well before that. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export interface ActivityOpts {
  /** Only thoughts may be ephemeral: the next activity replaces them. */
  ephemeral?: boolean;
  /** Reused on retries so a lost response can't post twice. */
  id?: string;
}

export interface LinearApi {
  createActivity(agentSessionId: string, content: ActivityContent, opts?: ActivityOpts): Promise<void>;
}

export interface LinearIdentity {
  appUserId: string;
  organizationId: string;
  organizationName: string;
}

export class LinearClient implements LinearApi {
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async accessToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return this.token.value;
    }
    this.pendingToken ??= this.requestToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async requestToken(): Promise<string> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: SCOPES,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Linear token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}, retried = false): Promise<T> {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await this.accessToken(retried)}` },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && !retried) return this.graphql<T>(query, variables, true);
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message?: string }> };
    if (!res.ok || body.errors?.length || !body.data) {
      const messages = body.errors?.map((e) => e.message).join("; ");
      throw new Error(`Linear GraphQL error: HTTP ${res.status}${messages ? ` — ${messages}` : ""}`);
    }
    return body.data;
  }

  async identity(): Promise<LinearIdentity> {
    const { viewer } = await this.graphql<{ viewer: { id: string; organization: { id: string; name: string } } }>(
      "query { viewer { id organization { id name } } }",
    );
    return { appUserId: viewer.id, organizationId: viewer.organization.id, organizationName: viewer.organization.name };
  }

  async createActivity(agentSessionId: string, content: ActivityContent, opts: ActivityOpts = {}): Promise<void> {
    await this.graphql(
      "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
      { input: { agentSessionId, content, ...opts } },
    );
  }
}

/** Posts one agent session's activities in order, retrying non-ephemeral ones. */
export class ActivityQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly linear: LinearApi,
    private readonly agentSessionId: string,
    private readonly retryDelaysMs: number[] = [2_000, 10_000, 30_000],
  ) {}

  push(content: ActivityContent, opts: { ephemeral?: boolean } = {}): Promise<void> {
    const sendOpts = { ...opts, id: randomUUID() };
    this.tail = this.tail.then(() => this.send(content, sendOpts));
    return this.tail;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  private async send(content: ActivityContent, opts: ActivityOpts): Promise<void> {
    const delays = opts.ephemeral ? [] : this.retryDelaysMs;
    try {
      await retryWithDelays(() => this.linear.createActivity(this.agentSessionId, content, opts), delays);
    } catch (err) {
      console.error(`[linear] ${this.agentSessionId}: gave up posting ${content.type}:`, err instanceof Error ? err.message : err);
    }
  }
}
