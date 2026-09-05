// xterm emits OSC 4/10/11/12 color reports on its onData stream. AO forwards
// only strict, complete reports back to the PTY. Cursor Agent's theme probe
// specifically issues OSC 10/11/12 queries on stdout and listens on stdin; AO
// must return the live palette or the prompt bar defaults to dark.

export type OscTerminalColors = {
	foreground: string;
	background: string;
	cursor: string;
};

const OSC_COLOR_PAYLOAD =
	"(?:4;(?:0|[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-5])|1[0-2]);rgb:[0-9a-fA-F]{4}/[0-9a-fA-F]{4}/[0-9a-fA-F]{4}";
const OSC_COLOR_REPORT = new RegExp(`^\\u001b]${OSC_COLOR_PAYLOAD}(?:\\u0007|\\u001b\\\\)$`);
const COMPLETE_OSC_COLOR_REPORT = new RegExp(`^\\u001b]${OSC_COLOR_PAYLOAD}(?:\\u0007|\\u001b\\\\)`);
const OSC_COLOR_PROBE = /\u001b\](?:10|11|12);\?/;
const MAX_OSC_BUFFER_LENGTH = 16 * 1024;

export function isOscColorReport(data: string): boolean {
	return OSC_COLOR_REPORT.test(data);
}

/** Convert #rrggbb or browser-resolved rgb() into xterm's rgb:RRRR/GGGG/BBBB form. */
export function hexToOscRgb(hex: string): string {
	const normalized = hex.replace(/^#/, "").trim();
	if (normalized.length === 3) {
		const [r, g, b] = normalized;
		return `rgb:${r}${r}${r}/${g}${g}${g}/${b}${b}${b}`;
	}
	const r = normalized.slice(0, 2);
	const g = normalized.slice(2, 4);
	const b = normalized.slice(4, 6);
	return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

function cssColorToHex(color: string): string {
	if (!color) return "000000";
	if (color.startsWith("#")) {
		const hex = color.slice(1);
		return hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6);
	}
	if (typeof document === "undefined") return "000000";
	const probe = document.createElement("span");
	probe.style.color = color;
	document.documentElement.appendChild(probe);
	const resolved = getComputedStyle(probe).color;
	probe.remove();
	const match = resolved.match(/(\d+)\D+(\d+)\D+(\d+)/);
	if (!match) return "000000";
	return [match[1], match[2], match[3]]
		.map((channel) => Number(channel).toString(16).padStart(2, "0"))
		.join("");
}

function oscColorReport(slot: 10 | 11 | 12, cssColor: string): string {
	return `\x1b]${slot};${hexToOscRgb(cssColorToHex(cssColor))}\x07`;
}

export function buildOscColorReports(colors: OscTerminalColors): string {
	return (
		oscColorReport(10, colors.foreground) +
		oscColorReport(11, colors.background) +
		oscColorReport(12, colors.cursor)
	);
}

/** Answer OSC 10/11/12 probes emitted on the PTY output stream. */
export function cursorOscProbeRepliesForOutput(chunk: string, colors: OscTerminalColors): string | null {
	if (!OSC_COLOR_PROBE.test(chunk)) return null;
	const replies: string[] = [];
	if (chunk.includes("]10;?")) replies.push(oscColorReport(10, colors.foreground));
	if (chunk.includes("]11;?")) replies.push(oscColorReport(11, colors.background));
	if (chunk.includes("]12;?")) replies.push(oscColorReport(12, colors.cursor));
	return replies.length > 0 ? replies.join("") : null;
}

/** Buffer split xterm onData chunks and forward only complete strict OSC 4/10/11/12 replies. */
export function createOscColorReportForwarder(emit: (report: string) => void): {
	push: (data: string) => void;
	dispose: () => void;
} {
	let buffer = "";

	return {
		push(data: string) {
			buffer += data;
			if (buffer.length > MAX_OSC_BUFFER_LENGTH) {
				// An unterminated OSC must not retain arbitrary PTY output forever.
				// Keep only the newest bounded suffix; the normal start-sequence check
				// below will discard it unless it is still a valid partial report.
				buffer = buffer.slice(-MAX_OSC_BUFFER_LENGTH);
			}
			for (;;) {
				const oscStart = buffer.indexOf("\x1b]");
				if (oscStart === -1) {
					buffer = buffer.endsWith("\x1b") ? "\x1b" : "";
					return;
				}
				if (oscStart > 0) buffer = buffer.slice(oscStart);

				const match = buffer.match(COMPLETE_OSC_COLOR_REPORT);
				if (match) {
					emit(match[0]);
					buffer = buffer.slice(match[0].length);
					continue;
				}

				const bel = buffer.indexOf("\x07");
				const st = buffer.indexOf("\x1b\\");
				const terminator = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
				if (terminator !== -1) {
					buffer = buffer.slice(terminator + (terminator === st ? 2 : 1));
					continue;
				}

				const nextOscStart = buffer.indexOf("\x1b]", 2);
				if (nextOscStart !== -1) {
					buffer = buffer.slice(nextOscStart);
					continue;
				}
				return;
			}
		},
		dispose() {
			buffer = "";
		},
	};
}
