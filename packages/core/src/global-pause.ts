export const GLOBAL_PAUSE_UNTIL_KEY = "globalPauseUntil";
export const GLOBAL_PAUSE_REASON_KEY = "globalPauseReason";
export const GLOBAL_PAUSE_SOURCE_KEY = "globalPauseSource";

export function parsePauseUntil(raw: string | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}
