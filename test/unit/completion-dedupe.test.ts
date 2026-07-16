import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCompletionKey, markSeenWithTtl } from "../../src/runs/background/completion-dedupe.ts";

describe("buildCompletionKey", () => {
	it("uses session and id as the canonical key when present", () => {
		const key = buildCompletionKey({ id: "run-123", sessionId: "session-a", agent: "reviewer", timestamp: 123 }, "fallback");
		assert.equal(key, "id:session-a:run-123");
		assert.notEqual(key, buildCompletionKey({ id: "run-123", sessionId: "session-b" }, "fallback"));
	});

	it("builds deterministic fallback key when id is missing", () => {
		const a = buildCompletionKey({ agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true }, "x");
		const b = buildCompletionKey({ agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true }, "x");
		assert.equal(a, b);
	});
});

describe("markSeenWithTtl", () => {
	it("returns true only for duplicates within ttl", () => {
		const seen = new Map<string, number>();
		const ttlMs = 1000;
		assert.equal(markSeenWithTtl(seen, "k", 100, ttlMs), false);
		assert.equal(markSeenWithTtl(seen, "k", 200, ttlMs), true);
		assert.equal(markSeenWithTtl(seen, "k", 1201, ttlMs), false);
	});
});
