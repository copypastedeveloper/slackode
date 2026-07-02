# Scheduled Jobs: making slackode proactive

Design for a jobs subsystem that lets slackode run unattended work on schedules,
follow up on conversations, and — critically — let **non-engineers create jobs by
talking to it in Slack**.

Status: draft for review
Flagship use case: the weekly AI-feature-utilization report (currently a launchd
job on Nathan's laptop; see §10).

---

## 1. Goals & non-goals

**Goals**

- slackode *feels proactive*: it comes back unprompted (follow-ups), speaks on a
  cadence (reports), and eventually speaks only when something changed (watchers).
- **Laypeople create jobs conversationally.** No repos, no cron strings, no YAML.
  The interactive thread is the workshop; "do this every Friday" freezes it.
- Deterministic work stays deterministic. Numbers people act on come from frozen,
  versioned code — not re-derived by an LLM each run.
- Agent authority scales with supervision: what runs unattended is strictly less
  privileged than what runs with a human in the thread.

**Non-goals (for now)**

- Multi-replica scheduling (the bot is single-instance; see §11).
- A general workflow engine (DAGs, retries with backoff trees, etc.). Jobs are
  single agent sessions.
- Arbitrary user-pasted code blocks as tools. Rejected in design discussion:
  code enters the system only via git commits (§6) — witnessed-run distillation
  committed by the bot, or engineer PRs.

---

## 2. Core model

**A job is: a schedule + a channel + a prompt + a git pointer.**

```
job = {
  schedule:  cron | oneshot at | watcher interval     (with timezone)
  channel:   where results go
  prompt:    one-paragraph intent, references the recipe
  pointer:   { repo, path, ref }                       (nullable for prompt-only jobs)
}
```

Three layers, each doing what it's good at:

| Layer  | Holds | Lives in | Changes via |
|--------|-------|----------|-------------|
| **Job** | when / where / intent | `scheduled_jobs` table | `schedule` commands, `schedule_job` tool |
| **Recipe** | how — the procedure, params, caveats | `RECIPE.md` in a repo | git commit (bot or human) |
| **Script(s)** | deterministic work — queries, rendering | same repo dir as recipe | git commit + witnessed run / PR |

The agent at fire time is **glue**: read recipe → run script → interpret its
machine-readable output → post with narrative. It never authors code unattended
(enforced by the `job` agent profile, §5).

Complexity escalates without changing the job model:

- **Trivial**: prompt-only, no pointer ("check thread X; if no reply, ping Nathan").
- **Medium**: prompt + MCP tools already registered in the `tools` table.
- **Complex**: prompt → pointer → recipe + bundled script (the AI report).

### Why a git pointer and not code in the DB

Debated and settled: DB-resident code has no diffs, no history, no review
surface, and invisible drift. Instead **the bot itself commits** conversational
artifacts (§6), so laypeople never touch git but every executable artifact has
history, rollback (`ref` re-pin), and an engineer-visible home. The DB stays
boring: schedules, pointers, run history, snapshots.

---

## 3. Schema

New tables in `src/db/jobs.ts`, following the existing pattern
(`CREATE TABLE IF NOT EXISTS` + try/catch `ALTER` migrations, `src/db/index.ts`).
DB lives on the persistent volume (`SESSIONS_DB_PATH` →
`/home/appuser/.local/share/opencode/sessions.db`), so jobs survive container
destroy.

```sql
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id               TEXT PRIMARY KEY,            -- uuid
  name             TEXT NOT NULL UNIQUE,        -- slug, e.g. ai-utilization-weekly
  kind             TEXT NOT NULL,               -- 'cron' | 'oneshot' | 'watcher'
  cron             TEXT,                        -- cron expr (kind=cron|watcher)
  timezone         TEXT NOT NULL DEFAULT 'America/Chicago',
  run_at           INTEGER,                     -- unixepoch (kind=oneshot)
  channel_id       TEXT NOT NULL,
  thread_ts        TEXT,                        -- oneshot follow-ups reply in-thread
  prompt           TEXT NOT NULL,               -- intent, references recipe
  repo             TEXT,                        -- repos.name (nullable: prompt-only)
  path             TEXT,                        -- dir within repo holding RECIPE.md
  ref              TEXT,                        -- pinned commit SHA
  created_by       TEXT NOT NULL,               -- Slack user id (job owner)
  enabled          INTEGER NOT NULL DEFAULT 1,
  probation_remaining INTEGER NOT NULL DEFAULT 3,  -- runs delivered to owner DM first
  next_run_at      INTEGER,                     -- precomputed; scheduler reads this
  last_run_at      INTEGER,
  last_status      TEXT,                        -- 'ok' | 'error' | 'skipped'
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS job_runs (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES scheduled_jobs(id),
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT NOT NULL,        -- 'running' | 'ok' | 'error' | 'timeout' | 'cancelled'
  error        TEXT,
  posted_ts    TEXT,                 -- Slack ts of the parent message, if posted
  snapshot_json TEXT,                -- machine-readable summary emitted by the run
  tokens       INTEGER, cost REAL    -- mirror turns-table accounting
);
```

`snapshot_json` powers **delta narration** (§8): the executor injects the
previous run's snapshot into the prompt so the agent narrates *change* ("MCP up
12% w/w; saversbank appeared for the first time"), not just state.

Cron parsing/next-run computation: add [`croner`](https://npmjs.com/package/croner)
(zero-dep, timezone-aware) rather than hand-rolling.

---

## 4. Scheduler & executor

### Scheduler loop (`src/scheduler.ts`)

Mirrors `startPeriodicGDocsSync` (`src/gdocs-sync.ts:164-185`): `start/stop`
functions wired into `src/index.ts` startup + graceful shutdown, tick every 30s,
all errors swallowed to console — never crash the bot.

Per tick:

1. `getDueJobs(now)` — `enabled = 1 AND next_run_at <= now`.
2. For each: insert a `job_runs` row (`running`), compute + store the *next*
   `next_run_at` **immediately** (so a crashed run doesn't refire in a loop),
   then dispatch to the executor. Cap concurrent runs (start: 1) — queue the rest.
3. **Catch-up policy**: on startup, a cron job whose slot was missed while the
   container was down runs **once** if the miss is < 24h old, else skips with
   `last_status = 'skipped'` and a DM to the owner. Oneshots always fire if past
   due. (launchd-style catch-up, bounded.)

### Executor (`src/job-runner.ts`)

A job run is **an unattended agent session in the job's repo at the pinned ref**.
Reuses the coding-session machinery (`src/coding-session.ts:114-270`), not the
shared Q&A server — that gives per-run isolation (own opencode server on the
4100–4200 port range, own worktree) instead of contending on the single Q&A
server (`src/opencode-server.ts`, port 4096).

Differences from a coding session:

- **Worktree at a SHA.** Today worktrees are created from `origin/{default}`
  (`src/coding-session.ts:189`). Add a ref parameter:
  `git worktree add <dir> <job.ref>`. Prompt-only jobs skip the worktree and use
  a scratch dir.
- **Agent = `job`** (§5), passed per-prompt via the existing `agent` field on
  `session.promptAsync` (`src/opencode.ts:245`) — already per-message selectable.
- **Session key**: synthetic `job::<job_id>::<run_id>` (thread-ts formats
  assumed elsewhere; keep job keys namespaced and out of the `sessions` table's
  thread semantics).
- **Reaper exclusion**: the idle reaper kills sessions idle ≥ 30 min
  (`src/coding-session.ts:604-616`). Job sessions must be excluded (filter on the
  `job::` prefix) and instead governed by a **hard wall-clock timeout**
  (default 15 min) enforced by the runner via abort — there is no cancel API on
  `promptAsync`, so the runner owns the timeout.
- **Analytics**: record turns with synthetic identity `userId = "job::<name>"`
  so cost/token accounting (`src/db/turns.ts`) covers unattended runs.

### The run contract

The runner creates a **per-run scratch dir** `/tmp/jobs/<run_id>/` (rootfs is
read-only; `/tmp` is the 2G executable tmpfs), exports it as `SCRATCH_DIR`,
harvests uploads from it, and deletes it when the run record closes. All file
writes go there — never into the checkout. Ephemerality is deliberate: anything
worth keeping is committed (recipe/script) or uploaded to Slack; durable scratch
on the EFS volume would recreate the stale-artifact problem `skill-manifest.ts`
exists to clean up. Interactive/witnessed sessions get the same treatment
(`/tmp/scratch/<session>/`) so drafts don't dirty the repo checkout.

The prompt assembled by the executor:

```
You are running the scheduled job "<name>". Follow <path>/RECIPE.md in this
checkout. Write all output files to $SCRATCH_DIR.
Previous run snapshot (for comparison): <snapshot_json | "none">.
<job.prompt>
When done, output:
1. A Slack-markdown post for the channel.
2. A fenced json block `snapshot` with the machine-readable summary for next run.
3. File paths of any images to upload, one per line in a fenced `uploads` block.
```

The recipe instructs the agent to run the bundled script (e.g.
`uv run report.py --outdir /tmp/...`) — the image already ships `python3`, `uv`,
`curl`, `git`, `gh` (Dockerfile runtime stage), and `/tmp` is a 2G executable
tmpfs, so this works today with **zero image changes**.

### Posting

The runner posts directly via `app.client` (no handler context needed —
established pattern, e.g. button actions in `src/index.ts:66`):

1. Parent message (through `formatting.ts` markdown→blocks, reusing its
   splitting/limits handling).
2. Threaded image uploads. **New util needed**: `slack-files.ts` currently only
   *downloads*; add `uploadFile(channel, path, title, thread_ts)` using
   `files.getUploadURLExternal` → POST bytes → `files.completeUploadExternal`
   (flow already proven in the standalone report script). Requires the
   `files:write` scope — already granted.
3. Parse the `snapshot` block into `job_runs.snapshot_json`; mark run `ok`.

On error/timeout: mark the run, **DM the owner** with the error and a
`[Run again] [Pause job]` action row. Silent failure is anti-proactive.

---

## 5. The `job` agent profile

Add to the generated opencode config (`src/opencode-config.ts`), alongside
build/context/code/enrich:

```jsonc
"job": {
  "description": "Unattended scheduled-job runner. Executes committed recipes; cannot modify code.",
  "tools": {
    "bash": true, "read": true, "grep": true, "glob": true, "list": true,
    "write": false, "edit": false, "patch": false,
    "skill": false, "webfetch": false, "websearch": false, "question": false
  },
  "permission": {
    "edit": "deny",
    "bash": { "*": "allow" },
    "task": { "*": "deny" },
    "external_directory": { "/app/repos/*": "allow", "/tmp/*": "allow" }
  }
}
```

This is the trust boundary in one place: **the unattended agent cannot author or
modify code** — it executes what's committed at the pinned ref and writes only
to tmpfs. Authoring happens in interactive sessions (build/code agents) with a
human in the thread. `question: false` matters: an unattended session must never
block on interactive input.

Honest caveat: `write: false` disables the write *tool*, but `bash: allow`
means scripts can still write files. The profile's real guarantee is "can't
modify the checkout" — enforced by the pinned worktree (drift is discarded with
the worktree) and `external_directory` scoping — with `$SCRATCH_DIR` (§4) as
the sanctioned write target.

(Deliberate echo of the existing config philosophy: webfetch/websearch stay off;
bash stays open — it's a grounding choice, not a security boundary, and the
recipe's scripts do their own HTTP.)

---

## 6. Creation flows

### 6a. Conversational (laypeople) — the flagship UX

1. **Ask in a thread**: "@slackode every Friday morning, post AI feature usage
   from OpenSearch to this channel."
2. **Witnessed run**: the bot does the task *right there* — normal interactive
   session with full tools — and posts a draft. The user iterates in plain
   English ("exclude demo tenants", "numbers in the bars"). Each round is a
   re-run. *(This mirrors exactly how the flagship report was actually developed.)*
3. **Freeze**: user says "yes, every Friday." The agent calls the `schedule_job`
   tool. Before writing the row, the bot **distills the session into a recipe**:
   - `RECIPE.md` — the working procedure: data source, exact queries/params that
     survived iteration, output format, caveats.
   - Any script it wrote, cleaned up, with machine-readable (JSON) summary output.
4. **Bot commits** the distilled artifacts to the **jobs repo** (§6c) under
   `jobs/<name>/`, using the existing git plumbing (`GIT_TOKEN` / `gh`,
   entrypoint.sh:86-101), and records the commit SHA as `ref`.
5. **Confirmation card** in-thread:
   > 📅 **ai-utilization-weekly** — Fridays 8:00 AM CT → #narmi-ai-commercialization.
   > First 3 runs will come to you for approval. `[Confirm] [Edit schedule] [Cancel]`
6. **Probation** (§7) applies automatically.

The layperson never sees git, cron syntax, or a recipe file. The trust comes
from the witnessed run, not from a code review they can't perform.

### 6b. Engineered (load-bearing jobs)

An engineer commits `RECIPE.md` + scripts to a **domain repo** (e.g.
`narmi/metrics` under `ai-feature-utilization/`), registers that repo with the
existing repo manager if needed, and creates the job via
`@slackode schedule add ...` pointing at it. Review = that repo's normal PR bar.

### 6c. The jobs repo & promotion

- `slackode-jobs` (bot-owned) is the default home for conversational artifacts:
  one directory per job, committed by the bot, browsable by any engineer.
- **Promotion**: a conversational job that becomes load-bearing gets hardened by
  moving its directory into a domain repo via a normal PR (it's already in git —
  this is a file move), then re-pointing the job row. Layperson creates;
  engineering durability arrives only if warranted.
- Rollback = re-pin `ref` to a prior SHA (`schedule rollback <name>`).

### 6d. Management surface

`src/handlers/schedule-commands.ts`, mirroring existing command handlers:

```
schedule list                      — all jobs, next run, last status      (all users)
schedule show <name>               — detail + last 5 runs                 (all users)
schedule pause|resume <name>       — owner or developer
schedule run <name>                — manual fire (respects probation)     (owner/dev)
schedule delete <name>             — owner or developer
schedule rollback <name> [sha]     — re-pin ref                           (developer)
```

Plus the `schedule_job` **agent tool** (the conversational path) and Bolt action
handlers for the confirmation/probation buttons (pattern: `src/index.ts:60-140`).

**Permissions** (existing role system, `src/db/permissions.ts`): creating any
job = `developer` initially; relax to `user`-with-probation once the system has
mileage. Jobs that post to a channel the creator isn't a member of: deny.

---

## 7. Trust ramp: probation

Every new or edited job starts with `probation_remaining = 3`:

- Probation runs execute fully but deliver to the **owner's DM**:
  > Here's what I would have posted to #channel: … `[Post it] [Needs work] [Cancel job]`
- `[Post it]` forwards to the channel and decrements the counter; at 0 the job
  posts directly. Images are **uploaded to Slack at DM time** and forwarding
  reuses the Slack-hosted files — the owner may click `[Post it]` days later,
  after the run's tmpfs scratch dir (and possibly the container) is gone.
- **Any edit to prompt/pointer/schedule resets probation.**

This is the answer to "unattended agent posts wrong numbers publicly": a human
approves the first several *outputs*, which is a review laypeople actually can
do — and it also catches recipe-distillation wobble early, when replay variance
would show up.

---

## 8. Proactivity features (what makes it *feel* alive)

Priority-ordered; each builds on the core:

1. **One-shot follow-ups** — "remind me Friday", "ping this thread if nobody
   replies by tomorrow." `kind = oneshot`, `thread_ts` set, prompt-only. Cheapest
   build, highest perceived proactivity: the bot *comes back unprompted*.
2. **Delta narration** — previous `snapshot_json` injected into every run's
   prompt; recipes require scripts to emit comparable JSON. Charts show state;
   the narrative shows *change*.
3. **Watchers** — `kind = watcher`: check on an interval, **post only if
   interesting** (condition judged by the agent against the snapshot diff, or by
   a script exit code for hard thresholds). Silence-by-default reads as judgment.
4. **Digest composition** — one "morning notes" job whose recipe runs several
   small checks and composes a single post. One voice > N crons.
5. **Suggestion loop** — the bot notices repetition in its own `turns` history
   ("that's the 3rd Friday in a row you've asked for this") and *offers* to
   schedule it: the confirmation card, pre-filled. This is "slackode adopts its
   own jobs" — v2, after the primitives have mileage.

---

## 9. Build plan

Each phase shippable and independently testable.

**Phase 1 — core loop (prompt-only jobs)**
`jobs.ts` tables + CRUD · `croner` · scheduler tick + catch-up · executor for
prompt-only jobs (scratch dir, `job` agent, timeout, synthetic keys, reaper
exclusion) · direct posting via `app.client` · `schedule list/show/pause/run/delete`
· failure DMs. *Milestone: "@slackode schedule add: every weekday 9am post 'standup in 15' to #team" works and survives a redeploy.*

**Phase 2 — repo-pinned jobs + flagship migration**
SHA-pinned worktrees · run contract (recipe + snapshot + uploads blocks) ·
`uploadFile` util · `job` agent in `opencode-config.ts` · migrate the AI report
(§10). *Milestone: the Friday report posts from slackode; laptop launchd job retired.*

**Phase 3 — trust ramp + oneshot follow-ups**
Probation flow + buttons · `schedule_job` agent tool (conversational creation
for prompt-only + oneshot jobs) · thread follow-ups. *Milestone: a non-developer
schedules a reminder by talking to the bot.*

**Phase 4 — distillation + jobs repo**
Session→recipe distillation · bot-committed artifacts to `slackode-jobs` ·
confirmation card · promotion/rollback commands. *Milestone: a layperson
commissions a recurring computed report end-to-end in Slack.*

**Phase 5 — proactivity polish**
Delta narration everywhere · watchers · digest · suggestion loop.

---

## 10. Flagship migration: AI-utilization weekly

Current state: `~/projects/metrics/ai-feature-utilization/` (report script,
puller, dashboard builder) + launchd job `com.narmi.ai-utilization-weekly` on
Nathan's laptop + Keychain token. Working, but laptop-bound.

Migration (Phase 2):

1. Add `RECIPE.md` next to the script in the metrics repo; adapt
   `ai_feature_report_to_slack.py` to **emit summary JSON and chart paths**
   instead of posting (the executor owns Slack I/O — the script loses its
   token dependency entirely, which is strictly better).
2. Register `narmi/metrics` with the repo manager; create the job row pinned to
   the current SHA; channel `C098SV5UUQH`; cron `0 8 * * 5` America/Chicago.
3. Probation: first 3 Fridays DM Nathan. Then retire the launchd plist and
   Keychain entry.
4. Verify once in the deployed environment: container → OpenSearch reachability
   (`curl https://opensearch.internal.narmitech.com` from inside the container).

---

## 11. Engineering notes & gotchas (from codebase survey)

- **Single instance assumed.** Scheduler runs in-process; `next_run_at`
  claim-before-run makes double-fire unlikely but not impossible across
  restarts. Fine now; a `locked_by/locked_at` column is the future multi-replica
  hook. Also set `busy_timeout` on the DB connection — WAL helps reads, not
  write contention.
- **Reaper**: exclude `job::` sessions (`src/coding-session.ts:604-616`) or they
  die mid-run at 30 min idle; runner enforces its own wall-clock timeout instead.
- **No cancel API** on `promptAsync` — the runner's abort/timeout wrapper is the
  only kill switch; `schedule pause` prevents *future* runs only.
- **Entrypoint repo-sync loop** (entrypoint.sh:172-212) pulls repos hourly —
  irrelevant to pinned-SHA worktrees (they don't move), but recipe updates
  require an explicit `ref` re-pin, by design.
- **tools.json / opencode config restarts**: tool-config changes restart the
  shared Q&A server (`src/index.ts:315-316`); job runs use their own servers so
  they're insulated, but avoid config churn mid-run anyway.
- **Session bloat**: job runs create opencode sessions; clean them with the run
  record (delete session on run completion) rather than accreting.
- **Read-only rootfs**: all script output must target `/tmp` (2G tmpfs, exec) —
  bake into the run contract.
- **Image deps**: python3/uv/curl/gh already present; `croner` is the only new
  npm dep for Phase 1.

## 12. Open questions

1. **Distillation quality** — the freeze step (session → RECIPE.md + script) is
   the hardest new ML-ish problem here. Mitigations: probation catches wobble;
   distilled scripts are small; the witnessed run's actual commands are in the
   session transcript to distill *from*. Needs prompt-engineering iteration.
2. **Watcher economics** — an hourly watcher is ~720 agent sessions/month.
   Cheap deterministic pre-checks (script exit code gates the agent session)
   should be the default pattern for high-frequency watchers.
3. **Who owns `slackode-jobs`** — org placement, branch protection (bot pushes
   to main? PRs-only with auto-merge?), and whether bot commits need a service
   identity distinct from `GIT_TOKEN`.
4. **Channel-membership consent** — should a channel opt in before a bot job
   posts there on a schedule (beyond the creator being a member)?
5. **Per-job secrets** — flagship needs none (OpenSearch is unauthenticated
   internally; Slack posting is the bot's own token), but the first job needing
   a third-party API key forces a scoped-secret story (likely: encrypted in the
   `tools` table pattern, granted per-job, injected as env into the run).
