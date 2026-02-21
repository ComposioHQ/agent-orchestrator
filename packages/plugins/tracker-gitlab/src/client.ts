import { setTimeout } from "node:timers/promises";

export type GitLabClientOptions = {
    baseUrl?: string; // e.g. https://gitlab.com/api/v4 or https://gitlab.example.com
    token: string;
    timeoutMs?: number;
    maxRetries?: number;
};

function defaultBaseUrl(url?: string): string {
    // Normalize: trim and remove trailing slashes
    if (!url) return "https://gitlab.com/api/v4";
    let normalized = String(url).trim();
    normalized = normalized.replace(/\/+$/, ""); // remove trailing slashes

    // If user passed full API path (without trailing slash), return as-is
    if (normalized.endsWith("/api/v4")) return normalized;
    // Otherwise append /api/v4
    return `${normalized}/api/v4`;
}

/**
 * Minimal REST client for GitLab using global fetch (Node 20+).
 * Implements simple retry/backoff for 429/5xx, with proper timer cancellation.
 */
export class GitLabClient {
    readonly baseUrl: string;
    readonly token: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;

    constructor(opts: GitLabClientOptions) {
        this.baseUrl = defaultBaseUrl(opts.baseUrl);
        this.token = opts.token;
        this.timeoutMs = opts.timeoutMs ?? 15_000;
        this.maxRetries = opts.maxRetries ?? 3;
    }

    private async request<T = any>(
        method: string,
        path: string,
        body?: unknown,
        query?: Record<string, string | number | undefined>,
    ): Promise<T> {
        // Ensure path begins with a single slash
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;

        // Build URL by concatenation: baseUrl has no trailing slash (defaultBaseUrl ensures it)
        const url = new URL(`${this.baseUrl}${normalizedPath}`);

        if (query) {
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
            }
        }

        let attempt = 0;
        while (true) {
            attempt += 1;

            // Controller for fetch (so we can abort the network request on timeout)
            const fetchController = new AbortController();

            // Controller for the timeout promise (so we can cancel the timer when fetch finishes)
            const timeoutController = new AbortController();

            // Timeout promise that aborts the fetch when fired.
            // It is cancellable via timeoutController.abort()
            const timeoutPromise = setTimeout(this.timeoutMs, undefined, {
                signal: timeoutController.signal,
            }).then(() => {
                // Abort the fetch if timeout occurs, then throw to make the race reject.
                fetchController.abort();
                const err = new Error(`GitLab API request timed out after ${this.timeoutMs}ms`);
                (err as any).name = "TimeoutError";
                throw err;
            });

            try {
                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                    "Private-Token": this.token,
                };

                const fetchPromise = fetch(url.toString(), {
                    method,
                    headers,
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                    signal: fetchController.signal,
                });

                // Race between fetch and timeout promise.
                const res = (await Promise.race([fetchPromise, timeoutPromise])) as Response;

                const text = await res.text().catch(() => "");

                if (res.status >= 200 && res.status < 300) {
                    if (!text) return undefined as unknown as T;
                    return JSON.parse(text) as T;
                }

                // Retry on 429 or 5xx
                if ((res.status === 429 || res.status >= 500) && attempt <= this.maxRetries) {
                    const backoff = 100 * 2 ** (attempt - 1);
                    const jitter = Math.floor(Math.random() * 100);
                    await setTimeout(backoff + jitter);
                    continue;
                }

                // Unrecoverable error
                throw new Error(`GitLab API ${res.status} ${res.statusText}: ${text.slice(0, 1000)}`);
            } catch (err) {
                // Treat some transient errors as retryable
                const name = (err as any)?.name;
                const isAbort = name === "AbortError" || name === "TimeoutError";
                if ((isAbort || (err as any)?.code === "ECONNRESET" || (err as any)?.code === "ENOTFOUND") && attempt < this.maxRetries) {
                    const backoff = 100 * 2 ** (attempt - 1);
                    await setTimeout(backoff + Math.floor(Math.random() * 100));
                    continue;
                }
                throw err;
            } finally {
                // IMPORTANT: cancel the timeout to avoid leaving a dangling timer promise.
                // Calling abort on timeoutController cancels the setTimeout promise if it hasn't fired yet.
                try {
                    timeoutController.abort();
                } catch {
                    // ignore
                }
            }
        }
    }

    async get<T = any>(path: string, query?: Record<string, string | number | undefined>) {
        return this.request<T>("GET", path, undefined, query);
    }

    async post<T = any>(path: string, data?: unknown) {
        return this.request<T>("POST", path, data);
    }

    async put<T = any>(path: string, data?: unknown) {
        return this.request<T>("PUT", path, data);
    }

    async patch<T = any>(path: string, data?: unknown) {
        return this.request<T>("PATCH", path, data);
    }
}