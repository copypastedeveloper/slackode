/**
 * Minimal Linear API client for the agent surface: an app-actor access token
 * from the OAuth client-credentials grant, and the two mutations the agent
 * needs. Uses fetch directly so the image picks up no new dependencies.
 */

const API_URL = "https://api.linear.app/graphql";
const TOKEN_URL = "https://api.linear.app/oauth/token";
/** `app:mentionable` lets people @mention the agent; `app:assignable` lets them delegate issues to it. */
export const LINEAR_SCOPES = "read,write,app:mentionable,app:assignable";
const REQUEST_TIMEOUT_MS = 20_000;
/** Client-credentials tokens last 30 days; fetch a new one well before expiry. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export interface ActivityOpts {
  /** Only thoughts and actions may be ephemeral; the next activity replaces them. */
  ephemeral?: boolean;
}

/** The slice of the Linear API the agent depends on (faked in tests). */
export interface LinearApi {
  createActivity(agentSessionId: string, content: ActivityContent, opts?: ActivityOpts): Promise<void>;
}

export interface LinearIdentity {
  /** The app user's ID in the workspace (what mentions and delegation point at). */
  appUserId: string;
  organizationId: string;
  organizationName: string;
}

type FetchFn = typeof fetch;

export class LinearClient implements LinearApi {
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  /** Returns a cached app token, fetching a new one when it's missing, near expiry, or rejected. */
  async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return this.token.value;
    }
    this.pendingToken ??= this.requestToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async requestToken(): Promise<string> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: LINEAR_SCOPES,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      // The body can echo request details; keep it out of logs beyond the status.
      throw new Error(`Linear token request failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Linear token response had no access_token");
    const ttlMs = (typeof body.expires_in === "number" ? body.expires_in : 30 * 24 * 3600) * 1000;
    this.token = { value: body.access_token, expiresAt: Date.now() + ttlMs };
    return body.access_token;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, retried = false): Promise<T> {
    const token = await this.accessToken(retried);
    const res = await this.fetchImpl(API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    let body: { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error(`Linear GraphQL error: HTTP ${res.status} (non-JSON response)`);
    }
    const authFailed =
      res.status === 401 || body.errors?.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
    if (authFailed && !retried) return this.graphql<T>(query, variables, true);
    if (!res.ok || body.errors?.length || !body.data) {
      const messages = body.errors?.map((e) => e.message).filter(Boolean).join("; ");
      throw new Error(`Linear GraphQL error: HTTP ${res.status}${messages ? ` — ${messages}` : ""}`);
    }
    return body.data;
  }

  async identity(): Promise<LinearIdentity> {
    const data = await this.graphql<{ viewer: { id: string; organization: { id: string; name: string } } }>(
      "query SlackodeViewer { viewer { id organization { id name } } }",
    );
    return {
      appUserId: data.viewer.id,
      organizationId: data.viewer.organization.id,
      organizationName: data.viewer.organization.name,
    };
  }

  async createActivity(agentSessionId: string, content: ActivityContent, opts: ActivityOpts = {}): Promise<void> {
    await this.graphql(
      `mutation SlackodeActivity($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success }
      }`,
      { input: { agentSessionId, content, ...(opts.ephemeral ? { ephemeral: true } : {}) } },
    );
  }
}

/**
 * Posts one agent session's activities in order. Durable activities (thoughts,
 * responses, errors) are retried; an ephemeral progress update is skipped if a
 * newer activity is already waiting, since Linear would replace it anyway.
 */
export class ActivityQueue {
  private items: Array<{ content: ActivityContent; opts: ActivityOpts }> = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly linear: LinearApi,
    private readonly agentSessionId: string,
    private readonly retryDelaysMs: number[] = [2_000, 10_000, 30_000],
  ) {}

  push(content: ActivityContent, opts: ActivityOpts = {}): Promise<void> {
    this.items.push({ content, opts });
    this.tail = this.tail.then(() => this.sendNext());
    return this.tail;
  }

  /** Resolves once everything queued so far has been sent or given up on. */
  flush(): Promise<void> {
    return this.tail;
  }

  private async sendNext(): Promise<void> {
    const item = this.items.shift();
    if (!item) return;
    if (item.opts.ephemeral && this.items.length > 0) return;
    const delays = item.opts.ephemeral ? [] : this.retryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.linear.createActivity(this.agentSessionId, item.content, item.opts);
        return;
      } catch (err) {
        if (attempt >= delays.length) {
          console.error(
            `[linear] ${this.agentSessionId}: gave up posting ${item.content.type} activity:`,
            err instanceof Error ? err.message : err,
          );
          return;
        }
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
}
