import type { RendererTelemetryCapture, TelemetryPolicySnapshot, TelemetryPolicyView } from "../shared/telemetry-policy";
import type { DaemonTelemetryPolicyAcknowledgement } from "./daemon-telemetry-policy-client";

const agentSwitchFailureProductionEnabled = false;

export type DesktopTelemetryTransport = {
	closeAndDrain(): Promise<void>;
	clearCache(): Promise<void>;
	capture(request: RendererTelemetryCapture): void;
};

type Authority = {
	durabilitySupported: boolean;
	load(): Promise<TelemetryPolicySnapshot>;
	snapshot(): TelemetryPolicySnapshot;
	setEventsEnabled(enabled: boolean): Promise<TelemetryPolicySnapshot>;
};

type DaemonPolicyClient = {
	prepareDisable(): Promise<DaemonTelemetryPolicyAcknowledgement>;
	applyPolicy(generation: string, enabled: boolean): Promise<DaemonTelemetryPolicyAcknowledgement>;
};

export class DesktopTelemetryController {
	private view: TelemetryPolicyView;
	private transport: DesktopTelemetryTransport | null = null;
	private operation: Promise<TelemetryPolicyView>;

	constructor(private readonly options: {
		authority: Authority;
		daemon: DaemonPolicyClient;
		transportFactory: () => Promise<DesktopTelemetryTransport | null>;
		environmentAllowsEvents: boolean;
		productionEnabled?: boolean;
		broadcast?: (view: TelemetryPolicyView) => void;
		clearRendererQueues?: () => Promise<void>;
	}) {
		this.view = this.toView(options.authority.snapshot(), "applied");
		this.operation = Promise.resolve(this.view);
	}

	snapshot(): TelemetryPolicyView { return { ...this.view }; }

	initialize(): Promise<TelemetryPolicyView> {
		return this.serialize(async () => {
			const snapshot = await this.options.authority.load();
			let applied = false;
			if (snapshot.acknowledged) {
				try {
					const ack = await this.options.daemon.applyPolicy(snapshot.consentGeneration, snapshot.eventsEnabled);
					applied = this.acknowledges(snapshot.eventsEnabled, snapshot.consentGeneration, ack);
				} catch { applied = false; }
			}
			this.view = this.toView({ ...snapshot, acknowledged: snapshot.acknowledged && applied }, snapshot.acknowledged ? (applied ? "applied" : "cleanup_pending") : "cleanup_failed", snapshot.acknowledged ? (applied ? this.baseReason() : "daemon_cleanup_pending") : (this.options.authority.durabilitySupported ? "invalid_authority" : "durability_unsupported"));
			if (applied && this.captureEnabled(snapshot)) this.transport = await this.options.transportFactory();
			this.publish();
			return this.snapshot();
		});
	}

	setEventsEnabled(enabled: boolean, expectedGeneration: string): Promise<TelemetryPolicyView> {
		return this.serialize(async () => {
			if (expectedGeneration !== this.view.consentGeneration) throw new Error("stale telemetry consent generation");
			return enabled ? this.enable() : this.disable();
		});
	}

	async retryPendingCleanup(): Promise<TelemetryPolicyView> {
		return this.serialize(async () => {
			if (this.view.state === "applied") return this.snapshot();
			try {
				const ack = await this.options.daemon.applyPolicy(this.view.consentGeneration, this.view.eventsEnabled);
				if (!this.acknowledges(this.view.eventsEnabled, this.view.consentGeneration, ack)) throw new Error("policy was not acknowledged");
				this.view = { ...this.view, state: "applied", acknowledged: true, reason: this.baseReason() };
				if (this.captureEnabled(this.view) && !this.transport) this.transport = await this.options.transportFactory();
			} catch {
				this.view = { ...this.view, state: "cleanup_pending", acknowledged: false, reason: "daemon_cleanup_pending" };
			}
			this.publish(); return this.snapshot();
		});
	}

	capture(request: RendererTelemetryCapture): boolean {
		if (!this.captureEnabled(this.view) || request.consentGeneration !== this.view.consentGeneration || !this.transport) return false;
		this.transport.capture(request); return true;
	}

	private async disable(): Promise<TelemetryPolicyView> {
		const closingTransport = this.transport;
		await closingTransport?.closeAndDrain(); this.transport = null;
		try { await this.options.daemon.prepareDisable(); } catch { /* durable off still proceeds */ }
		let snapshot: TelemetryPolicySnapshot;
		try { snapshot = await this.options.authority.setEventsEnabled(false); }
		catch (error) { snapshot = this.options.authority.snapshot(); this.view = this.toView(snapshot, "cleanup_failed", "cleanup_failed"); this.publish(); throw error; }
		let applied = false;
		try {
			const ack = await this.options.daemon.applyPolicy(snapshot.consentGeneration, false);
			applied = ack.consentGeneration === snapshot.consentGeneration && !ack.eventsEnabled && ack.purgeConfirmed;
		} catch { applied = false; }
		await closingTransport?.clearCache().catch(() => undefined);
		await this.options.clearRendererQueues?.().catch(() => undefined);
		this.view = this.toView({ ...snapshot, acknowledged: snapshot.acknowledged && applied }, applied ? "applied" : "cleanup_pending", applied ? this.baseReason() : "daemon_cleanup_pending");
		this.publish(); return this.snapshot();
	}

	private async enable(): Promise<TelemetryPolicyView> {
		if (!this.options.authority.durabilitySupported) throw new Error("telemetry enablement is unavailable because durable policy replacement is unsupported");
		if (!this.options.environmentAllowsEvents) { this.view = { ...this.view, environmentVeto: true, reason: "environment_veto" }; this.publish(); return this.snapshot(); }
		if (!this.view.eventsEnabled && this.view.state !== "applied") {
			const cleanup = await this.options.daemon.applyPolicy(this.view.consentGeneration, false);
			if (!cleanup.purgeConfirmed || cleanup.eventsEnabled || cleanup.consentGeneration !== this.view.consentGeneration) throw new Error("prior telemetry purge is incomplete");
		}
		const snapshot = await this.options.authority.setEventsEnabled(true);
		const ack = await this.options.daemon.applyPolicy(snapshot.consentGeneration, true);
		const releaseEnabled = this.options.productionEnabled ?? agentSwitchFailureProductionEnabled;
		if (ack.consentGeneration !== snapshot.consentGeneration || (releaseEnabled && !ack.eventsEnabled)) {
			this.view = this.toView({ ...snapshot, acknowledged: false }, "cleanup_failed", "cleanup_failed"); this.publish(); return this.snapshot();
		}
		if (this.captureEnabled(snapshot)) this.transport = await this.options.transportFactory();
		this.view = this.toView(snapshot, "applied", this.baseReason()); this.publish(); return this.snapshot();
	}

	private captureEnabled(snapshot: Pick<TelemetryPolicySnapshot, "eventsEnabled" | "acknowledged">): boolean {
		return snapshot.eventsEnabled && snapshot.acknowledged && this.options.authority.durabilitySupported && this.options.environmentAllowsEvents && (this.options.productionEnabled ?? agentSwitchFailureProductionEnabled);
	}

	private toView(snapshot: TelemetryPolicySnapshot, state: TelemetryPolicyView["state"], reason = this.baseReason()): TelemetryPolicyView {
		return { ...snapshot, state, environmentVeto: !this.options.environmentAllowsEvents, durabilitySupported: this.options.authority.durabilitySupported, reason };
	}

	private baseReason(): TelemetryPolicyView["reason"] {
		if (!this.options.authority.durabilitySupported) return "durability_unsupported";
		if (!this.options.environmentAllowsEvents) return "environment_veto";
		if (!(this.options.productionEnabled ?? agentSwitchFailureProductionEnabled)) return "release_blocked";
		return undefined;
	}

	private acknowledges(enabled: boolean, generation: string, ack: DaemonTelemetryPolicyAcknowledgement): boolean {
		if (ack.consentGeneration !== generation) return false;
		if (!enabled) return !ack.eventsEnabled && ack.purgeConfirmed;
		return ack.eventsEnabled || !(this.options.productionEnabled ?? agentSwitchFailureProductionEnabled);
	}

	private publish(): void { this.options.broadcast?.(this.snapshot()); }

	private serialize(operation: () => Promise<TelemetryPolicyView>): Promise<TelemetryPolicyView> {
		const next = this.operation.catch(() => this.snapshot()).then(operation);
		this.operation = next; return next;
	}
}
