# Scheduling, Child Sessions, and Alarms in OpenCode

Status: draft plan. No code changes yet.

## 1. Problem and goals

OpenCode already runs a long-lived server/daemon and can spawn sub-agents via the `task` tool, but it has no durable notion of:
- child sessions that outlive a single turn and report back,
- self-alarms / reminders ("wake me in 30 min"),
- OS-level recurring processes ("run an agent every hour").

The external Claude Session Manager (CSM, `~/code/claude-session-manager`) already proves this pattern on top of Claude Code: it injects `[Session Manager Context]`, spawns child sessions, sets alarms, and uses a babysitter. OpenCode should absorb the equivalent capability natively, without depending on CSM.

Goals:
1. Native child-session spawning with parent linkage and DONE/FAILED callbacks.
2. Self-alarms and crash/stall recovery (babysitter) inside the OpenCode server.
3. OS-native recurring scheduling on macOS/Linux/Windows, with a supervisor wrapper for locking, timeout, and observability.
4. A system prompt that makes the agent use these tools correctly and finish tasks to their Definition of Done.

Non-goals: clustered ownership, distributed execution, post-crash provider retry (deferred per V2 spec).

## 2. How CSM does it today

- In-process `TaskQueue` (priority + concurrency + delayed tasks) with `setTimeout`.
- Babysitter polls process liveness; crash retry (3x), stall detection (5 min), permission escalation.
- Alarms: persistent, time-from-last-activity, skip normal crash handling while armed.
- Child sessions: `POST /api/sessions/start` with `reply_to_session_id`, `delegation_task`, `agent`; child receives `[Delegation Contract]` and must POST DONE/FAILED to parent.
- OS registration: none for alarms (process must stay alive); CSM relies on the server process. For recurring jobs it does not use OS schedulers directly.

Key lesson: alarms and crash recovery only work while the host process lives. For "run every hour even after reboot", OS scheduling is required.

## 3. OS-native scheduling (research)

### macOS — `launchd`
- LaunchAgents in `~/Library/LaunchAgents`, label `com.opencode.job.<scope>.<slug>`.
- `StartCalendarInterval` (cron fields: Minute/Hour/Day/Month/Weekday). Wildcards = omitted keys; lists/ranges expanded into multiple entries.
- Native missed-run catch-up after sleep/wake.
- `AbandonProcessGroup=true` so children survive supervisor exit.
- Load/unload via `launchctl bootstrap/bootout gui/<uid>`; manual trigger via `launchctl kickstart -k`.
- PATH must be embedded in plist.

### Linux
- Prefer `systemd` user units with `OnCalendar=` and `Persistent=true` (catch-up).
- Fallback: `crontab` entries wrapped in markers, pointing at supervisor.
- No native catch-up in cron.

### Windows — `schtasks`
- `schtasks /Create /TN \OpenCode\opencode-job-<scope>-<slug>`.
- Cron subset only: MINUTE/HOURLY/WEEKLY/MONTHLY/DAILY; cannot combine day-of-month + weekday.
- No supervisor wrapper in the reference implementation (no locking/timeout).
- No missed-run catch-up guarantee beyond OS.

### Cross-cutting: supervisor wrapper
Reference: `supervisor.pl` (opencode-scheduler):
- file-based lock (pid liveness, stale-lock cleanup),
- `OPENCODE_PERMISSION={"questions":"allow"}` for non-interactive runs,
- timeout via SIGALRM (default 3600s),
- atomic JSON writes + JSONL run history,
- stdout/stderr redirection to log files.

Recommendation: ship an OpenCode-owned supervisor (TS/Effect, not Perl) so behavior is uniform and testable; keep platform backends thin.

## 4. Proposed OpenCode architecture

### 4.1 New core service: Scheduler

Location: `packages/core/src/scheduler` (or `packages/opencode/src/scheduler`), following V2 placement rules (Location-scoped for fs/env, process-global for queue).

Responsibilities:
- Job CRUD: `{ id, scope, name, schedule (cron), command, workdir, agent, timeout, enabled }`.
- Platform backend selection by `process.platform`.
- Install/uninstall OS artifacts (plist/systemd unit/schtasks/cron line) pointing at `opencode run-job <id>` (or `opencode run --prompt ...`).
- Supervisor: locking, timeout, env, logging, run records.
- Run history: JSONL per job + status in DB.

CLI additions:
- `opencode scheduler add|list|remove|run <job>` (or `opencode job ...`).
- `opencode run-job --id <id>` invoked by OS.

### 4.2 Child sessions (in-process, durable)

Reuse V2 session inbox:
- `Session.create` + `Session.prompt` with `delivery: steer|queue`.
- Add parent linkage: `reply_to_session_id`, `delegation_task` stored in session metadata.
- When a child completes, it POSTs/replies DONE/FAILED to parent; parent is woken via existing inbox `wake`.
- Agent tool `task` already spawns subagents; extend to create a durable child session and await callback instead of blocking.

### 4.3 Alarms / reminders

- `Session.alarm` table: `{ sessionID, message, checkAfterMs, armedAt, persistent }`.
- Babysitter (process-global, in server): polls armed alarms; when `now - lastActivity >= checkAfterMs`, enqueues `resume` with the alarm message.
- While armed, skip crash/stall handling for that session.
- Disarm on success; re-arm automatically if persistent.

### 4.4 Tools exposed to the agent

New tools (or HTTP endpoints):
- `schedule_job` / `list_jobs` / `remove_job` / `run_job_now`
- `set_alarm` / `cancel_alarm` / `list_alarms`
- `spawn_session` (child) with parent linkage (already via task/HTTP).

### 4.5 Storage

- Jobs and alarms in the existing SQLite (V2 session DB or a small scheduler DB).
- Run records in `~/.config/opencode/scheduler/scopes/<scope>/runs/<slug>.jsonl` (match opencode-scheduler layout) for human inspection.
- Logs in `~/.config/opencode/logs/scheduler/<scope>/`.

### 4.6 Permissions

- Scheduled runs set `OPENCODE_PERMISSION={"questions":"allow"}` (or opencode's equivalent permission policy) to avoid hangs.
- Child sessions inherit parent permission ruleset unless overridden.

### 4.7 V2 compatibility

- Scheduler jobs invoke `opencode run` (CLI) which creates a fresh session each time — matches the user's "fresh agent with 0 context" preference.
- Alarms and babysitter are process-local; a server restart loses in-flight timers but durable rows survive; on startup, re-arm pending alarms.

## 5. System prompt changes (proposal)

See `specs/v2/system-prompt-proposal.md`.

## 6. Open questions

- Should scheduling be core (this repo) or a plugin? User wants it part of OpenCode. Recommend core service + thin plugin surface.
- Windows catch-up: document limitation; rely on schtasks "run missed" option where possible.
- Alarm persistence across process restart: re-arm from DB on boot.
- Token economy: make subagent spawning the default for large tasks; document why.
- Definition of Done: three types (research/report, state change, software engineering) with examples.

## 7. Implementation order (suggested)

1. Child sessions + alarms in server (no OS scheduling).
2. Babysitter + alarm tool.
3. Scheduler core + macOS launchd backend.
4. Linux systemd + cron fallback.
5. Windows schtasks.
6. System prompt rewrite.
7. E2E tests per backend (mocked where OS unavailable).
