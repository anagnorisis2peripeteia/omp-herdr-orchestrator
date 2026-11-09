/**
 * Roster state for herdr-hosted agents: the records, the state machine that turns
 * observations into transitions, and the row text drawn above the editor.
 *
 * Everything here is pure so it can be tested without a terminal or a herdr server.
 */

import type { HerdrAgent, HerdrAgentState } from "./herdr";

export type Placement = "pane" | "tab" | "workspace";
export type NotifyMode = "wake" | "notify" | "none";
export type ObservedState = HerdrAgentState | "gone";

export interface AgentRecord {
	/** Live herdr agent name; unique among live agents, `[a-z][a-z0-9_-]{0,31}`. */
	name: string;
	kind: string;
	placement: Placement;
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	cwd: string;
	label?: string;
	/** The task text this agent was asked to work on, for the row. */
	task?: string;
	notify: NotifyMode;
	spawnedByUs: boolean;
	createdAt: number;
	updatedAt: number;
	state: ObservedState;
	stateSince: number;
	/** Per-agent heartbeat interval in milliseconds. */
	heartbeatMs?: number;
	/** Per-agent countdown target for the next heartbeat check. */
	nextHeartbeatAt?: number;
	lastSeq: number;
	title?: string;
	sessionPath?: string;
}

export interface Transition {
	record: AgentRecord;
	from: ObservedState;
	to: ObservedState;
}

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** herdr's own name rule, checked before a surface is created so a typo costs nothing. */
export function validateAgentName(name: string): string | undefined {
	if (name.length === 0) return "agent name is required";
	if (!AGENT_NAME_PATTERN.test(name)) {
		return "agent name must match [a-z][a-z0-9_-]{0,31} (lowercase, digits, _ and - only)";
	}
	return undefined;
}

export function isSettled(state: ObservedState): boolean {
	return state === "idle" || state === "done" || state === "blocked";
}

/** A settle wake is for a working -> settled edge, not done -> idle noise. */
export function shouldNotifyTransition(from: ObservedState, to: ObservedState): boolean {
	if (to === "gone") return true;
	if (!isSettled(to)) return false;
	return !isSettled(from);
}

/**
 * Fold one `agent list` observation into the roster.
 *
 * Matching prefers the live name, then the pane id: an agent renamed in herdr keeps its row
 * instead of appearing as a new agent and a gone one.
 */
export function observeAgents(
	records: readonly AgentRecord[],
	live: readonly HerdrAgent[],
	now: number,
	options?: { goneRetentionMs?: number; heartbeatMs?: number },
): { records: AgentRecord[]; transitions: Transition[] } {
	const goneRetentionMs = options?.goneRetentionMs ?? 30 * 60_000;
	const transitions: Transition[] = [];
	const byName = new Map<string, HerdrAgent>();
	const byPane = new Map<string, HerdrAgent>();
	for (const agent of live) {
		if (agent.name) byName.set(agent.name, agent);
		byPane.set(agent.paneId, agent);
	}

	const next = records.map(record => {
		const agent = byName.get(record.name) ?? byPane.get(record.paneId);
		if (!agent) {
			if (record.state === "gone") return record;
			const gone: AgentRecord = { ...record, state: "gone", stateSince: now, updatedAt: now };
			transitions.push({ record: gone, from: record.state, to: "gone" });
			return gone;
		}
		const state = agent.state;
		const changed = state !== record.state;
		const updated: AgentRecord = {
			...record,
			name: agent.name ?? record.name,
			kind: agent.agent || record.kind,
			paneId: agent.paneId,
			tabId: agent.tabId || record.tabId,
			workspaceId: agent.workspaceId || record.workspaceId,
			cwd: agent.cwd || record.cwd,
			title: agent.title,
			sessionPath: agent.sessionPath ?? record.sessionPath,
			lastSeq: agent.stateSeq,
			state,
			stateSince: changed ? now : record.stateSince,
			nextHeartbeatAt: state === "working"
				? (changed
					? now + (record.heartbeatMs ?? options?.heartbeatMs ?? 600_000)
					: (record.nextHeartbeatAt ?? now + (record.heartbeatMs ?? options?.heartbeatMs ?? 600_000)))
				: undefined,
			updatedAt: now,
		};
		if (changed) transitions.push({ record: updated, from: record.state, to: state });
		return updated;
	});

	return {
		records: next.filter(record => !(record.state === "gone" && now - record.stateSince > goneRetentionMs)),
		transitions,
	};
}

/** Rows that need a human or the orchestrator first sort above quiet ones. */
const STATE_ORDER: Record<ObservedState, number> = {
	blocked: 0,
	working: 1,
	unknown: 2,
	idle: 3,
	done: 4,
	gone: 5,
};

const STATE_GLYPH: Record<ObservedState, string> = {
	blocked: "!",
	working: ">",
	unknown: "?",
	idle: ".",
	done: "+",
	gone: "x",
};

export const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;

export function spinnerFrame(tick: number): string {
	return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
}

export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function truncate(text: string, limit: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (limit <= 0) return "";
	if (clean.length <= limit) return clean;
	if (limit <= 2) return clean.slice(0, limit);
	return `${clean.slice(0, limit - 2)}..`;
}

export interface RosterView {
	records: readonly AgentRecord[];
	tick: number;
	now: number;
	width: number;
	/** Last poll error, shown in the header so a dead loop is visible rather than silent. */
	error?: string;
	lastPollAt?: number;
	/** When the next Herdr poll is due; the header counts down to this without polling. */
	nextPollAt?: number;
	/** Semantic color painter supplied by the host theme; omitted in pure tests. */
	paint?: (color: string, text: string) => string;
}

export function sortRecords(records: readonly AgentRecord[]): AgentRecord[] {
	return [...records].sort((left, right) => {
		const byState = STATE_ORDER[left.state] - STATE_ORDER[right.state];
		if (byState !== 0) return byState;
		return left.name.localeCompare(right.name);
	});
}

/**
 * Header plus one row per agent. The header always renders, so the heartbeat stays visible with
 * an empty roster and a stalled frame is distinguishable from "nothing to watch".
 */
export function formatRoster(view: RosterView): string[] {
	const width = Math.max(40, Math.min(view.width, 160));
	const sorted = sortRecords(view.records);
	const live = sorted.filter(record => record.state !== "gone").length;
	const counts = new Map<ObservedState, number>();
	for (const record of sorted) counts.set(record.state, (counts.get(record.state) ?? 0) + 1);

	const paint = view.paint ?? ((_color: string, text: string) => text);
	if (live === 0) return [];
	const parts: string[] = [];
	parts.push(paint("accent", `herdr orchestrator · ${live} agent${live === 1 ? "" : "s"}`));
	parts.push(paint("accent", spinnerFrame(view.tick)));
	const attention = (["blocked", "working", "unknown"] as const)
		.filter(state => (counts.get(state) ?? 0) > 0)
		.map(state => `${counts.get(state)} ${state}`);
	if (attention.length > 0) parts.push(paint("warning", attention.join(", ")));
	if (view.error) parts.push(paint("error", `poll failed: ${truncate(view.error, 40)}`));

	const lines = [parts.join(" · ")];
	if (sorted.length === 0) return lines;

	const nameWidth = Math.min(18, Math.max(4, ...sorted.map(record => record.name.length)));
	for (const record of sorted) {
		const stateColor = record.state === "blocked" ? "warning" : record.state === "working" ? "accent" : record.state === "done" ? "success" : record.state === "gone" ? "dim" : "muted";
		const glyph = paint(stateColor, STATE_GLYPH[record.state]);
		const name = paint(stateColor, record.name.padEnd(nameWidth));
		const state = paint(stateColor, record.state.padEnd(7));
		const heartbeatAt = record.state === "working" ? record.nextHeartbeatAt ?? view.nextPollAt : undefined;
		const heartbeat = heartbeatAt === undefined ? "—" : heartbeatAt - view.now >= 1000 ? `hb in ${formatDuration(heartbeatAt - view.now)}` : "hb due";
		const age = paint(heartbeat === "hb due" ? "warning" : "dim", heartbeat.padStart(10));
		const kind = paint("dim", (record.kind || "?").padEnd(5));
		const location = paint("dim", record.paneId || "-");
		const prefix = `  ${glyph} ${name}  ${state} ${age}  ${kind}  ${location}`;
		const detail = record.state === "gone" ? record.task : record.title || record.task;
		const plainPrefixLength = `  ${STATE_GLYPH[record.state]} ${record.name.padEnd(nameWidth)}  ${record.state.padEnd(7)} ${(heartbeatAt === undefined ? "—" : heartbeatAt - view.now >= 1000 ? `hb in ${formatDuration(heartbeatAt - view.now)}` : "hb due").padStart(10)}  ${(record.kind || "?").padEnd(5)}  ${record.paneId || "-"}`.length;
		const room = width - plainPrefixLength - 3;
		const tail = detail && room > 6 ? paint("muted", `  ${truncate(detail, room)}`) : "";
		lines.push(prefix + tail);
	}
	return lines;
}

/** Compact one-line text for tool results. */
export function describeRecord(record: AgentRecord, now: number): string {
	const age = formatDuration(now - record.stateSince);
	const bits = [`${record.name}`, `${record.state} ${age}`, `${record.kind}`, record.paneId];
	if (record.task) bits.push(truncate(record.task, 60));
	return bits.join(" · ");
}

/**
 * Text for a settle or exit notice. No age: a transition was observed just now, so an age of
 * "0s" would say nothing and read like a measurement.
 */
export function settleSummary(record: AgentRecord, from: ObservedState, to: ObservedState): string {
	const head = `${record.name} · ${to} (was ${from}) · ${record.kind} · ${record.paneId}`;
	return record.task ? `${head} · ${truncate(record.task, 60)}` : head;
}

export function upsertRecord(records: readonly AgentRecord[], record: AgentRecord): AgentRecord[] {
	const index = records.findIndex(existing => existing.name === record.name);
	if (index < 0) return [...records, record];
	const next = [...records];
	next[index] = record;
	return next;
}

export function removeRecord(records: readonly AgentRecord[], name: string): AgentRecord[] {
	return records.filter(record => record.name !== name);
}

export function findRecord(records: readonly AgentRecord[], target: string): AgentRecord | undefined {
	return records.find(record => record.name === target) ?? records.find(record => record.paneId === target);
}

/**
 * Build a record for an agent that already exists in herdr.
 *
 * Adoption never claims ownership: `spawnedByUs` stays false so close demands an explicit force,
 * and placement falls back to `pane` because herdr does not report which surface created it.
 * An unnamed agent is tracked under its pane id, which herdr also accepts as a target.
 */
export function adoptRecord(agent: HerdrAgent, now: number, notify: NotifyMode, heartbeatMs = 600_000): AgentRecord {
	const name = agent.name ?? agent.paneId;
	return {
		name,
		kind: agent.agent || "agent",
		placement: "pane",
		paneId: agent.paneId,
		tabId: agent.tabId || undefined,
		workspaceId: agent.workspaceId || undefined,
		cwd: agent.cwd,
		notify,
		spawnedByUs: false,
		createdAt: now,
		updatedAt: now,
		state: agent.state,
		stateSince: now,
		heartbeatMs,
		nextHeartbeatAt: agent.state === "working" ? now + heartbeatMs : undefined,
		lastSeq: agent.stateSeq,
		title: agent.title,
		sessionPath: agent.sessionPath,
	};
}

export interface RosterFile {
	version: 1;
	records: AgentRecord[];
}

export function parseRosterFile(text: string): AgentRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const file = parsed as Partial<RosterFile>;
	if (!file || file.version !== 1 || !Array.isArray(file.records)) return [];
	return file.records.filter((record): record is AgentRecord => {
		if (!record || typeof record !== "object") return false;
		const candidate = record as Partial<AgentRecord>;
		return (
			typeof candidate.name === "string" &&
			typeof candidate.paneId === "string" &&
			typeof candidate.heartbeatMs === "number" &&
			candidate.heartbeatMs > 0
		);
	});
}

export function serializeRosterFile(records: readonly AgentRecord[]): string {
	const file: RosterFile = { version: 1, records: [...records] };
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/**
 * One roster file per omp session, so a second session in the same Herdr server does not inherit
 * rows it never asked for. A resumed session keeps its id and therefore its rows.
 */
export function rosterFileName(sessionId: string | undefined): string {
	const safe = (sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
	return safe ? `roster-${safe}.json` : "roster.json";
}
