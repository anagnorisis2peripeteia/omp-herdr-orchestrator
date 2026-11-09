/**
 * Live smoke test for the herdr client against an isolated named session.
 *
 * Run: HERDR_ORCH_SESSION=hortest bun scripts/live-smoke.ts
 *
 * It creates its own workspace, starts one agent, prompts it, waits, reads, and closes the
 * workspace. It never touches the caller's workspace, so it is safe to run while a real
 * Herdr session is in use.
 */

import { HerdrClient, type ExecFn } from "../src/herdr";

const session = process.env.HERDR_ORCH_SESSION ?? "hortest";

const exec: ExecFn = async (command, args, options) => {
	const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
	const timer = options?.timeout ? setTimeout(() => proc.kill(), options.timeout) : undefined;
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	clearTimeout(timer);
	return { stdout, stderr, code, killed: code === -1 };
};

const cli = new HerdrClient({ exec, session });
const stamp = Date.now().toString(36).slice(-5);
const name = `smoke-${stamp}`;

function step(title: string, value: unknown): void {
	console.log(`\n## ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

async function main(): Promise<void> {
	const created = await cli.createWorkspace({ cwd: "/tmp", label: `hosmoke-${stamp}`, focus: false });
	step("workspace create", created);

	try {
		const started = await cli.startAgent({
			name,
			kind: "omp",
			pane: created.paneId,
			timeoutMs: 45_000,
			args: ["--model", "deepseek/deepseek-flash:high"],
		});
		step("agent start", { name: started?.name, state: started?.state, pane: started?.paneId });

		const listed = await cli.listAgents();
		step(
			"agent list",
			listed.map(agent => ({ name: agent.name, state: agent.state, pane: agent.paneId, title: agent.title })),
		);

		await cli.promptAgent({
			target: name,
			text: "Reply with exactly: READY. No other text, no tools.",
			wait: true,
			timeoutMs: 90_000,
		});
		const settled = await cli.getAgent(name);
		step("agent prompt --wait settled", { state: settled.state, title: settled.title });

		const screen = await cli.readAgent({
			target: name,
			source: "recent-unwrapped",
			lines: 30,
			format: "text",
		});
		step("agent read (tail)", screen.trim().split("\n").slice(-8).join("\n"));

		const timeoutOutcome = await cli
			.waitAgent({ target: name, until: ["blocked"], timeoutMs: 1500 })
			.then(() => "settled (unexpected)")
			.catch((error: { code?: string }) => `not settled: ${error.code}`);
		step("agent wait --until blocked (expected timeout)", timeoutOutcome);
	} finally {
		await cli.closeWorkspace(created.workspaceId);
		step("workspace close", `closed ${created.workspaceId}`);
	}
}

await main();
