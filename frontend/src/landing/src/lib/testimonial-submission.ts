export const MAX_TESTIMONIAL_WORDS = 500;

export function countWords(value: string) {
	return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

export function limitWords(value: string, maxWords = MAX_TESTIMONIAL_WORDS) {
	let wordCount = 0;
	let lastAllowedIndex = value.length;

	for (const match of value.matchAll(/\S+/gu)) {
		wordCount += 1;
		if (wordCount === maxWords) {
			lastAllowedIndex = (match.index ?? 0) + match[0].length;
		}
		if (wordCount > maxWords) {
			return value.slice(0, lastAllowedIndex);
		}
	}

	return value;
}

export function isLinkedInProfileUrl(value: string) {
	try {
		const url = new URL(value);
		const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
		return (
			url.protocol === "https:" &&
			hostname === "linkedin.com" &&
			/^\/in\/[^/]+\/?$/u.test(url.pathname)
		);
	} catch {
		return false;
	}
}

export function isTweetUrl(value: string) {
	try {
		const url = new URL(value);
		const hostname = url.hostname.toLowerCase().replace(/^(?:www\.|mobile\.)/, "");
		return (
			url.protocol === "https:" &&
			(hostname === "x.com" || hostname === "twitter.com") &&
			/^\/[^/]+\/status\/\d+\/?$/u.test(url.pathname)
		);
	} catch {
		return false;
	}
}
