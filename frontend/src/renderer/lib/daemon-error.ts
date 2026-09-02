// The daemon's locked error envelope is {error, code, message} (httpd/envelope,
// APIError in api/schema.ts); `message` is the sentence the CLI prints, so both
// surfaces say the same thing. Some paths carry only `error`.
export function daemonErrorMessage(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const { error, message } = body as { error?: unknown; message?: unknown };
	if (typeof message === "string" && message !== "") return message;
	return typeof error === "string" && error !== "" ? error : null;
}
