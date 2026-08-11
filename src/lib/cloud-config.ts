import "server-only";

export type CloudWebMode = "local" | "staging";

export function cloudWebMode(): CloudWebMode {
  const value = process.env.AO_CLOUD_WEB_MODE?.trim() || "local";
  if (value !== "local" && value !== "staging") {
    throw new Error("AO_CLOUD_WEB_MODE must be local or staging.");
  }
  return value;
}

export function cloudApiBaseUrl(): string {
  const fallback =
    cloudWebMode() === "local"
      ? "http://127.0.0.1:8081"
      : "https://staging-api.aoagents.dev";
  const value = process.env.AO_CLOUD_WEB_API_BASE_URL?.trim() || fallback;
  const url = new URL(value);
  if (url.search || url.hash || url.pathname !== "/") {
    throw new Error("AO_CLOUD_WEB_API_BASE_URL must be an origin.");
  }
  if (cloudWebMode() === "staging" && url.protocol !== "https:") {
    throw new Error("Staging Cloud UI requires an HTTPS API origin.");
  }
  return url.origin;
}

export const localAuthCookie = "ao_cloud_local_session";
