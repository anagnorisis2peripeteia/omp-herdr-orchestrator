/**
 * Thin client for the `herdr` CLI.
 *
 * Contract facts this file encodes (herdr 0.9.1, verified live):
 * - Control commands print one JSON object: `{ id, result }` or `{ id, error: { code, message } }`.
 * - A timeout is reported as `error.code === "timeout"` with exit status 0, so exit codes alone
 *   do not distinguish success from failure. Always parse the payload.
 * - `agent read` prints plain text, not JSON.
 * - `--session <name>` must come before the subcommand.
 */

export type HerdrAgentState = "working" | "idle" | "blocked" | "done" | "unknown";

export const HERDR_STATES: readonly HerdrAgentState[] = ["working", "idle", "blocked", "done", "unknown"];

export interface HerdrAgent {
	name: string | undefined;
	agent: string;
	state: HerdrAgentState;
	paneId: string;
	tabId: string;
	workspaceId: string;
	cwd: string;
	title: string;
	focused: boolean;
	interactiveReady: boolean;
	stateSeq: number;
	sessionPath?: string;
}

export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export type ExecFn = (
	command: string,
	args: string[],
	options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
) => Promise<ExecResultLike>;

export class HerdrError extends Error {
	readonly code: string;
	readonly stdout: string;
	readonly stderr: string;

	constructor(code: string, message: string, extra?: { stdout?: string; stderr?: string }) {
		super(message);
		this.name = "HerdrError";
		this.code = code;
		this.stdout = extra?.stdout ?? "";
		this.stderr = extra?.stderr ?? "";
	}
}

export interface HerdrRequest {
	name: string;
	kind: string;
	pane: string;
}

interface HerdrJsonError {
	code?: unknown;
	message?: unknown;
}

/** Parse the last JSON object printed by a control command. */
export function parseHerdrOutput(stdout: string): { result?: unknown; error?: { code: string; message: string } } {
	const lines = stdout.split("\n").map(line => line.trim()).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]!;
		if (!line.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const record = parsed as { result?: unknown; error?: HerdrJsonError };
		if (record.error) {
			return {
				error: {
					code: typeof record.error.code === "string" ? record.error.code : "error",
					message: typeof record.error.message === "string" ? record.error.message : "herdr request failed",
				},
			};
		}
		return { result: record.result };
	}
	return {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function normalizeState(value: unknown): HerdrAgentState {
	return value === "working" || value === "idle" || value === "blocked" || value === "done" ? value : "unknown";
}

export function toAgent(raw: unknown): HerdrAgent | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	const session = asRecord(record.agent_session);
	const paneId = str(record.pane_id);
	if (!paneId) return undefined;
	return {
		name: str(record.name),
		agent: str(record.agent) ?? "agent",
		state: normalizeState(record.agent_status),
		paneId,
		tabId: str(record.tab_id) ?? "",
		workspaceId: str(record.workspace_id) ?? "",
		cwd: str(record.cwd) ?? "",
		title: str(record.terminal_title_stripped) ?? str(record.terminal_title) ?? "",
		focused: bool(record.focused) ?? false,
		interactiveReady: bool(record.interactive_ready) ?? false,
		stateSeq: num(record.state_change_seq) ?? 0,
		sessionPath: session ? str(session.value) : undefined,
	};
}

/** Extract a pane id from a `pane split` result. */
export function paneIdOf(result: unknown): string | undefined {
	return str(asRecord(asRecord(result)?.pane)?.pane_id);
}

/** Extract tab and root-pane ids from a `tab create` or `workspace create` result. */
export function surfaceIdOf(result: unknown, kind: "tab" | "workspace"): { id?: string; paneId?: string } {
	const root = asRecord(asRecord(result)?.root_pane);
	const surface = asRecord(asRecord(result)?.[kind]);
	return {
		id: str(surface?.[kind === "tab" ? "tab_id" : "workspace_id"]),
		paneId: str(root?.pane_id),
	};
}

export interface HerdrClientOptions {
	exec: ExecFn;
	/** Target a named herdr session instead of the inherited one. Test isolation only. */
	session?: string;
	bin?: string;
	listTimeoutMs?: number;
}

export class HerdrClient {
	readonly #exec: ExecFn;
	readonly #session: string | undefined;
	readonly #bin: string;
	readonly #listTimeoutMs: number;

	constructor(options: HerdrClientOptions) {
		this.#exec = options.exec;
		this.#session = options.session;
		this.#bin = options.bin ?? "herdr";
		this.#listTimeoutMs = options.listTimeoutMs ?? 5000;
	}

	#argv(args: readonly string[]): string[] {
		return this.#session ? ["--session", this.#session, ...args] : [...args];
	}

	async run(args: readonly string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown> {
		const result = await this.#exec(this.#bin, this.#argv(args), {
			timeout: options?.timeout ?? 30_000,
			signal: options?.signal,
		});
		if (result.killed) {
			throw new HerdrError("timeout", `herdr ${args.join(" ")} timed out`, result);
		}
		const parsed = parseHerdrOutput(result.stdout);
		if (parsed.error) {
			throw new HerdrError(parsed.error.code, parsed.error.message, result);
		}
		if (parsed.result !== undefined) return parsed.result;
		// Server-side failures arrive as JSON on stderr with exit status 1; keep herdr's own code.
		const fromStderr = parseHerdrOutput(result.stderr);
		if (fromStderr.error) {
			throw new HerdrError(fromStderr.error.code, fromStderr.error.message, result);
		}
		if (result.code !== 0) {
			throw new HerdrError("cli", (result.stderr || result.stdout).trim() || `herdr ${args.join(" ")} failed`, result);
		}
		return undefined;
	}

	async runText(args: readonly string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<string> {
		const result = await this.#exec(this.#bin, this.#argv(args), {
			timeout: options?.timeout ?? 30_000,
			signal: options?.signal,
		});
		if (result.killed) {
			throw new HerdrError("timeout", `herdr ${args.join(" ")} timed out`, result);
		}
		if (result.code !== 0) {
			throw new HerdrError("cli", (result.stderr || result.stdout).trim() || `herdr ${args.join(" ")} failed`, result);
		}
		return result.stdout;
	}

	async listAgents(options?: { signal?: AbortSignal }): Promise<HerdrAgent[]> {
		const result = await this.run(["agent", "list"], { timeout: this.#listTimeoutMs, signal: options?.signal });
		const agents = asRecord(result)?.agents;
		if (!Array.isArray(agents)) return [];
		return agents.map(toAgent).filter((agent): agent is HerdrAgent => agent !== undefined);
	}

	async getAgent(target: string, options?: { signal?: AbortSignal }): Promise<HerdrAgent> {
		const result = await this.run(["agent", "get", target], { signal: options?.signal });
		const agent = toAgent(asRecord(result)?.agent);
		if (!agent) throw new HerdrError("agent_unrecognized", `herdr did not report an agent for ${target}`);
		return agent;
	}

	async splitPane(request: {
		pane?: string;
		direction: "right" | "down";
		cwd: string;
		focus: boolean;
		ratio?: number;
		signal?: AbortSignal;
	}): Promise<string> {
		const args = ["pane", "split"];
		args.push(request.pane ?? "--current");
		args.push("--direction", request.direction, "--cwd", request.cwd);
		if (request.ratio !== undefined) args.push("--ratio", String(request.ratio));
		args.push(request.focus ? "--focus" : "--no-focus");
		const result = await this.run(args, { signal: request.signal });
		const paneId = paneIdOf(result);
		if (!paneId) throw new HerdrError("pane_split", "herdr pane split returned no pane id");
		return paneId;
	}

	async createTab(request: {
		workspace: string;
		cwd: string;
		label?: string;
		focus: boolean;
		signal?: AbortSignal;
	}): Promise<{ tabId: string; paneId: string }> {
		const args = ["tab", "create", "--workspace", request.workspace, "--cwd", request.cwd];
		if (request.label) args.push("--label", request.label);
		args.push(request.focus ? "--focus" : "--no-focus");
		const result = await this.run(args, { signal: request.signal });
		const ids = surfaceIdOf(result, "tab");
		if (!ids.id || !ids.paneId) throw new HerdrError("tab_create", "herdr tab create returned incomplete ids");
		return { tabId: ids.id, paneId: ids.paneId };
	}

	async createWorkspace(request: {
		cwd: string;
		label?: string;
		focus: boolean;
		signal?: AbortSignal;
	}): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
		const args = ["workspace", "create", "--cwd", request.cwd];
		if (request.label) args.push("--label", request.label);
		args.push(request.focus ? "--focus" : "--no-focus");
		const result = await this.run(args, { signal: request.signal });
		const workspaceIds = surfaceIdOf(result, "workspace");
		const tabIds = surfaceIdOf(result, "tab");
		if (!workspaceIds.id || !workspaceIds.paneId) {
			throw new HerdrError("workspace_create", "herdr workspace create returned incomplete ids");
		}
		return {
			workspaceId: workspaceIds.id,
			tabId: tabIds.id ?? "",
			paneId: workspaceIds.paneId,
		};
	}

	async startAgent(request: {
		name: string;
		kind: string;
		pane: string;
		timeoutMs: number;
		args?: readonly string[];
		signal?: AbortSignal;
	}): Promise<HerdrAgent | undefined> {
		const argv = ["agent", "start", request.name, "--kind", request.kind, "--pane", request.pane];
		argv.push("--timeout", String(request.timeoutMs));
		if (request.args && request.args.length > 0) argv.push("--", ...request.args);
		const result = await this.run(argv, { timeout: request.timeoutMs + 15_000, signal: request.signal });
		return toAgent(asRecord(result)?.agent);
	}

	async promptAgent(request: {
		target: string;
		text: string;
		wait: boolean;
		until?: readonly string[];
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<HerdrAgent | undefined> {
		const argv = ["agent", "prompt", request.target, request.text];
		if (request.wait) {
			argv.push("--wait");
			for (const state of request.until ?? []) argv.push("--until", state);
		}
		if (request.timeoutMs !== undefined) argv.push("--timeout", String(request.timeoutMs));
		const result = await this.run(argv, {
			timeout: request.timeoutMs ? request.timeoutMs + 15_000 : 60_000,
			signal: request.signal,
		});
		return toAgent(asRecord(result)?.agent);
	}

	async waitAgent(request: {
		target: string;
		until?: readonly string[];
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<HerdrAgent | undefined> {
		const argv = ["agent", "wait", request.target];
		for (const state of request.until ?? []) argv.push("--until", state);
		if (request.timeoutMs !== undefined) argv.push("--timeout", String(request.timeoutMs));
		const result = await this.run(argv, {
			timeout: request.timeoutMs ? request.timeoutMs + 15_000 : 0,
			signal: request.signal,
		});
		return toAgent(asRecord(result)?.agent);
	}

	async readAgent(request: {
		target: string;
		source: "visible" | "recent" | "recent-unwrapped" | "detection";
		lines: number;
		format: "text" | "ansi";
		signal?: AbortSignal;
	}): Promise<string> {
		return this.runText(
			[
				"agent",
				"read",
				request.target,
				"--source",
				request.source,
				"--lines",
				String(request.lines),
				"--format",
				request.format,
			],
			{ timeout: 20_000, signal: request.signal },
		);
	}

	async sendKeys(request: { target: string; keys: readonly string[]; signal?: AbortSignal }): Promise<void> {
		await this.run(["agent", "send-keys", request.target, ...request.keys], {
			timeout: 15_000,
			signal: request.signal,
		});
	}

	async focusAgent(target: string): Promise<void> {
		await this.run(["agent", "focus", target], { timeout: 15_000 });
	}

	async closePane(paneId: string): Promise<void> {
		await this.run(["pane", "close", paneId], { timeout: 20_000 });
	}

	async closeTab(tabId: string): Promise<void> {
		await this.run(["tab", "close", tabId], { timeout: 20_000 });
	}

	async closeWorkspace(workspaceId: string): Promise<void> {
		await this.run(["workspace", "close", workspaceId], { timeout: 20_000 });
	}
}
