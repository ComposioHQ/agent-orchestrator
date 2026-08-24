// Minimal Server-Sent-Events frame parser, used by the fetch-based workspace
// stream reader. Native EventSource hides the HTTP status on error, so we read
// the stream with fetch() instead and parse the frames ourselves — this parser
// is the part that turns a byte buffer into events.
//
// A frame is a run of lines terminated by a blank line. Within a frame:
//   - `field: value`   (a leading space after the colon is stripped, per spec)
//   - `data:` lines accumulate, joined with "\n"
//   - lines starting with ":" are comments (keepalives) and ignored
// Kept pure and dependency-free so it is trivially unit-testable.

export type SseEvent = {
	event: string; // defaults to "message" when no event field is present
	data: string;
	id?: string;
};

/**
 * Consume complete frames from `buffer` and return the parsed events plus the
 * unparsed remainder (a partial frame not yet terminated by a blank line). Call
 * repeatedly as more bytes arrive, feeding the returned remainder back in.
 */
export function parseSseFrames(buffer: string): { events: SseEvent[]; rest: string } {
	// Normalise CRLF / lone CR to LF so frame/line splitting is uniform.
	const normalized = buffer.replace(/\r\n?/g, "\n");
	const events: SseEvent[] = [];
	let searchFrom = 0;
	let boundary = normalized.indexOf("\n\n", searchFrom);
	while (boundary !== -1) {
		const frame = normalized.slice(searchFrom, boundary);
		const ev = parseFrame(frame);
		if (ev) events.push(ev);
		searchFrom = boundary + 2;
		boundary = normalized.indexOf("\n\n", searchFrom);
	}
	return { events, rest: normalized.slice(searchFrom) };
}

function parseFrame(frame: string): SseEvent | null {
	let event = "";
	const dataLines: string[] = [];
	let id: string | undefined;
	let sawField = false;
	for (const rawLine of frame.split("\n")) {
		if (rawLine === "" || rawLine.startsWith(":")) continue; // blank or comment
		const colon = rawLine.indexOf(":");
		const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
		let value = colon === -1 ? "" : rawLine.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		switch (field) {
			case "event":
				event = value;
				sawField = true;
				break;
			case "data":
				dataLines.push(value);
				sawField = true;
				break;
			case "id":
				id = value;
				sawField = true;
				break;
			default:
				// Unknown fields are ignored per spec.
				break;
		}
	}
	if (!sawField) return null;
	return { event: event || "message", data: dataLines.join("\n"), id };
}
