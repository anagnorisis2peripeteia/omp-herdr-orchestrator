import { describe, expect, test } from "bun:test";
import type { HerdrAgent } from "../src/herdr";
import {
	type AgentRecord,
	adoptRecord,
	findRecord,
	formatDuration,
	formatRoster,
	observeAgents,
	parseRosterFile,
	removeRecord,
	rosterFileName,
	serializeRosterFile,
	settleSummary,
	shouldNotifyTransition,
	validateAgentName,
} from "../src/roster";

function agent(overrides: Partial<HerdrAgent> & { name: string }): HerdrAgent {
	return {
		agent: "omp",
		state: "working",
		paneId: `w1:p${overrides.name.length}`,
		tabId: "w1:t1",
		workspaceId: "w1",
		cwd: "/repo",
		title: "",
		focused: false,
		interactiveReady: true,
		stateSeq: 1,
		...overrides,
	};
}

function record(overrides: Partial<AgentRecord> & { name: string }): AgentRecord {
	return {
		kind: "omp",
		placement: "pane",
		paneId: `w1:p${overrides.name.length}`,
		createdAt: 0,
		updatedAt: 0,
		state: "working",
		stateSince: 0,
		heartbeatMs: 3_000,
		nextHeartbeatAt: 3_000,
		lastSeq: 1,
		notify: "wake",
		spawnedByUs: true,
		cwd: "/repo",
		...overrides,
	};
}

describe("validateAgentName", () => {
	test("accepts herdr's grammar", () => {
		expect(validateAgentName("reviewer")).toBeUndefined();
		expect(validateAgentName("a")).toBeUndefined();
		expect(validateAgentName("lab-omp_2")).toBeUndefined();
	});

	test("rejects names herdr would refuse", () => {
		for (const name of ["Reviewer", "2fast", "has space", "x".repeat(33), "-lead"]) {
			expect(validateAgentName(name)).toContain("must match");
		}
		expect(validateAgentName("")).toContain("required");
	});
});

describe("observeAgents", () => {
	test("fires one transition per real state change", () => {
		const records = [record({ name: "reviewer" })];
		const first = observeAgents(records, [agent({ name: "reviewer", state: "idle" })], 1000);
		expect(first.transitions).toHaveLength(1);
		expect(first.transitions[0]).toMatchObject({ from: "working", to: "idle" });

		const second = observeAgents(first.records, [agent({ name: "reviewer", state: "idle" })], 2000);
		expect(second.transitions).toHaveLength(0);
		expect(second.records[0]?.stateSince).toBe(1000);
	});

	test("keeps a row through a rename by matching the pane", () => {
		const records = [record({ name: "reviewer", paneId: "w1:p45" })];
		const result = observeAgents(records, [agent({ name: "auditor", paneId: "w1:p45", state: "working" })], 500);
		expect(result.records).toHaveLength(1);
		expect(result.records[0]?.name).toBe("auditor");
		expect(result.transitions).toHaveLength(0);
	});

	test("marks a vanished agent gone once, then prunes it after retention", () => {
		const records = [record({ name: "reviewer" })];
		const gone = observeAgents(records, [], 1000, { goneRetentionMs: 5000 });
		expect(gone.transitions[0]).toMatchObject({ from: "working", to: "gone" });
		expect(observeAgents(gone.records, [], 2000, { goneRetentionMs: 5000 }).transitions).toHaveLength(0);
		expect(observeAgents(gone.records, [], 7000, { goneRetentionMs: 5000 }).records).toHaveLength(0);
	});

	test("takes live metadata over the stored copy", () => {
		const records = [record({ name: "reviewer", cwd: "/old" })];
		const result = observeAgents(
			records,
			[agent({ name: "reviewer", cwd: "/new", title: "π working", stateSeq: 12 })],
			900,
		);
		expect(result.records[0]).toMatchObject({ cwd: "/new", title: "π working", lastSeq: 12 });
	});
});

describe("formatDuration", () => {
	test("scales from seconds to hours", () => {
		expect(formatDuration(999)).toBe("0s");
		expect(formatDuration(12_000)).toBe("12s");
		expect(formatDuration(252_000)).toBe("4m12s");
		expect(formatDuration(3_600_000)).toBe("1h00m");
		expect(formatDuration(-5)).toBe("0s");
	});
});

describe("formatRoster", () => {
	test("shows no roster lines when the roster is empty", () => {
		const idle = formatRoster({ records: [], tick: 0, now: 10_000, width: 100, nextPollAt: 13_000 });
		const later = formatRoster({ records: [], tick: 2, now: 16_000, width: 100, nextPollAt: 19_000 });
		expect(idle).toEqual([]);
		expect(later).toEqual([]);
	});

	test("shows blocked first and gone last", () => {
		const lines = formatRoster({
			records: [
				record({ name: "quiet", state: "idle" }),
				record({ name: "stuck", state: "blocked" }),
				record({ name: "dead", state: "gone" }),
			],
			tick: 1,
			now: 60_000,
			width: 120,
		});
		expect(lines[1]).toContain("stuck");
		expect(lines[2]).toContain("quiet");
		expect(lines[3]).toContain("dead");
		expect(lines[0]).toContain("1 blocked");
	});

	test("uses semantic theme colors when a painter is supplied", () => {
		const lines = formatRoster({
			records: [record({ name: "reviewer", state: "working" })],
			tick: 1,
			now: 2_000,
			width: 120,
			nextPollAt: 3_000,
			paint: (color, text) => `[${color}]${text}[/]`,
		});
		expect(lines[0]).toContain("[accent]");
		expect(lines[1]).toContain("[accent]reviewer");
	});

	test("does not show a heartbeat on idle or done rows", () => {
		const lines = formatRoster({
			records: [
				record({ name: "idle", state: "idle" }),
				record({ name: "done", state: "done" }),
			],
			tick: 1,
			now: 2_000,
			width: 120,
		});
		expect(lines[1]).not.toContain("hb");
		expect(lines[2]).not.toContain("hb");
	});

	test("counts down each agent heartbeat without a global header heartbeat", () => {
		const base = { records: [record({ name: "reviewer", nextHeartbeatAt: 13_000 })], tick: 1, width: 120, lastPollAt: 10_000 };
		const early = formatRoster({ ...base, now: 11_000 });
		const late = formatRoster({ ...base, now: 12_500 });
		expect(early[0]).not.toContain("heartbeat in");
		expect(early[1]).toContain("hb in 2s");
		expect(late[1]).toContain("hb due");
	});

	test("reports the next heartbeat, a failure, and the state age on the row", () => {
		const lines = formatRoster({
			records: [record({ name: "reviewer", state: "working", stateSince: 0 })],
			tick: 3,
			now: 252_000,
			width: 120,
			lastPollAt: 249_000,
			nextPollAt: 250_000,
			error: "timeout: herdr agent list timed out",
		});
		expect(lines[0]).not.toContain("heartbeat");
		expect(lines[0]).toContain("poll failed");
		expect(lines[1]).toContain("reviewer");
		expect(lines[1]).toContain("working");
		expect(lines[1]).toContain("hb due");
	});

	test("clamps the row to the terminal width", () => {
		const lines = formatRoster({
			records: [record({ name: "reviewer", title: "x".repeat(300) })],
			tick: 1,
			now: 1000,
			width: 60,
		});
		expect(lines[1]!.length).toBeLessThanOrEqual(60);
		expect(lines[1]).toContain("..");
	});
});

describe("roster file", () => {
	test("round-trips records", () => {
		const records = [record({ name: "reviewer", task: "review the diff" })];
		expect(parseRosterFile(serializeRosterFile(records))).toEqual(records);
	});

	test("ignores garbage and unknown versions", () => {
		expect(parseRosterFile("not json")).toEqual([]);
		expect(parseRosterFile(JSON.stringify({ version: 2, records: [record({ name: "x" })] }))).toEqual([]);
		expect(parseRosterFile(JSON.stringify({ version: 1, records: [{ name: 5 }] }))).toEqual([]);
	});

	test("rejects a persisted record without an explicit heartbeat", () => {
		const recordWithoutHeartbeat = { ...record({ name: "reviewer" }) } as Partial<AgentRecord>;
		delete recordWithoutHeartbeat.heartbeatMs;
		expect(parseRosterFile(JSON.stringify({ version: 1, records: [recordWithoutHeartbeat] }))).toEqual([]);
	});

	test("finds and removes by name or pane", () => {
		const records = [record({ name: "reviewer", paneId: "w1:p45" }), record({ name: "auditor", paneId: "w1:p46" })];
		expect(findRecord(records, "w1:p46")?.name).toBe("auditor");
		expect(findRecord(records, "nobody")).toBeUndefined();
		expect(removeRecord(records, "reviewer").map(item => item.name)).toEqual(["auditor"]);
	});
});

describe("rosterFileName", () => {
	test("scopes the mirror to one session and falls back when there is no id", () => {
		expect(rosterFileName("01a1bd66-5da1-73a8")).toBe("roster-01a1bd66-5da1-73a8.json");
		expect(rosterFileName("../etc/passwd")).toBe("roster-etcpasswd.json");
		expect(rosterFileName(undefined)).toBe("roster.json");
	});
});

describe("adoptRecord", () => {
	test("claims no ownership and keeps the reported session path", () => {
		const adopted = adoptRecord(
			agent({ name: "someone-elses", state: "idle", sessionPath: "/sessions/b.jsonl" }),
			5000,
			"notify",
		);
		expect(adopted).toMatchObject({
			name: "someone-elses",
			spawnedByUs: false,
			placement: "pane",
			notify: "notify",
			state: "idle",
			sessionPath: "/sessions/b.jsonl",
			stateSince: 5000,
		});
	});

	test("tracks an unnamed agent under its pane id", () => {
		const adopted = adoptRecord(
			{
				agent: "claude",
				paneId: "w1:p77",
				tabId: "w1:t1",
				workspaceId: "w1",
				cwd: "/repo",
				title: "",
				focused: false,
				interactiveReady: true,
				state: "working",
				stateSeq: 2,
			},
			1,
			"none",
		);
		expect(adopted.name).toBe("w1:p77");
	});
});

describe("settleSummary", () => {
	test("names the transition, location, and task without a meaningless age", () => {
		const summary = settleSummary(
			record({ name: "helper", paneId: "w2:p2", task: "Reply with exactly READY." }),
			"working",
			"done",
		);
		expect(summary).toBe("helper · done (was working) · omp · w2:p2 · Reply with exactly READY.");
		expect(summary).not.toContain(" 0s");
	});

	test("omits the task when there is none", () => {
		expect(settleSummary(record({ name: "probe", paneId: "w1:p1" }), "idle", "gone")).toBe(
			"probe · gone (was idle) · omp · w1:p1",
		);
	});
});


describe("shouldNotifyTransition", () => {
	test("wakes once for working -> settled", () => {
		expect(shouldNotifyTransition("working", "idle")).toBe(true);
		expect(shouldNotifyTransition("working", "done")).toBe(true);
		expect(shouldNotifyTransition("working", "blocked")).toBe(true);
		expect(shouldNotifyTransition("unknown", "done")).toBe(true);
	});

	test("does not wake again between settled states", () => {
		expect(shouldNotifyTransition("done", "idle")).toBe(false);
		expect(shouldNotifyTransition("idle", "done")).toBe(false);
		expect(shouldNotifyTransition("blocked", "idle")).toBe(false);
		expect(shouldNotifyTransition("idle", "idle")).toBe(false);
	});

	test("wakes on gone", () => {
		expect(shouldNotifyTransition("done", "gone")).toBe(true);
		expect(shouldNotifyTransition("blocked", "gone")).toBe(true);
	});
});
