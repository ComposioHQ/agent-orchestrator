import { NextResponse } from "next/server";
import { checkForUpdates, isDirty } from "@/lib/git";

/** GET /api/self-update/check — Check for available updates */
export async function GET() {
  try {
    const [update, dirty] = await Promise.all([checkForUpdates(), isDirty()]);

    if (!update) {
      return NextResponse.json({ available: false, dirty });
    }

    return NextResponse.json({
      available: true,
      dirty,
      behindCount: update.behindCount,
      commits: update.commits,
      currentHead: update.currentHead,
      remoteHead: update.remoteHead,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to check for updates";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
