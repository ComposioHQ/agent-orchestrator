export interface ParsedResource {
  source: string | null; // null = use project default
  id: string;
}

/**
 * Parse spawn resource argument into source + id.
 *
 * Rules:
 *   "POS-863"           -> { source: null, id: "POS-863" }   (bare Linear ID)
 *   "linear:POS-863"    -> { source: "linear", id: "POS-863" }
 *   "github:456"        -> { source: "github", id: "456" }
 *   "https://..."       -> { source: "url", id: "https://..." }
 *   "notion:page-abc"   -> { source: "notion", id: "page-abc" }
 */
export function parseResourceArg(arg: string): ParsedResource {
  if (!arg) throw new Error("Resource argument is required");

  // Full URL — treat as URL source
  if (/^https?:\/\//.test(arg)) return { source: "url", id: arg };

  // Linear-style identifier: TEAM-NUMBER
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(arg)) return { source: null, id: arg };

  // source:id format
  const colon = arg.indexOf(":");
  if (colon > 0 && colon < arg.length - 1) {
    return { source: arg.slice(0, colon), id: arg.slice(colon + 1) };
  }

  return { source: null, id: arg };
}
