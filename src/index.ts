/**
 * herdr-orchestrator — spawn and supervise Herdr-hosted CLI agents from oh-my-pi.
 *
 * The bridge this plugin crosses: native subagents are spawned, streamed, and watched by omp;
 * this gives the same shape for agents living in Herdr panes, tabs, and workspaces, with one
 * permanent named row per agent above the editor and a heartbeat that proves the monitor loop
 * is alive.
 *
 * Invariants:
 * - Every mutating call goes through the `herdr` CLI; nothing is predicted, ids come back from herdr.
 * - The heartbeat tick never spawns a process unless there is a record to observe.
 * - A surface created by this plugin is closed on a failed start, and only then.
 * - Close never touches a surface this plugin did not create unless `force` is explicit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { HerdrClient, HerdrError, type HerdrAgent, type HerdrAgentState } from "./herdr";
import { TRANSCRIPT_TURNS_DEFAULT, readTranscript } from "./transcript";
import {
	type AgentRecord,
	type NotifyMode,
	type ObservedState,
	type Placement,
	SPINNER_FRAMES,
	adoptRecord,
	describeRecord,
	findRecord,
	formatRoster,
	observeAgents,
	shouldNotifyTransition,
	parseRosterFile,
	removeRecord,
	rosterFileName,
	serializeRosterFile,
	settleSummary,
	upsertRecord,
	validateAgentName,
} from "./roster";

const ROSTER_DIR = path.join(os.homedir(), ".omp", "agent", "herdr-orchestrator");
const ROSTER_FILE_LEGACY = path.join(ROSTER_DIR, "roster.json");
const WIDGET_KEY = "herdr-orchestrator";
const POLL_MS_DEFAULT = 3000;
const POLL_MS_MIN = 1000;
const POLL_MS_MAX = 60_000;
const WAIT_MS_DEFAULT = 300_000;
const WAIT_MS_MAX = 1_800_000;
const START_TIMEOUT_MS = 45_000;
const GONE_RETENTION_MS = 30 * 60_000;
const READ_LINES_DEFAULT = 80;
const READ_LINES_MAX = 2000;
const SCREEN_SOURCES = ["recent-unwrapped", "recent", "visible", "detection"] as const;
const READ_SOURCES = [...SCREEN_SOURCES, "transcript"] as const;
const PLACEMENTS: readonly Placement[] = ["pane", "tab", "workspace"];
const NOTIFY_MODES: readonly NotifyMode[] = ["wake", "notify", "none"];
const KEYS_PATTERN = /^(esc|escape|enter|tab|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|shift\+tab|ctrl\+[a-z]|alt\+[a-z]|[0-9]|y|n|a|q)$/;

/** The slice of the host UI context this plugin draws through. */
interface RosterUi {
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	setStatus(key: string, text: string | undefined): void;
	readonly theme: { fg(color: any, text: string): string };
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface OrchestratorState {
	cli: HerdrClient | undefined;
	session: string | undefined;
	records: AgentRecord[];
	ui: RosterUi | undefined;
	/** Re-arms the heartbeat; the epoch guard retires a timer superseded by a poll-interval change. */
	schedule: ((callback: () => void, ms: number) => void) | undefined;
	epoch: number;
	tick: number;
	polling: boolean;
	failures: number;
	lastPollAt: number | undefined;
	nextPollAt: number | undefined;
	lastError: string | undefined;
	hidden: boolean;
	pollMs: number;
	/** This session's roster mirror; one file per omp session id. */
	rosterFile: string;
}

function messageOf(error: unknown): string {
	if (error instanceof HerdrError) return `${error.code}: ${error.message}`;
	if (error instanceof Error) return error.message;
	return String(error);
}

function loadRecords(file: string): AgentRecord[] {
	try {
		return parseRosterFile(fs.readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

function persistRecords(file: string, records: readonly AgentRecord[]): void {
	try {
		fs.mkdirSync(ROSTER_DIR, { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temp, serializeRosterFile(records));
		fs.renameSync(temp, file);
	} catch {
		// The roster is a convenience mirror; a read-only home directory must not break supervision.
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export default function herdrOrchestrator(pi: ExtensionAPI) {
	const z = pi.zod;
	const state: OrchestratorState = {
		cli: undefined,
		session: undefined,
		records: [],
		ui: undefined,
		schedule: undefined,
		epoch: 0,
		tick: 0,
		polling: false,
		failures: 0,
		lastPollAt: undefined,
		nextPollAt: undefined,
		lastError: undefined,
		hidden: false,
		pollMs: POLL_MS_DEFAULT,
		rosterFile: ROSTER_FILE_LEGACY,
	};

	function saveRoster(): void {
		persistRecords(state.rosterFile, state.records);
	}

	function terminalWidth(): number {
		return process.stdout.columns ?? 120;
	}

	function render(): void {
		const ui = state.ui;
		if (!ui) return;
		expireHeartbeats();
		if (state.hidden || state.records.length === 0) {
			ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines = formatRoster({
			records: state.records,
			tick: state.tick,
			now: Date.now(),
			width: terminalWidth(),
			error: state.lastError,
			lastPollAt: state.lastPollAt,
			nextPollAt: state.nextPollAt,
			paint: (color, text) => ui.theme.fg(color, text),
		});
		ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
	}

	/** herdr is only reachable from inside a Herdr pane, or from an explicit test session. */
	function requireClient(signal?: AbortSignal): HerdrClient {
		if (state.cli) return state.cli;
		const session = process.env.HERDR_ORCH_SESSION;
		const inside = process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
		if (!inside && !session) {
			throw new Error(
				"herdr is not reachable: start oh-my-pi inside a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID must be set)",
			);
		}
		state.session = session;
		state.cli = new HerdrClient({
			session,
			exec: (command, args, options) =>
				pi.exec(command, args, { timeout: options?.timeout, cwd: options?.cwd, signal: options?.signal ?? signal }),
		});
		return state.cli;
	}

	function wake(text: string, agentName?: string): void {
		try {
			pi.sendMessage(
				{ customType: agentName ? `herdr-orchestrator:${agentName}` : "herdr-orchestrator", content: [{ type: "text", text }], display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			pi.logger.warn(`herdr-orchestrator: could not deliver wake: ${messageOf(error)}`);
		}
	}

	function notifyRecord(record: AgentRecord, text: string, next: string): void {
		if (record.notify === "none") return;
		state.ui?.notify(text + next, record.state === "blocked" ? "warning" : "info");
		if (record.notify === "wake") wake(text + next, record.name);
	}

	function notifyTransition(from: ObservedState, to: ObservedState, record: AgentRecord): void {
		if (!shouldNotifyTransition(from, to)) return;
		const text =
			to === "gone"
				? `Herdr agent gone: ${settleSummary(record, from, to)}`
				: `Herdr agent settled: ${settleSummary(record, from, to)}`;
		const next =
			to === "blocked"
				? " It is waiting on an approval or question: herdr_read it, then answer with herdr_keys."
				: to === "gone"
					? ""
					: " Read its output with herdr_read, or send more work with herdr_prompt.";
		notifyRecord(record, text, next);
	}

	function notifyAdopted(record: AgentRecord): void {
		const text = `Herdr agent adopted: ${record.name} · ${record.state} · ${record.title || record.task || "no title"}`;
		const next =
			record.state === "blocked"
				? " It is waiting on an approval or question: herdr_read it, then answer with herdr_keys."
				: record.state === "working"
					? " It is already working; supervision will wake on the next settled state."
					: " It is not working now. Read its output with herdr_read, or send more work with herdr_prompt.";
		notifyRecord(record, text, next);
	}

	function notifyHeartbeat(record: AgentRecord): void {
		const text = `Herdr heartbeat due: ${record.name} · working · ${record.title || record.task || "no title"}. Check what it is doing and steer it if needed.`;
		const next =
			record.state === "blocked"
				? " It is waiting on an approval or question: herdr_read it, then answer with herdr_keys."
				: " Read its output with herdr_read, or send more work with herdr_prompt.";
		notifyRecord(record, text, next);
	}

	function expireHeartbeats(now = Date.now()): void {
		let changed = false;
		for (const record of state.records) {
			if (record.state !== "working") {
				if (record.nextHeartbeatAt !== undefined) {
					record.nextHeartbeatAt = undefined;
					changed = true;
				}
				continue;
			}
			if (record.nextHeartbeatAt === undefined || record.nextHeartbeatAt > now) continue;
			record.nextHeartbeatAt = now + (record.heartbeatMs ?? 600_000);
			changed = true;
			notifyHeartbeat(record);
		}
		if (changed) saveRoster();
	}

	async function pollOnce(): Promise<void> {
		state.tick += 1;
		if (state.hidden || !state.ui) return;
		if (state.records.length === 0) {
			// Nothing to observe: tick the heartbeat locally so the row stays alive without a process per tick.
			render();
			return;
		}
		if (state.polling) return;
		state.polling = true;
		state.lastPollAt = Date.now();
		state.nextPollAt = state.lastPollAt + state.pollMs;
		try {
			const live = await requireClient().listAgents();
			const merged = observeAgents(state.records, live, Date.now(), { goneRetentionMs: GONE_RETENTION_MS, heartbeatMs: state.pollMs });
			state.records = merged.records;
			state.lastPollAt = Date.now();
			state.lastError = undefined;
			state.failures = 0;
			saveRoster();
			render();
			for (const transition of merged.transitions) {
				notifyTransition(transition.from, transition.to, transition.record);
			}
		} catch (error) {
			state.failures += 1;
			state.lastError = messageOf(error);
			render();
		} finally {
			state.polling = false;
			render();
		}
	}

	function armHeartbeat(): void {
		state.epoch += 1;
		state.schedule?.(() => void pollOnce(), state.pollMs);
	}

	function applyPollMs(next: number): void {
		state.pollMs = clamp(Math.round(next), POLL_MS_MIN, POLL_MS_MAX);
		armHeartbeat();
	}

	function recordFromSpawn(input: {
		name: string;
		kind: string;
		placement: Placement;
		paneId: string;
		tabId?: string;
		workspaceId?: string;
		cwd: string;
		label?: string;
		task?: string;
		notify: NotifyMode;
		agent?: HerdrAgent;
	}): AgentRecord {
		const now = Date.now();
		return {
			name: input.name,
			kind: input.agent?.agent ?? input.kind,
			placement: input.placement,
			paneId: input.agent?.paneId ?? input.paneId,
			tabId: input.agent?.tabId || input.tabId,
			workspaceId: input.agent?.workspaceId || input.workspaceId,
			cwd: input.agent?.cwd || input.cwd,
			label: input.label,
			task: input.task,
			notify: input.notify,
			spawnedByUs: true,
			createdAt: now,
			updatedAt: now,
			state: input.agent?.state ?? "unknown",
			stateSince: now,
			heartbeatMs: 600_000,
			nextHeartbeatAt: (input.agent?.state ?? "unknown") === "working" ? now + 600_000 : undefined,
			lastSeq: input.agent?.stateSeq ?? 0,
			title: input.agent?.title,
			sessionPath: input.agent?.sessionPath,
		};
	}

	function toolText(text: string, details?: unknown, isError?: boolean) {
		return { content: [{ type: "text" as const, text }], details, isError };
	}

	pi.registerTool({
		name: "herdr_spawn",
		label: "Herdr Spawn",
		description:
			"Spawn a CLI agent inside Herdr and track it. placement=pane splits the current tab (default), " +
			'placement=tab opens a new tab in this workspace, placement=workspace opens a new workspace. ' +
			"The agent is registered on the live roster row above the editor, which reports its herdr state " +
			"(working/idle/blocked/done) and a heartbeat on every poll. Use herdr_prompt to give it work and " +
			"herdr_read to read its screen. Spawning is herdr's `agent start`, so the name must be unique among " +
			"live agents and match [a-z][a-z0-9_-]{0,31}.",
		parameters: z.object({
			name: z.string().describe("Unique live agent name, [a-z][a-z0-9_-]{0,31}"),
			kind: z
				.string()
				.optional()
				.describe("Agent kind to start, e.g. omp (default), claude, codex, gemini, cursor, opencode"),
			placement: z.string().optional().describe('"pane" (default), "tab", or "workspace"'),
			direction: z.string().optional().describe('Pane split direction: "right" (default on wide panes) or "down"'),
			cwd: z.string().optional().describe("Working directory for the new surface (default: this session's cwd)"),
			label: z.string().optional().describe("Tab or workspace label (default: herdr:<name>)"),
			args: z.array(z.string()).optional().describe("Native agent arguments, passed after `--`"),
			prompt: z.string().optional().describe("Optional first task, submitted with herdr agent prompt"),
			wait_ms: z
				.number()
				.optional()
				.describe("With prompt: wait up to this many ms for the agent to settle (default 0 = return on submit)"),
			notify: z
				.string()
				.optional()
				.describe('What to do when it settles: "wake" (default), "notify" (UI only), "none"'),
			focus: z.boolean().optional().describe("Focus the new surface (default false: your focus stays put)"),
			start_timeout_ms: z.number().optional().describe("How long herdr waits for the agent to become ready"),
		}),
		approval: "write",
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const cli = requireClient(signal);
				const name = params.name.trim();
				const invalid = validateAgentName(name);
				if (invalid) return toolText(invalid, { name }, true);

				const placement = (params.placement ?? "pane") as Placement;
				if (!PLACEMENTS.includes(placement)) {
					return toolText(`placement must be one of ${PLACEMENTS.join(", ")}`, { placement }, true);
				}
				const direction = (params.direction ?? (terminalWidth() >= 140 ? "right" : "down")) as "right" | "down";
				if (direction !== "right" && direction !== "down") {
					return toolText('direction must be "right" or "down"', { direction }, true);
				}
				const notify = (params.notify ?? "wake") as NotifyMode;
				if (!NOTIFY_MODES.includes(notify)) {
					return toolText(`notify must be one of ${NOTIFY_MODES.join(", ")}`, { notify }, true);
				}

				const live = await cli.listAgents({ signal });
				const taken = live.some(agent => agent.name === name);
				if (taken) {
					return toolText(`herdr already has a live agent named ${name}; pick another name`, { name }, true);
				}

				const cwd = params.cwd ?? ctx.cwd;
				const kind = params.kind ?? "omp";
				const focus = params.focus ?? false;
				let paneId: string;
				let tabId: string | undefined;
				let workspaceId: string | undefined;
				const closers: Array<() => Promise<void>> = [];
				let placementUsed: Placement = placement;

				if (placement === "pane") {
					paneId = await cli.splitPane({
						pane: process.env.HERDR_PANE_ID,
						direction,
						cwd,
						focus,
						signal,
					});
					closers.push(() => cli.closePane(paneId));
					tabId = process.env.HERDR_TAB_ID;
					workspaceId = process.env.HERDR_WORKSPACE_ID;
				} else if (placement === "tab") {
					const workspace = process.env.HERDR_WORKSPACE_ID;
					if (!workspace) {
						return toolText("placement=tab needs HERDR_WORKSPACE_ID; run omp inside a Herdr pane", {}, true);
					}
					const created = await cli.createTab({
						workspace,
						cwd,
						label: params.label ?? `herdr:${name}`,
						focus,
						signal,
					});
					paneId = created.paneId;
					tabId = created.tabId;
					workspaceId = workspace;
					closers.push(() => cli.closeTab(created.tabId));
				} else {
					const created = await cli.createWorkspace({
						cwd,
						label: params.label ?? `herdr:${name}`,
						focus,
						signal,
					});
					paneId = created.paneId;
					tabId = created.tabId;
					workspaceId = created.workspaceId;
					closers.push(() => cli.closeWorkspace(created.workspaceId));
				}

				let agent: HerdrAgent | undefined;
				try {
					agent = await cli.startAgent({
						name,
						kind,
						pane: paneId,
						timeoutMs: params.start_timeout_ms ?? START_TIMEOUT_MS,
						args: params.args,
						signal,
					});
				} catch (error) {
					const cleanupErrors: string[] = [];
					for (const close of closers) {
						try {
							await close();
						} catch (closeError) {
							cleanupErrors.push(messageOf(closeError));
						}
					}
					const suffix =
						cleanupErrors.length > 0 ? ` (surface cleanup also failed: ${cleanupErrors.join("; ")})` : "";
					return toolText(`agent start failed: ${messageOf(error)}${suffix}`, { name, kind }, true);
				}

				const record = recordFromSpawn({
					name,
					kind,
					placement: placementUsed,
					paneId,
					tabId,
					workspaceId,
					cwd,
					label: params.label,
					task: params.prompt,
					notify,
					agent,
				});
				state.records = upsertRecord(state.records, record);
				saveRoster();
				state.lastPollAt = Date.now();
				state.lastError = undefined;
				render();

				let settledNote = "";
				if (params.prompt) {
					try {
						await cli.promptAgent({
							target: name,
							text: params.prompt,
							wait: (params.wait_ms ?? 0) > 0,
							timeoutMs: (params.wait_ms ?? 0) > 0 ? clamp(params.wait_ms!, 1, WAIT_MS_MAX) : undefined,
							signal,
						});
					} catch (error) {
						return toolText(
							`Agent ${name} started on ${record.paneId}, but the first prompt failed: ${messageOf(error)}. ` +
								`Inspect with herdr_read target=${name}.`,
							{ record },
							true,
						);
					}
					if ((params.wait_ms ?? 0) > 0) {
						const refreshed = await cli.getAgent(name, { signal }).catch(() => undefined);
						if (refreshed) {
							record.state = refreshed.state;
							state.records = upsertRecord(state.records, record);
							saveRoster();
							render();
						}
						settledNote = `\nSettled state: ${record.state}`;
					}
				}

				return toolText(
					`Started herdr agent ${name} (${record.kind}) on ${record.paneId} as ${placementUsed}.` +
						`\nState: ${record.state} · notify: ${notify}${params.prompt ? " · first prompt submitted" : ""}${settledNote}` +
						`\nTracked on the roster row; heartbeat polls every ${Math.round(state.pollMs / 1000)}s.`,
					{ record, placement: placementUsed, paneId: record.paneId, tabId: record.tabId, workspaceId: record.workspaceId },
				);
			} catch (error) {
				return toolText(`herdr_spawn failed: ${messageOf(error)}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "herdr_prompt",
		label: "Herdr Prompt",
		description:
			"Send text to a Herdr-hosted agent as one prompt (text plus Enter). Use wait=true to block until the agent " +
			'settles (idle, done, or blocked); otherwise it returns as soon as herdr reports the submission, which does ' +
			"not prove the turn started. An agent waiting at an approval dialog rejects the prompt with agent_blocked: " +
			"read it with herdr_read, then answer with herdr_keys.",
		parameters: z.object({
			target: z.string().describe("Live agent name or its pane id"),
			text: z.string().describe("Text to submit"),
			wait: z.boolean().optional().describe("Wait for a settled state (default false)"),
			until: z.array(z.string()).optional().describe('Explicit states to wait for, e.g. ["blocked"]'),
			timeout_ms: z.number().optional().describe("Wait budget in ms (default 300000, max 1800000)"),
		}),
		approval: "write",
		async execute(_id, params, signal) {
			try {
				const cli = requireClient(signal);
				const timeoutMs = clamp(params.timeout_ms ?? WAIT_MS_DEFAULT, 1, WAIT_MS_MAX);
				const agent = await cli.promptAgent({
					target: params.target,
					text: params.text,
					wait: params.wait ?? false,
					until: params.until,
					timeoutMs: (params.wait ?? false) || params.until ? timeoutMs : undefined,
					signal,
				});
				const record = findRecord(state.records, params.target);
				if (record && agent) {
					record.state = agent.state;
					record.title = agent.title;
					record.lastSeq = agent.stateSeq;
					state.records = upsertRecord(state.records, record);
					saveRoster();
					render();
				}
				const stateText = agent ? agent.state : "unknown";
				return toolText(
					`${params.wait ?? false ? "Settled: " : "Submitted to "}${params.target} (${stateText}).` +
						((params.wait ?? false) || params.until
							? ""
							: " The roster heartbeat will wake this session on the settle; keep working and do not call herdr_wait as a monitor."),
					{ agent, state: stateText },
				);
			} catch (error) {
				const hint =
					error instanceof HerdrError && error.code === "agent_blocked"
						? "\nThe agent is waiting at an approval or question dialog: herdr_read it, then answer with herdr_keys."
						: "";
				return toolText(`herdr_prompt failed: ${messageOf(error)}${hint}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "herdr_adopt",
		label: "Herdr Adopt",
		description:
			"Attach to agents that are already running in Herdr, including ones started by hand or by another " +
			"session. An adopted agent gets the same permanent roster row, heartbeat, and supervision tools " +
			"(herdr_prompt, herdr_read, herdr_wait, herdr_keys), and its own session transcript becomes readable " +
			"with herdr_read source=transcript. Adoption does not claim ownership: herdr_close still refuses it " +
			"without force. Pass a name or pane id, or all=true for every live agent except this pane.",
		parameters: z.object({
			target: z.string().optional().describe("Live agent name or pane id"),
			all: z.boolean().optional().describe("Adopt every live agent except this session's own pane"),
			heartbeat_ms: z.number().int().positive().describe("Per-agent heartbeat interval in milliseconds; required"),
			notify: z
				.string()
				.optional()
				.describe('Settle notice for adopted agents: "notify" (default, UI only), "wake", "none"'),
		}),
		approval: "write",
		async execute(_id, params, signal) {
			try {
				const cli = requireClient(signal);
				const notify = (params.notify ?? "notify") as NotifyMode;
				if (!NOTIFY_MODES.includes(notify)) {
					return toolText(`notify must be one of ${NOTIFY_MODES.join(", ")}`, { notify }, true);
				}
				if (!params.all && !params.target) {
					return toolText("pass target=<name|pane id> or all=true", {}, true);
				}
				if (!Number.isInteger(params.heartbeat_ms) || params.heartbeat_ms <= 0) {
					return toolText("heartbeat_ms must be a positive integer for every attachment", {}, true);
				}
				const now = Date.now();
				const live = (await cli.listAgents({ signal })).filter(agent => agent.paneId !== process.env.HERDR_PANE_ID);
				const matches = params.all
					? live
					: live.filter(agent => agent.name === params.target || agent.paneId === params.target);
				if (matches.length === 0) {
					const available = live.map(agent => agent.name ?? agent.paneId).join(", ") || "none";
					return toolText(`no live herdr agent matches ${params.target ?? "all"}; live agents: ${available}`, {}, true);
				}

				const adopted: string[] = [];
				const refreshed: string[] = [];
				for (const agent of matches) {
					const existing = findRecord(state.records, agent.name ?? agent.paneId);
					if (existing) {
						state.records = upsertRecord(state.records, {
							...existing,
							// Keep the owner's notify policy; refresh only what herdr reports.
							kind: agent.agent || existing.kind,
							paneId: agent.paneId,
							tabId: agent.tabId || existing.tabId,
							workspaceId: agent.workspaceId || existing.workspaceId,
							cwd: agent.cwd || existing.cwd,
							title: agent.title,
							sessionPath: agent.sessionPath ?? existing.sessionPath,
							state: agent.state,
							lastSeq: agent.stateSeq,
							heartbeatMs: params.heartbeat_ms,
							nextHeartbeatAt: agent.state === "working" ? now + params.heartbeat_ms : undefined,
							updatedAt: now,
						});
						refreshed.push(existing.name);
						continue;
					}
					const adoptedRecord = adoptRecord(agent, now, notify, params.heartbeat_ms);
					state.records = upsertRecord(state.records, adoptedRecord);
					notifyAdopted(adoptedRecord);
					adopted.push(agent.name ?? agent.paneId);
				}
				saveRoster();
				state.lastPollAt = now;
				state.nextPollAt = now + state.pollMs;
				state.lastError = undefined;
				render();
				const lines = [
					adopted.length > 0 ? `Adopted: ${adopted.join(", ")}` : "",
					refreshed.length > 0 ? `Already tracked: ${refreshed.join(", ")}` : "",
					`Roster checks every ${Math.round(state.pollMs / 1000)}s; per-agent heartbeat: ${params.heartbeat_ms}ms; notify: ${notify}.`,
					process.env.HERDR_PANE_ID
						? `Skipped this session's own pane (${process.env.HERDR_PANE_ID}); adoption covers other agents.`
						: "",
				].filter(Boolean);
				return toolText(lines.join("\n"), { adopted, refreshed, notify });
			} catch (error) {
				return toolText(`herdr_adopt failed: ${messageOf(error)}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "herdr_read",
		label: "Herdr Read",
		description:
			"Read a Herdr agent. source=transcript returns the agent's own session conversation from the file " +
			"herdr reports, which is the right choice for an adopted session. Screen sources return what the " +
			'TUI is drawing: use "recent-unwrapped" for transcripts and logs.',
		parameters: z.object({
			target: z.string().describe("Live agent name or pane id"),
			source: z.string().optional().describe(`"transcript", ${SCREEN_SOURCES.map(value => `"${value}"`).join(", ")}`),
			lines: z.number().optional().describe(`Screen rows to read (default ${READ_LINES_DEFAULT}, max ${READ_LINES_MAX})`),
			turns: z
				.number()
				.optional()
				.describe(`Transcript turns to read (default ${TRANSCRIPT_TURNS_DEFAULT})`),
			format: z.string().optional().describe('Screen format: "text" (default) or "ansi"'),
		}),
		async execute(_id, params, signal) {
			try {
				const cli = requireClient(signal);
				const source = params.source ?? "recent-unwrapped";
				if (!READ_SOURCES.includes(source as (typeof READ_SOURCES)[number])) {
					return toolText(`source must be one of ${READ_SOURCES.join(", ")}`, {}, true);
				}

				if (source === "transcript") {
					const record = findRecord(state.records, params.target);
					const sessionPath = record?.sessionPath ?? (await cli.getAgent(params.target, { signal })).sessionPath;
					if (!sessionPath) {
						return toolText(
							`herdr reports no agent session path for ${params.target}; it may not be a supported agent kind. ` +
								`Read its screen instead with source=recent-unwrapped.`,
							{},
							true,
						);
					}
					const text = readTranscript(sessionPath, { turns: params.turns });
					return toolText(text, { target: params.target, source, sessionPath });
				}

				const format = params.format === "ansi" ? "ansi" : "text";
				const text = await cli.readAgent({
					target: params.target,
					source: source as (typeof SCREEN_SOURCES)[number],
					lines: clamp(params.lines ?? READ_LINES_DEFAULT, 1, READ_LINES_MAX),
					format,
					signal,
				});
				return toolText(text.trim() || "(no output)", { target: params.target, source, format });
			} catch (error) {
				return toolText(`herdr_read failed: ${messageOf(error)}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "herdr_wait",
		label: "Herdr Wait",
		description:
			"Synchronous bounded check: wait for Herdr agents to reach a settled state, one herdr wait per target, " +
			"run in parallel. This blocks the current turn. NEVER use it as a monitor or in a supervision loop. " +
			"The roster heartbeat is the asynchronous path: herdr_spawn with notify=wake, or a background " +
			"`herdr agent wait`, wakes the session on a settled transition. A timeout returns settled=false " +
			"and is a wakeup, not a failure.",
		parameters: z.object({
			targets: z.array(z.string()).describe("Agent names or pane ids"),
			until: z.array(z.string()).optional().describe('Explicit states to wait for, e.g. ["blocked"]'),
			timeout_ms: z.number().optional().describe("Per-target budget in ms (default 300000, max 1800000)"),
		}),
		async execute(_id, params, signal) {
			const timeoutMs = clamp(params.timeout_ms ?? WAIT_MS_DEFAULT, 1, WAIT_MS_MAX);
			let cli: HerdrClient;
			try {
				cli = requireClient(signal);
			} catch (error) {
				return toolText(`herdr_wait failed: ${messageOf(error)}`, {}, true);
			}
			const results = await Promise.all(
				params.targets.map(async target => {
					try {
						const agent = await cli.waitAgent({ target, until: params.until, timeoutMs, signal });
						return {
							target,
							settled: true,
							state: agent?.state ?? "unknown",
							title: agent?.title,
							paneId: agent?.paneId,
						};
					} catch (error) {
						const code = error instanceof HerdrError ? error.code : "error";
						return { target, settled: false, code, error: messageOf(error) };
					}
				}),
			);
			for (const result of results) {
				const record = findRecord(state.records, result.target);
				if (!record || !result.settled) continue;
				record.state = result.state as HerdrAgentState;
				record.title = result.title ?? record.title;
				record.stateSince = Date.now();
				state.records = upsertRecord(state.records, record);
			}
			saveRoster();
			render();
			const summary = results
				.map(result =>
					result.settled
						? `${result.target}: ${result.state}${result.title ? ` · ${result.title}` : ""}`
						: `${result.target}: not settled (${result.error})`,
				)
				.join("\n");
			const anySettled = results.some(result => result.settled);
			return toolText(summary, { results }, !anySettled);
		},
	});

	pi.registerTool({
		name: "herdr_status",
		label: "Herdr Status",
		description:
			"Report the live Herdr roster: every agent this session tracks, its herdr state, how long it has held " +
			"that state, plus the heartbeat tick and last poll. Use it to decide the next supervision step.",
		parameters: z.object({
			targets: z.array(z.string()).optional().describe("Limit the report to these agents"),
		}),
		async execute(_id, params, signal) {
			try {
				const cli = requireClient(signal);
				const live = await cli.listAgents({ signal });
				state.lastPollAt = Date.now();
				state.lastError = undefined;
				const merged = observeAgents(state.records, live, Date.now(), { goneRetentionMs: GONE_RETENTION_MS, heartbeatMs: state.pollMs });
				state.records = merged.records;
				saveRoster();
				render();
				for (const transition of merged.transitions) {
					notifyTransition(transition.from, transition.to, transition.record);
				}

				const wanted = params.targets;
				const rows = state.records
					.filter(record => !wanted || wanted.includes(record.name) || (record.paneId && wanted.includes(record.paneId)))
					.map(record => describeRecord(record, Date.now()));
				const tracked = new Set(state.records.map(record => record.name));
				const foreign = live
					.filter(agent => agent.paneId !== process.env.HERDR_PANE_ID)
					.filter(agent => agent.name && !tracked.has(agent.name))
					.map(agent => `${agent.name} · ${agent.state} · ${agent.paneId} · ${agent.agent}${agent.sessionPath ? " · transcript available" : ""}`);
				const header =
					`herdr: ${state.records.filter(record => record.state !== "gone").length} tracked` +
					` · tick ${state.tick} (${SPINNER_FRAMES[state.tick % SPINNER_FRAMES.length]})` +
					` · poll every ${Math.round(state.pollMs / 1000)}s` +
					(state.lastPollAt ? ` · last poll ${Math.round((Date.now() - state.lastPollAt) / 1000)}s ago` : "") +
					(state.lastError ? ` · last error ${state.lastError}` : "");
				const text = [
					header,
					rows.length > 0 ? `\nTracked:\n${rows.map(row => `  ${row}`).join("\n")}` : "\nTracked: none",
					foreign.length > 0
						? `\nNot tracked (adopt with herdr_adopt target=<name> or all=true):\n${foreign
								.map(row => `  ${row}`)
								.join("\n")}`
						: "",
				]
					.filter(Boolean)
					.join("\n");
				return toolText(text, { records: state.records, live, tick: state.tick, pollMs: state.pollMs });
			} catch (error) {
				return toolText(`herdr_status failed: ${messageOf(error)}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "herdr_keys",
		label: "Herdr Keys",
		description:
			"Send logical keys to a Herdr-hosted agent, for answering an approval or question dialog. Keys are " +
			'validated before anything is written: esc, enter, tab, up/down/left/right, ctrl+c, digits, y/n. ' +
			"Read the dialog with herdr_read first and send the key the dialog actually names.",
		parameters: z.object({
			target: z.string().describe("Live agent name or pane id"),
			keys: z.array(z.string()).describe('Logical keys, e.g. ["down", "enter"] or ["ctrl+c"]'),
		}),
		approval: "write",
		async execute(_id, params, signal) {
			const invalid = params.keys.filter(key => !KEYS_PATTERN.test(key));
			if (invalid.length > 0) {
				return toolText(`unsupported keys: ${invalid.join(", ")}`, { invalid }, true);
			}
			try {
				const cli = requireClient(signal);
				await cli.sendKeys({ target: params.target, keys: params.keys, signal });
				return toolText(`Sent ${params.keys.join(" ")} to ${params.target}.`, { keys: params.keys });
			} catch (error) {
				return toolText(`herdr_keys failed: ${messageOf(error)}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "herdr_focus",
		label: "Herdr Focus",
		description:
			"Focus a Herdr agent's pane, moving the user's view. Only do this when the user asked to look at that " +
			"agent; background supervision must not steal focus.",
		parameters: z.object({ target: z.string().describe("Live agent name or pane id") }),
		approval: "write",
		async execute(_id, params, signal) {
			try {
				const cli = requireClient(signal);
				await cli.focusAgent(params.target);
				return toolText(`Focused ${params.target}.`, { target: params.target });
			} catch (error) {
				return toolText(`herdr_focus failed: ${messageOf(error)}`, {}, true);
			}
		},
	});

	pi.registerTool({
		name: "herdr_close",
		label: "Herdr Close",
		description:
			"Close a surface this session spawned: its pane, its tab, or its workspace, and drop it from the roster. " +
			"Closing discards the agent process; its session transcript stays on disk. A herdr agent this session did " +
			"not spawn is refused unless force=true, and force only closes that agent's pane.",
		parameters: z.object({
			target: z.string().describe("Agent name or pane id"),
			force: z.boolean().optional().describe("Close a surface this session did not create"),
		}),
		approval: "write",
		async execute(_id, params, signal) {
			try {
				const cli = requireClient(signal);
				const record = findRecord(state.records, params.target);
				if (!record) {
					if (!params.force) {
						return toolText(
							`${params.target} is not tracked by this session. Pass force=true to close its pane anyway.`,
							{},
							true,
						);
					}
					const agent = await cli.getAgent(params.target, { signal });
					await cli.closePane(agent.paneId);
					return toolText(`Closed pane ${agent.paneId} (${params.target}).`, { paneId: agent.paneId });
				}
				if (!record.spawnedByUs && !params.force) {
					return toolText(`${record.name} was not spawned here; pass force=true to close it.`, { record }, true);
				}
				try {
					if (record.placement === "workspace" && record.workspaceId) {
						await cli.closeWorkspace(record.workspaceId);
					} else if (record.placement === "tab" && record.tabId) {
						await cli.closeTab(record.tabId);
					} else {
						await cli.closePane(record.paneId);
					}
				} catch (error) {
					const code = error instanceof HerdrError ? error.code : "error";
					// A surface the user or Herdr already removed is still an adoption record to drop.
					if (code !== "tab_not_found" && code !== "pane_not_found" && code !== "workspace_not_found") {
						throw error;
					}
				}
				state.records = removeRecord(state.records, record.name);
				saveRoster();
				render();
				return toolText(`Closed ${record.placement} for ${record.name} and dropped it from the roster.`, { record });
			} catch (error) {
				return toolText(`herdr_close failed: ${messageOf(error)}`, {}, true);
			}
		},
	});

	pi.registerCommand("herdr", {
		description: "Herdr orchestrator: status, poll interval, roster display, close, focus",
		handler: async (args, ctx) => {
			const [action = "status", value, heartbeatValue] = args.trim().split(/\s+/);
			state.ui = ctx.ui;
			try {
				if (action === "status") {
					if (state.records.length === 0) {
						ctx.ui.notify(`herdr: no tracked agents · poll every ${Math.round(state.pollMs / 1000)}s`, "info");
						return;
					}
					const lines = formatRoster({
						records: state.records,
						tick: state.tick,
						now: Date.now(),
						width: terminalWidth(),
						error: state.lastError,
						lastPollAt: state.lastPollAt,
					});
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				if (action === "poll") {
					const next = Number(value);
					if (!Number.isFinite(next)) {
						ctx.ui.notify("usage: /herdr poll <milliseconds>", "warning");
						return;
					}
					applyPollMs(next);
					render();
					ctx.ui.notify(`herdr: poll every ${Math.round(state.pollMs / 1000)}s`, "info");
					return;
				}
				if (action === "hide" || action === "show") {
					state.hidden = action === "hide";
					render();
					ctx.ui.notify(`herdr roster ${state.hidden ? "hidden" : "shown"}`, "info");
					return;
				}
				if (action === "adopt") {
					if (!value || !heartbeatValue) {
						ctx.ui.notify("usage: /herdr adopt <name|all> <heartbeat_ms>", "warning");
						return;
					}
					const heartbeatMs = Number(heartbeatValue);
					if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0) {
						ctx.ui.notify("heartbeat_ms must be a positive integer", "warning");
						return;
					}
					const cli = requireClient();
					const live = (await cli.listAgents()).filter(agent => agent.paneId !== process.env.HERDR_PANE_ID);
					const matches = value === "all" ? live : live.filter(agent => agent.name === value || agent.paneId === value);
					if (matches.length === 0) {
						ctx.ui.notify(`herdr: no live agent matches ${value}`, "warning");
						return;
					}
					const now = Date.now();
					for (const agent of matches) {
						const existing = findRecord(state.records, agent.name ?? agent.paneId);
						state.records = upsertRecord(
							state.records,
							existing
								? { ...existing, sessionPath: agent.sessionPath ?? existing.sessionPath, state: agent.state, heartbeatMs, nextHeartbeatAt: agent.state === "working" ? now + heartbeatMs : undefined, updatedAt: now }
								: adoptRecord(agent, now, "notify", heartbeatMs),
						);
					}
					saveRoster();
					render();
					ctx.ui.notify(
						`herdr: tracking ${matches.map(agent => agent.name ?? agent.paneId).join(", ")}`,
						"info",
					);
					return;
				}
				if (action === "forget") {
					if (!value) {
						ctx.ui.notify("usage: /herdr forget <name|all>", "warning");
						return;
					}
					state.records = value === "all" ? [] : removeRecord(state.records, value);
					saveRoster();
					render();
					ctx.ui.notify(`herdr: forgot ${value} (the agent keeps running)`, "info");
					return;
				}
				ctx.ui.notify("usage: /herdr [status|adopt <name|all> <heartbeat_ms>|poll <ms>|hide|show|forget <name|all>]", "warning");
			} catch (error) {
				ctx.ui.notify(`herdr: ${messageOf(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state.ui = ctx.ui;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		state.rosterFile = path.join(ROSTER_DIR, rosterFileName(sessionId));
		state.records = loadRecords(state.rosterFile);
		state.hidden = false;
		if (process.env.HERDR_ORCH_POLL_MS) {
			const configured = Number(process.env.HERDR_ORCH_POLL_MS);
			if (Number.isFinite(configured)) state.pollMs = clamp(Math.round(configured), POLL_MS_MIN, POLL_MS_MAX);
		}
		state.schedule = (callback, ms) => {
			const epoch = state.epoch;
			ctx.setInterval(() => {
				// A superseded heartbeat stays unref'd until shutdown; its tick is free.
				if (epoch === state.epoch) {
					state.nextPollAt = Date.now() + state.pollMs;
					callback();
				}
			}, ms);
		};
		render();
		armHeartbeat();
		ctx.setInterval(() => render(), 1000);
		void pollOnce();
	});

	pi.on("session_shutdown", () => {
		saveRoster();
		state.ui?.setWidget(WIDGET_KEY, undefined);
		state.ui = undefined;
	});
}
