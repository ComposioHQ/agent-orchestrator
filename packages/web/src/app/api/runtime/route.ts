import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    terminalPort: process.env["TERMINAL_PORT"] ?? "14800",
    directTerminalPort: process.env["DIRECT_TERMINAL_PORT"] ?? "14801",
  });
}
