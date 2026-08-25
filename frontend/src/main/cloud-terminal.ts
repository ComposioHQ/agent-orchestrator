import { ipcMain, type WebContents } from "electron";
import { WebSocket, type RawData } from "ws";
import type { CloudTerminalEvent, CloudTerminalOpenInput } from "../shared/cloud-beta";
import { cloudApiBaseUrl, createCloudTerminalTicket } from "./cloud-beta";

type TerminalConnection = {
	connectionId: string;
	owner: WebContents;
	socket: WebSocket;
	ready: boolean;
	cols: number;
	rows: number;
};

type TerminalServerMessage = {
	type?: string;
	data?: string;
	message?: string;
	sequence?: number;
};

const connections = new Map<string, TerminalConnection>();
const cursors = new Map<string, number>();

function connectionKey(owner: WebContents, connectionId: string): string {
	return `${owner.id}:${connectionId}`;
}

function cursorKey(input: Pick<CloudTerminalOpenInput, "orgId" | "sessionId" | "kind">): string {
	return `${input.orgId}:${input.sessionId}:${input.kind}`;
}

function send(owner: WebContents, event: CloudTerminalEvent): void {
	if (!owner.isDestroyed()) owner.send("cloud:terminalEvent", event);
}

function terminalURL(ticket: string, kind: CloudTerminalOpenInput["kind"], after: number): string {
	const url = new URL("/api/cloud/v1/terminal", cloudApiBaseUrl());
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("ticket", ticket);
	url.searchParams.set("kind", kind);
	url.searchParams.set("after", String(after));
	url.searchParams.set("protocol", "2");
	return url.toString();
}

function validOpenInput(input: CloudTerminalOpenInput): boolean {
	return (
		typeof input.connectionId === "string" &&
		input.connectionId.length > 0 &&
		input.connectionId.length <= 128 &&
		typeof input.orgId === "string" &&
		typeof input.sessionId === "string" &&
		(input.kind === "agent" || input.kind === "workspace") &&
		Number.isInteger(input.cols) &&
		Number.isInteger(input.rows) &&
		input.cols > 0 &&
		input.rows > 0 &&
		input.cols <= 65535 &&
		input.rows <= 65535
	);
}

function closeConnection(owner: WebContents, connectionId: string): void {
	const key = connectionKey(owner, connectionId);
	const connection = connections.get(key);
	if (!connection) return;
	connections.delete(key);
	connection.socket.close();
}

function rawDataBase64(data: RawData): string {
	if (Array.isArray(data)) return Buffer.concat(data).toString("base64");
	if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("base64");
	return Buffer.from(data).toString("base64");
}

export function installCloudTerminalIPC(options: {
	getAccessToken: () => Promise<string>;
	requireEnabled: () => Promise<void>;
}): { closeAll: () => void } {
	ipcMain.handle("cloud:terminalOpen", async (event, input: CloudTerminalOpenInput) => {
		await options.requireEnabled();
		if (!validOpenInput(input)) throw new Error("The Cloud terminal request is invalid.");
		closeConnection(event.sender, input.connectionId);

		const cursor = cursorKey(input);
		const { ticket } = await createCloudTerminalTicket(
			await options.getAccessToken(),
			input.orgId,
			input.sessionId,
			input.kind,
		);
		const socket = new WebSocket(terminalURL(ticket, input.kind, cursors.get(cursor) ?? 0));
		const connection: TerminalConnection = {
			connectionId: input.connectionId,
			owner: event.sender,
			socket,
			ready: false,
			cols: input.cols,
			rows: input.rows,
		};
		const key = connectionKey(event.sender, input.connectionId);
		connections.set(key, connection);

		const isCurrent = () => connections.get(key) === connection;
		socket.on("open", () => {
			if (isCurrent()) send(connection.owner, { connectionId: connection.connectionId, type: "connection", state: "open" });
		});
		socket.on("message", (data, isBinary) => {
			if (!isCurrent()) return;
			if (isBinary) {
				connection.ready = true;
				send(connection.owner, { connectionId: connection.connectionId, type: "opened" });
				send(connection.owner, { connectionId: connection.connectionId, type: "data", data: rawDataBase64(data) });
				return;
			}
			let message: TerminalServerMessage;
			try {
				message = JSON.parse(data.toString()) as TerminalServerMessage;
			} catch {
				return;
			}
			if (typeof message.sequence === "number") {
				cursors.set(cursor, Math.max(cursors.get(cursor) ?? 0, message.sequence));
			}
			if (message.type === "ready" || message.type === "replay_complete") {
				if (!connection.ready) {
					connection.ready = true;
					send(connection.owner, { connectionId: connection.connectionId, type: "opened" });
				}
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: "resize", columns: connection.cols, rows: connection.rows }));
				}
				return;
			}
			if (message.type === "reset") {
				cursors.set(cursor, 0);
				return;
			}
			if (message.type === "output" && message.data) {
				send(connection.owner, { connectionId: connection.connectionId, type: "data", data: message.data });
				return;
			}
			if (message.type === "error") {
				send(connection.owner, {
					connectionId: connection.connectionId,
					type: "error",
					message: message.message ?? "Cloud terminal request failed.",
				});
			}
		});
		socket.on("close", (code, reason) => {
			if (!isCurrent()) return;
			connections.delete(key);
			if (code === 1000 && connection.ready) {
				send(connection.owner, { connectionId: connection.connectionId, type: "exited" });
			} else if (code === 1008) {
				send(connection.owner, {
					connectionId: connection.connectionId,
					type: "error",
					message: reason.toString() || "The Cloud agent terminal is unavailable.",
				});
			} else {
				send(connection.owner, { connectionId: connection.connectionId, type: "connection", state: "closed" });
			}
		});
		socket.on("error", () => {
			// The close event owns the retry/error decision and carries the only
			// useful status. Never include the ticket-bearing socket URL in an error.
		});
		event.sender.once("destroyed", () => closeConnection(event.sender, input.connectionId));
	});

	ipcMain.on("cloud:terminalInput", (event, connectionId: string, input: string) => {
		const connection = connections.get(connectionKey(event.sender, connectionId));
		if (!connection?.ready || connection.socket.readyState !== WebSocket.OPEN || typeof input !== "string") return;
		connection.socket.send(JSON.stringify({ type: "input", data: input }));
	});
	ipcMain.on("cloud:terminalResize", (event, connectionId: string, cols: number, rows: number) => {
		const connection = connections.get(connectionKey(event.sender, connectionId));
		if (!connection || !Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
		connection.cols = Math.min(cols, 65535);
		connection.rows = Math.min(rows, 65535);
		if (!connection.ready || connection.socket.readyState !== WebSocket.OPEN) return;
		connection.socket.send(JSON.stringify({ type: "resize", columns: connection.cols, rows: connection.rows }));
	});
	ipcMain.on("cloud:terminalClose", (event, connectionId: string) => closeConnection(event.sender, connectionId));

	return {
		closeAll: () => {
			for (const connection of connections.values()) connection.socket.close();
			connections.clear();
		},
	};
}
