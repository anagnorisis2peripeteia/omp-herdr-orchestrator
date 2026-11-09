/**
 * Read an adopted agent's own session transcript.
 *
 * Herdr reports `agent_session.value` for a recognised agent: the path of the conversation the
 * agent CLI is writing. That file is the source of truth, richer than the rendered screen, and it
 * is what "adopt an existing session" needs. Formats differ per CLI, so this parser accepts the
 * shapes omp/pi, Claude Code, and Codex write and skips anything it does not recognise.
 */

import * as fs from "node:fs";

export interface TranscriptTurn {
	role: string;
	text: string;
}

export const TRANSCRIPT_ROLES_KEPT = ["user", "assistant"] as const;
export const TRANSCRIPT_TURNS_DEFAULT = 20;
export const TRANSCRIPT_MAX_CHARS_DEFAULT = 20_000;
const TAIL_READ_BYTES = 2 * 1024 * 1024;

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) {
		const single = content as { text?: unknown } | undefined;
		return typeof single?.text === "string" && single.text.trim() ? single.text.trim() : undefined;
	}
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as { type?: unknown; text?: unknown };
		if (record.type !== "text" && record.type !== "input_text" && record.type !== "output_text") continue;
		if (typeof record.text === "string" && record.text.trim()) parts.push(record.text.trim());
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** One JSONL entry to one conversational turn, or nothing for tool traffic and metadata. */
export function turnFromEntry(entry: unknown): TranscriptTurn | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	const candidates = [record.message, record.payload, record];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const message = candidate as Record<string, unknown>;
		let role = typeof message.role === "string" ? message.role : undefined;
		if (!role && (record.type === "user" || record.type === "assistant")) role = record.type;
		if (!role) continue;
		const normalized = role === "human" ? "user" : role === "ai" ? "assistant" : role;
		if (!TRANSCRIPT_ROLES_KEPT.includes(normalized as (typeof TRANSCRIPT_ROLES_KEPT)[number])) continue;
		const text = contentText(message.content);
		if (!text) continue;
		return { role: normalized, text };
	}
	return undefined;
}

export function parseTranscriptLines(lines: Iterable<string>): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const turn = turnFromEntry(parsed);
		if (turn) turns.push(turn);
	}
	return turns;
}

export interface TranscriptOptions {
	turns?: number;
	maxChars?: number;
}

/** Last turns, oldest first, bounded in count and characters. */
export function formatTranscript(turns: readonly TranscriptTurn[], options?: TranscriptOptions): string {
	const limit = Math.max(1, options?.turns ?? TRANSCRIPT_TURNS_DEFAULT);
	const maxChars = Math.max(500, options?.maxChars ?? TRANSCRIPT_MAX_CHARS_DEFAULT);
	if (turns.length === 0) return "(no conversation turns in the transcript)";

	const selected: string[] = [];
	for (let index = turns.length - 1; index >= 0 && selected.length < limit; index--) {
		const turn = turns[index]!;
		const body = turn.text.length > maxChars / 2 ? `${turn.text.slice(0, Math.floor(maxChars / 2) - 20)} [...truncated]` : turn.text;
		selected.push(`[${turn.role}]\n${body}`);
	}
	selected.reverse();

	let text = selected.join("\n\n");
	const dropped = turns.length - selected.length;
	if (text.length > maxChars) {
		text = text.slice(text.length - maxChars);
		const cut = text.indexOf("\n\n");
		return `[... earlier turns dropped]\n\n${cut > 0 ? text.slice(cut + 2) : text}`;
	}
	return dropped > 0 ? `[... ${dropped} earlier turns dropped]\n\n${text}` : text;
}

function readTail(filePath: string): string {
	const stats = fs.statSync(filePath);
	const start = stats.size > TAIL_READ_BYTES ? stats.size - TAIL_READ_BYTES : 0;
	if (start === 0) return fs.readFileSync(filePath, "utf8");
	const buffer = Buffer.alloc(stats.size - start);
	const fd = fs.openSync(filePath, "r");
	try {
		fs.readSync(fd, buffer, 0, buffer.length, start);
	} finally {
		fs.closeSync(fd);
	}
	const text = buffer.toString("utf8");
	// The first line of a tail read is usually partial; drop it rather than emit half an entry.
	const firstNewline = text.indexOf("\n");
	return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
}

export function readTranscript(filePath: string, options?: TranscriptOptions): string {
	const turns = parseTranscriptLines(readTail(filePath).split("\n"));
	return formatTranscript(turns, options);
}
