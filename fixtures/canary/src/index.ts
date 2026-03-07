/**
 * Canary App — minimal Express-like server for ao-teams validation.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface Route {
  method: string;
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

const routes: Route[] = [];

export function get(path: string, handler: Route["handler"]): void {
  routes.push({ method: "GET", path, handler });
}

export function post(path: string, handler: Route["handler"]): void {
  routes.push({ method: "POST", path, handler });
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const route = routes.find(
    (r) => r.method === req.method && r.path === req.url,
  );

  if (route) {
    route.handler(req, res);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
}

// Default route
get("/", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", app: "canary" }));
});

get("/health", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ healthy: true }));
});

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Canary app listening on port ${PORT}`);
});

export { server, routes };
