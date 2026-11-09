import { describe, expect, test } from "bun:test";
import {
	HerdrClient,
	HerdrError,
	type ExecResultLike,
	parseHerdrOutput,
	paneIdOf,
	surfaceIdOf,
	toAgent,
} from "../src/herdr";

function stubExec(result: ExecResultLike, calls: Array<{ command: string; args: string[] }> = []) {
	return async (command: string, args: string[]) => {
		calls.push({ command, args });
		return result;
	};
}

const ok = (result: unknown): ExecResultLike => ({
	stdout: `${JSON.stringify({ id: "cli:test", result })}\n`,
	stderr: "",
	code: 0,
});

const fail = (code: string, message: string): ExecResultLike => ({
	stdout: `${JSON.stringify({ id: "cli:test", error: { code, message } })}\n`,
	stderr: "",
	code: 0,
});

const agentPayload = {
	agent: "omp",
	name: "reviewer",
	agent_status: "working",
	pane_id: "w1:p45",
	tab_id: "w1:t2",
	workspace_id: "w1",
	cwd: "/repo",
	terminal_title_stripped: "π Reviewing",
	focused: false,
	interactive_ready: true,
	state_change_seq: 7,
	agent_session: { kind: "path", source: "herdr:omp", value: "/sessions/x.jsonl" },
};

describe("parseHerdrOutput", () => {
	test("reads the last JSON object, ignoring warning lines", () => {
		const stdout = `warning: something\n${JSON.stringify({ id: "x", result: { ok: true } })}\n`;
		expect(parseHerdrOutput(stdout)).toEqual({ result: { ok: true } });
	});

	test("surfaces an error payload even with exit status 0", () => {
		expect(parseHerdrOutput(`${JSON.stringify({ error: { code: "timeout", message: "timed out" } })}\n`)).toEqual({
			error: { code: "timeout", message: "timed out" },
		});
	});

	test("returns nothing for non-JSON output", () => {
		expect(parseHerdrOutput("plain text\n")).toEqual({});
	});
});

describe("response mapping", () => {
	test("maps an agent payload to camelCase with an unknown state fallback", () => {
		expect(toAgent(agentPayload)).toMatchObject({
			name: "reviewer",
			state: "working",
			paneId: "w1:p45",
			stateSeq: 7,
			interactiveReady: true,
			sessionPath: "/sessions/x.jsonl",
		});
		expect(toAgent({ ...agentPayload, agent_status: "banana" })?.state).toBe("unknown");
	});

	test("drops a payload with no pane id", () => {
		expect(toAgent({ name: "x" })).toBeUndefined();
	});

	test("extracts ids from create responses", () => {
		expect(paneIdOf({ pane: { pane_id: "w1:p9" } })).toBe("w1:p9");
		expect(surfaceIdOf({ tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p10" } }, "tab")).toEqual({
			id: "w1:t3",
			paneId: "w1:p10",
		});
		expect(surfaceIdOf({ workspace: { workspace_id: "w2" }, root_pane: { pane_id: "w2:p1" } }, "workspace")).toEqual({
			id: "w2",
			paneId: "w2:p1",
		});
	});
});

describe("HerdrClient", () => {
	test("puts --session before the subcommand", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const client = new HerdrClient({ exec: stubExec(ok({ agents: [] }), calls), session: "hortest" });
		await client.listAgents();
		expect(calls[0]?.command).toBe("herdr");
		expect(calls[0]?.args).toEqual(["--session", "hortest", "agent", "list"]);
	});

	test("lists agents and skips unparseable rows", async () => {
		const client = new HerdrClient({
			exec: stubExec(ok({ agents: [agentPayload, { name: "broken" }] })),
		});
		const agents = await client.listAgents();
		expect(agents).toHaveLength(1);
		expect(agents[0]?.name).toBe("reviewer");
	});

	test("builds agent start argv with native args after --", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const client = new HerdrClient({ exec: stubExec(ok({ agent: agentPayload }), calls) });
		await client.startAgent({
			name: "reviewer",
			kind: "claude",
			pane: "w1:p45",
			timeoutMs: 45000,
			args: ["--model", "haiku"],
		});
		expect(calls[0]?.args).toEqual([
			"agent",
			"start",
			"reviewer",
			"--kind",
			"claude",
			"--pane",
			"w1:p45",
			"--timeout",
			"45000",
			"--",
			"--model",
			"haiku",
		]);
	});

	test("turns a timeout payload into a HerdrError with code timeout", async () => {
		const client = new HerdrClient({ exec: stubExec(fail("timeout", "timed out waiting for agent status")) });
		await expect(client.waitAgent({ target: "reviewer", timeoutMs: 3000 })).rejects.toMatchObject({
			name: "HerdrError",
			code: "timeout",
		});
	});

	test("throws on a killed process", async () => {
		const client = new HerdrClient({
			exec: stubExec({ stdout: "", stderr: "", code: -1, killed: true }),
		});
		await expect(client.listAgents()).rejects.toBeInstanceOf(HerdrError);
	});

	test("keeps herdr's error code when the failure arrives on stderr with exit 1", async () => {
		const client = new HerdrClient({
			exec: stubExec({
				stdout: "",
				stderr: `${JSON.stringify({
					id: "cli:workspace:create",
					error: { code: "server_not_running", message: "no herdr server is running" },
				})}\n`,
				code: 1,
			}),
		});
		await expect(client.createWorkspace({ cwd: "/tmp", focus: false })).rejects.toMatchObject({
			code: "server_not_running",
		});
	});

	test("reports a missing pane id from split as a split failure", async () => {
		const client = new HerdrClient({ exec: stubExec(ok({ pane: {} })) });
		await expect(
			client.splitPane({ direction: "right", cwd: "/repo", focus: false }),
		).rejects.toMatchObject({ code: "pane_split" });
	});

	test("uses --current when no pane is given", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const client = new HerdrClient({ exec: stubExec(ok({ pane: { pane_id: "w1:p9" } }), calls) });
		await client.splitPane({ direction: "down", cwd: "/repo", focus: false });
		expect(calls[0]?.args).toEqual([
			"pane",
			"split",
			"--current",
			"--direction",
			"down",
			"--cwd",
			"/repo",
			"--no-focus",
		]);
	});

	test("reads agent output as text with the requested source", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const client = new HerdrClient({ exec: stubExec({ stdout: "READY\n", stderr: "", code: 0 }, calls) });
		const text = await client.readAgent({
			target: "reviewer",
			source: "recent-unwrapped",
			lines: 40,
			format: "text",
		});
		expect(text).toBe("READY\n");
		expect(calls[0]?.args).toEqual([
			"agent",
			"read",
			"reviewer",
			"--source",
			"recent-unwrapped",
			"--lines",
			"40",
			"--format",
			"text",
		]);
	});

	test("creates a workspace from the nested ids herdr returns", async () => {
		const client = new HerdrClient({
			exec: stubExec(
				ok({
					workspace: { workspace_id: "w3" },
					tab: { tab_id: "w3:t1" },
					root_pane: { pane_id: "w3:p1" },
				}),
			),
		});
		await expect(client.createWorkspace({ cwd: "/repo", focus: false })).resolves.toEqual({
			workspaceId: "w3",
			tabId: "w3:t1",
			paneId: "w3:p1",
		});
	});

	test("does not pass --wait when the caller did not ask to wait", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const client = new HerdrClient({ exec: stubExec(ok({ agent: agentPayload }), calls) });
		await client.promptAgent({ target: "reviewer", text: "do the thing", wait: false });
		expect(calls[0]?.args).toEqual(["agent", "prompt", "reviewer", "do the thing"]);
	});
});
