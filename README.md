# herdr-orchestrator

An oh-my-pi extension that lets the agent spawn, adopt, and supervise CLI agents
inside [Herdr](https://herdr.dev) the same way it uses native subagents.

The agent calls one tool. Herdr creates the pane, tab, or workspace, starts the
named agent, and the extension keeps a row above the editor that shows the
agent's live Herdr state and heartbeat. With no tracked agents the widget is
not rendered at all. Agents that are already running get the same row through
adoption, including agents started by hand or by another session.

```
 herdr orchestrator · 2 agents · / · next heartbeat in 2s · 1 working
   > reviewer  working  4m12s  claude  w1:p45  Reviewing the diff
   + helper    done       15s  omp     w2:p2   Reply with exactly READY.
```

## Install

```bash
omp plugin link ~/omp-herdr-orchestrator
```

The extension then loads in every oh-my-pi session. It needs oh-my-pi to run
inside a Herdr pane: `HERDR_ENV=1` and `HERDR_PANE_ID` are set by Herdr itself.
Outside Herdr the tools report a clear error and no row is rendered.

To load it for one run only:

```bash
omp -e ~/omp-herdr-orchestrator/src/index.ts
```

## Tools

| Tool | Purpose |
|---|---|
| `herdr_spawn` | Create a pane, tab, or workspace and start a named agent there |
| `herdr_adopt` | Attach to an agent that is already running, or to all of them |
| `herdr_prompt` | Submit one prompt, optionally waiting for a settled state |
| `herdr_read` | Read the agent: its session transcript, or its screen as text |
| `herdr_wait` | Synchronous bounded settle check; never the monitor |
| `herdr_status` | Report the roster, heartbeat, and untracked Herdr agents |
| `herdr_keys` | Answer an approval or question dialog with logical keys |
| `herdr_focus` | Move the user's view to an agent (only when asked) |
| `herdr_close` | Close the surface this session created and drop the row |
| `herdr_forget` | Stop tracking an agent and end its heartbeat; the agent keeps running |

`herdr_spawn` arguments that matter:

- `placement`: `pane` splits the current tab, `tab` opens a tab in this
  workspace, `workspace` opens a new workspace.
- `direction`: `right` on panes at least 140 columns wide, `down` otherwise.
- `prompt` and `wait_ms`: submit the first task, optionally waiting for settle.
- `notify`: `wake` (default) wakes this session on settle, `notify` updates the
  UI only, `none` stays silent.
- `focus`: false by default, so the user's focus does not move.

## Adopting an existing agent

Agents you did not spawn get the same row, heartbeat, and supervision tools:

```
herdr_adopt target=reviewer heartbeat_ms=5000   # by live name
herdr_adopt target=w1:p45 heartbeat_ms=5000     # by pane id, for an agent with no name
herdr_adopt all=true heartbeat_ms=5000          # every live agent except this session's own pane
/herdr adopt all 5000                           # the same thing from the keyboard
```

Adoption sends one named notification per newly adopted agent, including an agent that is already
`idle` or `done`; otherwise that settled row would be silent because there is no transition. The
heartbeat then sends one notification per later state change.

Adoption changes what the roster knows, not who owns the agent:

- the row, heartbeat, and `herdr_prompt` / `herdr_read` / `herdr_wait` /
  `herdr_keys` all apply;
- `spawnedByUs` stays false, so `herdr_close` still needs `force=true`;
- the settle notice defaults to `notify` (UI only), because an adopted agent is
  not this session's work stream; pass `notify=wake` when it is.

### Reading an adopted session

Herdr reports the conversation path it recognises for an agent
(`agent_session.value`). `herdr_read source=transcript` reads that file and
returns the last turns as text:

```
herdr_read target=reviewer source=transcript turns=20
```

The reader accepts the shapes omp/pi, Claude Code, and Codex write, keeps user
and assistant turns, and drops tool traffic and metadata. When Herdr reports no
path for that agent, the tool says so and points at the screen sources.

`herdr agent attach` is a Herdr action for a human client: it moves the TUI onto
that agent and needs a terminal. The plugin does not call it. Use `herdr_focus`
to bring an agent's pane into view, and `herdr_read source=transcript` to see
what it actually said.

## The roster row

One header line plus one row per tracked agent, drawn above the editor.

The header has no heartbeat. A working agent shows **hb in Ns** on its own row, counted down by a
one-second UI clock. Idle, done, blocked and gone rows show no heartbeat. When a working heartbeat
reaches zero, its timer resets and the orchestrator receives a named check-in wake, like a subagent
turn ending. A poll timeout leaves the error visible without creating a settled-agent heartbeat.

The roster uses the active OMP theme: accent for the header and working agents, warning for blocked
or due heartbeats, success for done agents, muted for idle rows and detail text, error for failures,
and dim for metadata. It does not add a second footer counter; the roster row is the only status
surface. When an agent's per-agent countdown reaches zero, its timer resets and a named heartbeat
wake is emitted; working agents reset silently, and no global header heartbeat exists.

Reload the extension in a running session with `/reload-plugins`. The roster is session-scoped and
survives the reload. If the host reuses the cached extension module after a source edit, start a
fresh OMP session; `/reload-plugins` then loads the new factory. The tracked agents themselves do
not restart.

- The header renders only while at least one agent is tracked. With no agents
  the widget is hidden: no spinner, countdown, or footer. The spinner advances
  every poll; a frozen spinner means the timer stopped, and a failed poll says
  so in the header.
- Rows sort by urgency: blocked, working, unknown, idle or done, gone.
- Each row shows the state glyph, name, state, time in that state, kind, pane
  id, and the agent's terminal title or the task it was given.
- A `gone` row appears when Herdr no longer lists the agent, and is forgotten
  after 30 minutes.

Polling costs one `herdr agent list` per tick, and none while the roster is
empty. Default interval is 3 seconds. The heartbeat countdown is UI-only and
repaints every second; it does not spawn a Herdr process.

## Commands

| Command | Effect |
|---|---|
| `/herdr status` | Print the current roster |
| `/herdr adopt <name\|all>` | Track an already-running agent |
| `/herdr poll 5000` | Change the heartbeat interval |
| `/herdr hide` / `/herdr show` | Hide or restore the row for this session |
| `/herdr forget <name\|all>` | Drop a row without touching the agent |

## Environment

| Variable | Effect |
|---|---|
| `HERDR_ORCH_POLL_MS` | Heartbeat interval at startup, clamped to 1000–60000 |
| `HERDR_ORCH_SESSION` | Target a named Herdr session instead of the inherited one (tests only) |

The roster persists at
`~/.omp/agent/herdr-orchestrator/roster-<sessionId>.json`, so a resumed session
re-attaches to agents that are still alive, and a different session starts with
its own clean roster.

## Safety rules the plugin enforces

- A surface created here is closed if `agent start` fails, and only then.
- `herdr_close` refuses an agent this session did not spawn unless `force=true`.
- Closing a workspace, tab, or pane this plugin created is its own decision;
  closing anything else is not.
- Background work never focuses a pane. `herdr_focus` exists for the case where
  the user asked to look at an agent.
- Nothing polls `agent get` in a loop. Supervision relies on the roster heartbeat and its
  settle wake; `herdr_wait` is only a deliberate synchronous check.

## Tests

```bash
bun test                                     # unit tests, no Herdr needed
HERDR_ORCH_SESSION=hortest bun scripts/live-smoke.ts   # live client proof in an isolated session
```

The live script creates its own workspace in a named session, starts one agent,
prompts it, waits, reads the screen, and closes the workspace. It never touches
the workspace you are working in.

## Do not use `herdr_wait` as a monitor

`herdr_wait` is a synchronous tool: it holds the current turn until a target settles. It is useful
for a bounded check, but it is not the background monitor. The heartbeat and roster are the
asynchronous path; `notifyTransition` calls `pi.sendMessage(..., { deliverAs: "followUp",
triggerTurn: true })` on each settled transition, the same event-driven shape as an OMP
`agent()` handle. Use `herdr_wait` only when you deliberately want to block for one check, and
never as the supervisor loop.

The native OMP equivalent is `agent()`/`workpool()`: those return handles immediately and their
results auto-deliver; `wait()` is a barrier for when the parent has no independent work left.
For Herdr, `herdr_spawn` (default `notify=wake`) is the spawn, and the roster wake is the
delivery. If a bounded wait is unavoidable, run `herdr agent wait` as a named background job
so its completion is delivered as a follow-up; do not hold a foreground tool call.

`heartbeat_ms` is required on adoption. The extension refuses an attachment without a positive
integer. Use at least `600000` for a ten-minute working check-in; each row carries its own
countdown, and the header has no global heartbeat timer. Settled rows never schedule a heartbeat.
