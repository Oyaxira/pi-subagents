import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { MainWatchdogRuntime } from "../../src/watchdog/runtime.ts";

for (const enabled of [false, true]) {
	it(`starting a message hides background Git windows with watchdog ${enabled ? "enabled" : "disabled"}`, (t) => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-background-git-"));
		t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const init = childProcess.spawnSync("git", ["init", cwd], { encoding: "utf-8", windowsHide: true });
		assert.equal(init.status, 0, init.stderr);
		const runtime = new MainWatchdogRuntime({
			cwd,
			reviewChangesOnly: true,
			resolveConfig: () => ({
				ok: true,
				config: {
					...DEFAULT_WATCHDOG_CONFIG,
					enabled,
					main: { ...DEFAULT_WATCHDOG_CONFIG.main, enabled },
				},
				errors: [],
				sources: [],
			}),
		});
		t.after(() => runtime.dispose());

		// Spy only at the OS boundary; execute real Git to preserve its results.
		const original = childProcess.spawnSync;
		const spy = t.mock.method(childProcess, "spawnSync", original);
		syncBuiltinESMExports();
		t.after(() => {
			spy.mock.restore();
			syncBuiltinESMExports();
		});
		runtime.handleBeforeAgentStart({ prompt: "Hello" }, { cwd });

		const calls = spy.mock.calls;
		assert.deepEqual(calls.map(({ arguments: args }) => args[1]?.slice(2)), [
			["rev-parse", "--show-toplevel"],
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		]);
		for (const { arguments: args } of calls) {
			assert.equal(args[0], "git");
			assert.equal(args[2]?.windowsHide, true, "background Git must not create a Windows console");
		}
	});
}
