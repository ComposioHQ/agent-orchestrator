import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function normalizePort(input: string | undefined, fallback: number): string {
  const parsed = Number.parseInt(input ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return String(parsed);
  }
  return String(fallback);
}

function normalizeProxyPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed;
}

function normalizeHost(input: string | undefined, fallback: string): string {
  const trimmed = input?.trim();
  return trimmed ? trimmed : fallback;
}

export async function GET() {
  const terminalPort = normalizePort(process.env.TERMINAL_PORT, 14800);
  const directTerminalPort = normalizePort(process.env.DIRECT_TERMINAL_PORT, 14801);
  const directTerminalHost = normalizeHost(
    process.env.AO_DIRECT_TERMINAL_HOST ??
      process.env.AO_DASHBOARD_HOST ??
      process.env.HOST,
    "127.0.0.1",
  );
  const proxyWsPath = normalizeProxyPath(
    process.env.TERMINAL_WS_PATH ?? process.env.NEXT_PUBLIC_TERMINAL_WS_PATH,
  );

  return NextResponse.json(
    { terminalPort, directTerminalPort, directTerminalHost, proxyWsPath },
    { headers: { "Cache-Control": "no-store" } },
  );
}
