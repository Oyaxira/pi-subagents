import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beginRuntimeLifecycle } from "../../src/extension/runtime-lifecycle.ts";

describe("runtime lifecycle registry", () => {
	it("keeps distinct event bus registrations alive independently", () => {
		const firstBus = {};
		const secondBus = {};
		let firstDisposed = 0;
		let secondDisposed = 0;
		const first = beginRuntimeLifecycle(firstBus);
		first.add(() => { firstDisposed++; });
		const second = beginRuntimeLifecycle(secondBus);
		second.add(() => { secondDisposed++; });

		second.dispose();
		assert.equal(firstDisposed, 0);
		assert.equal(secondDisposed, 1);
		first.dispose();
		assert.equal(firstDisposed, 1);
	});

	it("replaces only the same event bus and makes stale cleanup harmless", () => {
		const bus = {};
		let oldDisposed = 0;
		let replacementDisposed = 0;
		const old = beginRuntimeLifecycle(bus);
		old.notifySeen.set("old-completion", 1);
		old.visibleControlNotices.add("old-notice");
		old.add(() => { oldDisposed++; });

		const replacement = beginRuntimeLifecycle(bus);
		replacement.add(() => { replacementDisposed++; });
		assert.equal(oldDisposed, 1);
		assert.equal(replacement.notifySeen.get("old-completion"), 1);
		assert.equal(replacement.visibleControlNotices.has("old-notice"), true);

		old.dispose();
		assert.equal(replacementDisposed, 0);
		replacement.dispose();
		assert.equal(replacementDisposed, 1);
	});
});
