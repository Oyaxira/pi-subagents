/**
 * Real Pi-session end-to-end test for the subagent extension.
 *
 * Spawns an actual child `pi` subprocess (a repo-local child CLI that runs a
 * real `AgentSession` backed by a faux provider) and exercises the extension's
 * real foreground execution path: the parent session calls the `subagent` tool,
 * the tool spawns the child, the child streams jsonl events, the extension's
 * real stdout parser extracts the result, and the marker flows back as a tool
 * result that the parent relays. No real API keys are used.
 *
 * Skips gracefully when the pi runtime packages are not importable.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryImport } from "../support/helpers.ts";
import type { RealSessionRun } from "../support/real-session-runner.ts";

const piCodingAgent = await tryImport<unknown>("@earendil-works/pi-coding-agent");
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);

const CHILD_MARKER = "CHILD_REAL_SESSION_OK";
// Env vars the runner must clear so a parent that was itself spawned as a
// subagent child can still launch fresh children. The values are deliberately
// bogus sentinels (nonexistent paths) so a leaked value would break spawning.
const BOGUS_EXTRA_DIRS = path.join(os.tmpdir(), "nonexistent-pi-subagents-e2e-extra-dirs");
const BOGUS_PI_BINARY = path.join(os.tmpdir(), "nonexistent-pi-binary-e2e");
const BOGUS_PI_PACKAGE_ROOT = path.join(os.tmpdir(), "nonexistent-pi-coding-agent-package-root-e2e");
const ISOLATED_ENV_KEYS = [
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_FANOUT_CHILD",
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_PI_BINARY",
	"PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
] as const;

describe("real Pi-session subagent E2E", { skip: !available ? "pi runtime packages not available" : undefined }, () => {
	let run: RealSessionRun | undefined;

	afterEach(async () => {
		await run?.dispose();
		run = undefined;
	});

	// A parent blocked in subagent_wait could not answer the user until the
	// background run finished: the user's message sat in the queue for minutes.
	// Pi TUI's Enter steers; Dock queues a message sent during a run as a follow-up.
	for (const delivery of ["steer", "followUp"] as const) {
		it(`a message the user sends (${delivery}) while the parent waits on a background run is answered without waiting for the run`, async () => {
			const { runRealSubagentSession } = await import("../support/real-session-runner.ts");
			const { ASYNC_DIR } = await import("../../src/shared/types.ts");
			const { fauxToolCall } = await import("@earendil-works/pi-ai");
			const runDir = path.join(ASYNC_DIR, `e2e-wait-${delivery}-${process.pid}-${Date.now()}`);
			const question = "Quick question before the review finishes?";
			const answer = "Answering the question while the review keeps running.";
			const textOf = (content: unknown) => Array.isArray(content)
				? content.map((part) => (part as { text?: string }).text ?? "").join("")
				: String(content ?? "");
			let waitResult = "";
			let waits = 0;
			try {
				run = await runRealSubagentSession({
					prompt: "Wait for the background reviewer.",
					childText: CHILD_MARKER,
					timeoutMs: 20_000,
					beforePrompt: (session) => {
						// A background run of this session that is still working.
						const now = Date.now();
						fs.mkdirSync(runDir, { recursive: true });
						fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
							runId: path.basename(runDir), mode: "single", state: "running", startedAt: now, lastUpdate: now,
							sessionId: session.sessionManager.getSessionFile() ?? session.sessionManager.getSessionId(),
							pid: process.pid, steps: [{ agent: "reviewer", status: "running" }],
						}));
					},
					onEvent: (session, event) => {
						if (event.type === "tool_execution_start" && event.toolName === "subagent_wait") {
							setTimeout(() => void session[delivery](question), 300);
						}
					},
					respond: (context) => {
						const messages = context.messages as Array<{ role?: string; toolName?: string; content?: unknown }>;
						const waited = messages.filter((message) => message.role === "toolResult" && message.toolName === "subagent_wait");
						if (waited.length === 0) {
							waits++;
							return fauxToolCall("subagent_wait", { timeoutMs: 120_000 }, { id: "call-wait" });
						}
						waitResult = textOf(waited[0]!.content);
						const asked = messages.some((message) => message.role === "user" && textOf(message.content).includes(question));
						// Until a follow-up is delivered the parent only knows that the user spoke.
						return asked ? answer : "The review is still running; reading your message.";
					},
				});
			} finally {
				fs.rmSync(runDir, { recursive: true, force: true });
			}

			assert.equal(waits, 1);
			assert.match(waitResult, /user sent a message/i);
			assert.match(waitResult, new RegExp(path.basename(runDir)), "the wait says which run is still going");
			assert.equal(run.responseText, answer, "the parent answers the user's question");
		});
	}

	it("loads requested extension tools in direct and chain children and diagnoses missing providers", async () => {
		const { runRealSubagentSession, subagentCall, subagentToolResults } = await import("../support/real-session-runner.ts");
		const extensionAgent = `---
name: extension-worker
description: Uses a child-only fixture tool
tools: read, fixture_search
subagentOnlyExtensions: ./fixture-extension.ts
completionGuard: false
---
Use the available tools.`;
		const missingAgent = `---
name: missing-extension-worker
description: Requests an extension tool without loading its provider
tools: read, missing_search
completionGuard: false
---
Use the available tools.`;
		const fixtureExtension = `export default function (pi) {
	pi.registerTool({
		name: "fixture_search",
		label: "Fixture Search",
		description: "Search the E2E fixture.",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
		async execute() { return { content: [{ type: "text", text: "fixture result" }] }; },
	});
}`;

		run = await runRealSubagentSession({
			prompt: "Run the direct, chain, and missing-provider child checks.",
			childText: CHILD_MARKER,
			reportChildTools: true,
			projectFiles: {
				".pi/agents/extension-worker.md": extensionAgent,
				".pi/agents/missing-extension-worker.md": missingAgent,
				"fixture-extension.ts": fixtureExtension,
			},
			respond(context) {
				const resultCount = (context.messages as Array<{ role?: string; toolName?: string }>).filter((message) => message.role === "toolResult" && message.toolName === "subagent").length;
				if (resultCount === 0) {
					return subagentCall({ agent: "extension-worker", task: "Report active tools.", context: "fresh", agentScope: "project" }, "call-direct-extension");
				}
				if (resultCount === 1) {
					return subagentCall({ chain: [{ agent: "extension-worker", task: "Report active tools." }], async: false, clarify: false, agentScope: "project" }, "call-chain-extension");
				}
				if (resultCount === 2) {
					return subagentCall({
						chain: [{
							agent: "extension-worker",
							task: "Submit the required structured marker.",
							outputSchema: {
								type: "object",
								properties: { marker: { type: "string" } },
								required: ["marker"],
								additionalProperties: false,
							},
						}],
						async: false,
						clarify: false,
						agentScope: "project",
					}, "call-structured-output");
				}
				if (resultCount === 3) {
					return subagentCall({ agent: "missing-extension-worker", task: "Report active tools.", context: "fresh", agentScope: "project" }, "call-missing-extension");
				}
				return "Child tool checks complete.";
			},
			timeoutMs: 60_000,
		});

		const results = subagentToolResults(run.parentSession);
		const toolMessages = run.parentSession.messages.filter((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === "subagent");
		const chainDetails = JSON.stringify((toolMessages[1] as { details?: unknown } | undefined)?.details);
		const structuredDetails = JSON.stringify((toolMessages[2] as { details?: unknown } | undefined)?.details);
		assert.equal(results.length, 4);
		assert.match(results[0] ?? "", /ACTIVE_TOOLS:[^\n]*fixture_search/);
		assert.match(results[0] ?? "", /ACTIVE_TOOLS:[^\n]*read/);
		assert.match(chainDetails, /ACTIVE_TOOLS:[^\n]*fixture_search/);
		assert.match(chainDetails, /ACTIVE_TOOLS:[^\n]*read/);
		assert.match(structuredDetails, /STRUCTURED_OUTPUT_OK/);
		assert.match(results[3] ?? "", /requested unavailable child tools: missing_search/);
		assert.match(results[3] ?? "", /subagentOnlyExtensions/);
	});

	it("boots the extension in a real parent session and delivers a faux child result", async () => {
		const { routeParentThroughSubagent, runRealSubagentSession, subagentToolResults } = await import("../support/real-session-runner.ts");

		const previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_FANOUT_CHILD = "1";
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "1";
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = BOGUS_EXTRA_DIRS;
		process.env.PI_SUBAGENT_PARENT_SESSION = "polluted-parent";
		process.env.PI_SUBAGENT_PI_BINARY = BOGUS_PI_BINARY;
		process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = BOGUS_PI_PACKAGE_ROOT;

		try {
			run = await runRealSubagentSession({
				prompt: "Delegate to a worker and report its exact result.",
				childText: CHILD_MARKER,
				respond: routeParentThroughSubagent({
					childMarker: CHILD_MARKER,
					subagentArgs: {
						agent: "worker",
						task: "Return the marker from the faux child provider.",
						context: "fresh",
						agentScope: "project",
					},
				}),
			});

			const toolResults = subagentToolResults(run.parentSession);
			assert.equal(toolResults.length, 1);
			assert.match(toolResults[0]!, new RegExp(CHILD_MARKER));
			assert.match(run.responseText, new RegExp(CHILD_MARKER));
			assert.doesNotMatch(run.responseText, /CHILD_MISSING/);
			assert.ok(run.modelCalls >= 2, `expected parent tool-call and final turns, got ${run.modelCalls}`);
		} finally {
			await run?.dispose();
			run = undefined;
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
