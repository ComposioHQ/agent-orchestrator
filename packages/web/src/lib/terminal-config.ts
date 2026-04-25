export function normalizePort(input: string | undefined, fallback: number): string {
  const parsed = Number.parseInt(input ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return String(parsed);
  }
  return String(fallback);
}
