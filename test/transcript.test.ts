import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatTranscript, parseTranscriptLines, readTranscript, turnFromEntry } from "../src/transcript";

const ompLine = JSON.stringify({
	type: "message",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Ready." }],
		timestamp: 1,
	},
});

const claudeLine = JSON.stringify({
	type: "assistant",
	message: { role: "assistant", content: [{ type: "text", text: "Reviewed the diff." }] },
});

const codexLine = JSON.stringify({
	type: "response_item",
	payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the test." }] },
});

describe("turnFromEntry", () => {
	test("reads the omp message shape", () => {
		expect(turnFromEntry(JSON.parse(ompLine))).toEqual({ role: "assistant", text: "Ready." });
	});

	test("reads the Claude Code shape", () => {
		expect(turnFromEntry(JSON.parse(claudeLine))).toEqual({ role: "assistant", text: "Reviewed the diff." });
	});

	test("reads the Codex payload shape", () => {
		expect(turnFromEntry(JSON.parse(codexLine))).toEqual({ role: "user", text: "Fix the test." });
	});

	test("accepts a plain string body", () => {
		expect(turnFromEntry({ role: "user", content: "hello" })).toEqual({ role: "user", text: "hello" });
	});

	test("skips tool traffic and metadata", () => {
		for (const entry of [
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x" }] } },
			{ type: "message", message: { role: "developer", content: [{ type: "text", text: "x" }] } },
			{ type: "title", title: "some title" },
			{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "bash" }] } },
			{ type: "message", message: { role: "assistant", content: [] } },
		]) {
			expect(turnFromEntry(entry)).toBeUndefined();
		}
	});
});

describe("parseTranscriptLines", () => {
	test("ignores unparseable and empty lines", () => {
		const turns = parseTranscriptLines(["", "not json", ompLine, claudeLine]);
		expect(turns.map(turn => turn.text)).toEqual(["Ready.", "Reviewed the diff."]);
	});
});

describe("formatTranscript", () => {
	test("keeps the newest turns, oldest first, and says what it dropped", () => {
		const turns = Array.from({ length: 5 }, (_, index) => ({ role: "user", text: `turn ${index}` }));
		const text = formatTranscript(turns, { turns: 2 });
		expect(text).toContain("[... 3 earlier turns dropped]");
		expect(text).toContain("turn 3");
		expect(text).toContain("turn 4");
		expect(text.indexOf("turn 3")).toBeLessThan(text.indexOf("turn 4"));
		expect(text).not.toContain("turn 0");
	});

	test("bounds a huge single turn", () => {
		const text = formatTranscript([{ role: "assistant", text: "x".repeat(50_000) }], { turns: 5, maxChars: 2000 });
		expect(text.length).toBeLessThan(2500);
		expect(text).toContain("[...truncated]");
	});

	test("reports an empty conversation honestly", () => {
		expect(formatTranscript([])).toBe("(no conversation turns in the transcript)");
	});
});

describe("readTranscript", () => {
	test("reads a session file tail", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-transcript-"));
		const file = path.join(directory, "session.jsonl");
		fs.writeFileSync(file, [ompLine, codexLine, claudeLine].join("\n"));
		const text = readTranscript(file, { turns: 2 });
		expect(text).toContain("Fix the test.");
		expect(text).toContain("Reviewed the diff.");
		expect(text).not.toContain("Ready.");
		fs.rmSync(directory, { recursive: true, force: true });
	});
});
