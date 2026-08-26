export type ComposerTokenKind = "skill" | "file";

/**
 * One semantic token over the composer's canonical agent-facing text.
 *
 * Ranges use JavaScript UTF-16 string offsets. The text remains authoritative:
 * tokens only restore editor semantics and are ignored when their range does not
 * exactly contain the wire representation derived from kind and value.
 */
export interface ComposerDraftToken {
	kind: ComposerTokenKind;
	value: string;
	start: number;
	end: number;
}

export interface ComposerDraftContent {
	text: string;
	tokens: ComposerDraftToken[];
}

export const EMPTY_COMPOSER_CONTENT: ComposerDraftContent = { text: "", tokens: [] };

/** The exact plain text delivered to the agent for a semantic composer token. */
export function composerTokenWire(kind: ComposerTokenKind, value: string): string {
	return kind === "skill" ? `/${value}` : /\s/.test(value) ? `"${value}"` : value;
}

function isComposerTokenKind(value: unknown): value is ComposerTokenKind {
	return value === "skill" || value === "file";
}

/**
 * Preserve canonical text while accepting semantic annotations only when the
 * complete list proves it describes that exact text. Corrupt, stale, or
 * forward-version annotations safely become ordinary text; this function never
 * tries to rediscover tokens by parsing the text.
 */
export function normalizeComposerDraftContent(input: {
	text: string;
	tokens?: unknown;
}): ComposerDraftContent {
	if (!Array.isArray(input.tokens)) return { text: input.text, tokens: [] };
	const tokens: ComposerDraftToken[] = [];
	let previousEnd = 0;
	for (const candidate of input.tokens) {
		if (!candidate || typeof candidate !== "object") {
			return { text: input.text, tokens: [] };
		}
		const token = candidate as Partial<ComposerDraftToken>;
		if (
			!isComposerTokenKind(token.kind) ||
			typeof token.value !== "string" ||
			token.value.length === 0 ||
			typeof token.start !== "number" ||
			!Number.isInteger(token.start) ||
			typeof token.end !== "number" ||
			!Number.isInteger(token.end) ||
			token.start < previousEnd ||
			token.start < 0 ||
			token.end <= token.start ||
			token.end > input.text.length ||
			/[\r\n]/.test(input.text.slice(token.start, token.end)) ||
			input.text.slice(token.start, token.end) !== composerTokenWire(token.kind, token.value)
		) {
			return { text: input.text, tokens: [] };
		}
		tokens.push({
			kind: token.kind,
			value: token.value,
			start: token.start,
			end: token.end,
		});
		previousEnd = token.end;
	}
	return { text: input.text, tokens };
}

export function composerDraftContentEqual(
	current: ComposerDraftContent,
	next: ComposerDraftContent,
): boolean {
	return (
		current.text === next.text &&
		current.tokens.length === next.tokens.length &&
		current.tokens.every((token, index) => {
			const candidate = next.tokens[index];
			return (
				candidate !== undefined &&
				token.kind === candidate.kind &&
				token.value === candidate.value &&
				token.start === candidate.start &&
				token.end === candidate.end
			);
		})
	);
}
