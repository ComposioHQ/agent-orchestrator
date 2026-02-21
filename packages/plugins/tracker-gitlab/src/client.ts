import { setTimeout } from "node:timers/promises";

export type GitLabClientOptions = {
    baseUrl?: string; // e.g. https://gitlab.com/api/v4 or https://gitlab.example.com
    token: string;
    timeoutMs?: number;
    maxRetries?: number;
};

function defaultBaseUrl(url?: string): string {
    if (!url) return "https://gitlab.com/api/v4";
    let normalized = String(url).trim();
    normalized = normalized.replace(/\/+$/, ""); // remove trailing slashes
    if (normalized.endsWith("/api/v4")) return normalized;
    return `${normalized}/api/v4`;
}

/**
 * Minimal REST client for GitLab using global fetch (Node 20+).
 * Implements simple retry/backoff for 429/5xx, with proper timer cancellation.
 *
 * NOTE: request<T> returns Promise<T | null> — null indicates a successful
 * HTTP response with empty body. Callers must handle that case explicitly.
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
    ): Promise<T | null> {
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        const url = new URL(`${this.baseUrl}${normalizedPath}`);

        if (query) {
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
            }
        }

        let attempt = 0;
        while (true) {
            attempt += 1;

            const fetchController = new AbortController();
            const timeoutController = new AbortController();

            const timeoutPromise = setTimeout(this.timeoutMs, undefined, {
                signal: timeoutController.signal,
            }).then(() => {
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

                const res = (await Promise.race([fetchPromise, timeoutPromise])) as Response;
                const text = await res.text().catch(() => "");

                if (res.status >= 200 && res.status < 300) {
                    // If body is empty, return null explicitly (instead of unsafe cast)
                    if (!text) return null;
                    return JSON.parse(text) as T;
                }

                if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
                    const backoff = 100 * 2 ** (attempt - 1);
                    const jitter = Math.floor(Math.random() * 100);
                    await setTimeout(backoff + jitter);
                    continue;
                }

                throw new Error(`GitLab API ${res.status} ${res.statusText}: ${text.slice(0, 1000)}`);
            } catch (err) {
                const name = (err as any)?.name;
                const isAbort = name === "AbortError" || name === "TimeoutError";
                if ((isAbort || (err as any)?.code === "ECONNRESET" || (err as any)?.code === "ENOTFOUND") && attempt < this.maxRetries) {
                    const backoff = 100 * 2 ** (attempt - 1);
                    await setTimeout(backoff + Math.floor(Math.random() * 100));
                    continue;
                }
                throw err;
            } finally {
                try {
                    timeoutController.abort();
                } catch {
                    // ignore
                }
            }
        }
    }

    async get<T = any>(path: string, query?: Record<string, string | number | undefined>): Promise<T | null> {
        return this.request<T>("GET", path, undefined, query);
    }

    async post<T = any>(path: string, data?: unknown): Promise<T | null> {
        return this.request<T>("POST", path, data);
    }

    async put<T = any>(path: string, data?: unknown): Promise<T | null> {
        return this.request<T>("PUT", path, data);
    }

    async patch<T = any>(path: string, data?: unknown): Promise<T | null> {
        return this.request<T>("PATCH", path, data);
    }
}