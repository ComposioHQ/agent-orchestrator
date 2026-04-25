import { NextResponse } from "next/server";
import { normalizePort } from "@/lib/terminal-config";

export const dynamic = "force-dynamic";

function normalizeProxyPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed;
}

export async function GET() {
  const terminalPort = normalizePort(process.env.TERMINAL_PORT, 14800);
  const directTerminalPort = normalizePort(process.env.DIRECT_TERMINAL_PORT, 14801);
  const proxyWsPath = normalizeProxyPath(
    process.env.TERMINAL_WS_PATH ?? process.env.NEXT_PUBLIC_TERMINAL_WS_PATH,
  );

  return NextResponse.json(
    { terminalPort, directTerminalPort, proxyWsPath },
    { headers: { "Cache-Control": "no-store" } },
  );
}
