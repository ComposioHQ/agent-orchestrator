import { NextResponse } from "next/server";
import { issueMuxConnectToken, TerminalAuthError } from "@/lib/server/terminal-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const grant = issueMuxConnectToken();
    return NextResponse.json(
      { token: grant.token, expiresAt: grant.expiresAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof TerminalAuthError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw err;
  }
}
