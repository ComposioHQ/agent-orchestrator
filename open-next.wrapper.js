import worker, {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache,
} from "./.open-next/worker.js";

export { BucketCachePurge, DOQueueHandler, DOShardedTagCache };

const TERMINAL_PATH = "/api/cloud/v1/terminal";

export default {
  async fetch(request, env, ctx) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const url = new URL(request.url);
      if (url.pathname === TERMINAL_PATH) {
        const apiBase =
          env.AO_CLOUD_WEB_API_BASE_URL || "https://api.aoagents.dev";
        return fetch(new URL(`${url.pathname}${url.search}`, apiBase), request);
      }
    }
    return worker.fetch(request, env, ctx);
  },
};
