export function parseResponseArray<T>(
	body: unknown,
	key: string,
	isItem: (value: unknown) => value is T,
): T[] | null {
	if (typeof body !== "object" || body === null) return null;
	const items = (body as Record<string, unknown>)[key];
	return Array.isArray(items) && items.every(isItem) ? items : null;
}
