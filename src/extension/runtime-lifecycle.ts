const RUNTIME_LIFECYCLE_REGISTRY_KEY = Symbol.for("pi-subagents.runtime-lifecycle.v1");

interface RuntimeLifecycleRecord {
	active?: RuntimeLifecycleRegistration;
	notifySeen: Map<string, number>;
	visibleControlNotices: Set<string>;
}

interface RuntimeLifecycleRegistry {
	version: 1;
	records: WeakMap<object, RuntimeLifecycleRecord>;
}

export interface RuntimeLifecycleRegistration {
	readonly notifySeen: Map<string, number>;
	readonly visibleControlNotices: Set<string>;
	add(disposer: () => void): void;
	dispose(): void;
}

function registry(): RuntimeLifecycleRegistry {
	const globalObject = globalThis as Record<PropertyKey, unknown>;
	const existing = globalObject[RUNTIME_LIFECYCLE_REGISTRY_KEY];
	if (existing === undefined) {
		const created: RuntimeLifecycleRegistry = {
			version: 1,
			records: new WeakMap(),
		};
		globalObject[RUNTIME_LIFECYCLE_REGISTRY_KEY] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || (existing as Partial<RuntimeLifecycleRegistry>).version !== 1
		|| !((existing as Partial<RuntimeLifecycleRegistry>).records instanceof WeakMap)) {
		throw new Error("Malformed pi-subagents runtime lifecycle registry.");
	}
	return existing as RuntimeLifecycleRegistry;
}

/**
 * Begin one extension registration for a Pi event bus. Reloading the same
 * runtime disposes its prior registration; registrations on other event buses
 * remain independent. Disposal is idempotent and cannot remove a replacement.
 */
export function beginRuntimeLifecycle(identity: object): RuntimeLifecycleRegistration {
	const records = registry().records;
	let record = records.get(identity);
	if (!record) {
		record = {
			notifySeen: new Map(),
			visibleControlNotices: new Set(),
		};
		records.set(identity, record);
	}

	record.active?.dispose();

	let disposed = false;
	const disposers: Array<() => void> = [];
	const registration: RuntimeLifecycleRegistration = {
		notifySeen: record.notifySeen,
		visibleControlNotices: record.visibleControlNotices,
		add(disposer) {
			if (disposed) {
				try { disposer(); } catch {}
				return;
			}
			disposers.push(disposer);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (let index = disposers.length - 1; index >= 0; index--) {
				try { disposers[index]?.(); } catch {}
			}
			disposers.length = 0;
			if (record?.active === registration) record.active = undefined;
		},
	};
	record.active = registration;
	return registration;
}
