export default {
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const incoming = new URL(request.url);
    const target = new URL(
      `${incoming.pathname}${incoming.search}`,
      "https://api.aoagents.dev",
    );
    return fetch(new Request(target, request));
  },
};
