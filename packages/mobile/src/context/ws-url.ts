export function deriveTerminalWsUrl(backendUrl: string): string {
  try {
    const url = new URL(backendUrl);
    if (url.protocol === "https:") {
      return `wss://${url.host}`;
    }
    return `ws://${url.hostname}:14801`;
  } catch {
    return "ws://192.168.1.1:14801";
  }
}

export function normalizeWsUrl(url: string): string {
  return url.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}
