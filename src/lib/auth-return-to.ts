const appOrigin = "https://cloud.aoagents.dev";

export function cloudAuthReturnTo(value?: string | null): string {
  if (!value) return "/app";
  try {
    const url = new URL(value, appOrigin);
    if (url.origin !== appOrigin || url.pathname !== "/app") return "/app";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/app";
  }
}
