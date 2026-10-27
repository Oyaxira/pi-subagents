import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";

export function registerWaitTool(pi: ExtensionAPI, state: SubagentState, enabled = resolveWaitToolConfig().enabled): void {
	const tool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "subagent_wait",
		label: "Subagent Wait",
		description: `Block until a background subagent run finishes or needs attention, or the user sends a message, then return.

Use it only when this turn cannot finish without the result, such as a skill that must complete or a non-interactive run. In a chat, end your turn instead: Pi wakes you when background runs finish. If the user sends a message while you wait, the wait returns early so you can answer; the runs keep going.

• { } — return when the first run active now finishes.
• { all: true } — wait for every run active now.
• { id: "..." } — wait for one run (id or prefix).
• { timeoutMs: 600000 } — give up after N ms (default 30 minutes); the runs keep going.${enabled ? "" : "\n\nConfigured behavior: subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`,
		parameters: SubagentWaitParams,
		execute(_id, params, signal, _onUpdate, ctx) {
			return waitForSubagents(params, signal, {
				state,
				events: pi.events,
				enabled,
				hasPendingUserInput: () => ctx?.hasPendingMessages?.() === true,
			});
		},
	};
	pi.registerTool(tool);
}
