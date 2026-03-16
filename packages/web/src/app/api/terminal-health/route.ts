import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getTerminalTransportHealth } from "@/lib/terminal-transport";

const HEAL_COOLDOWN_MS = 30_000;
let lastHealAt = 0;

function shouldHeal(): boolean {
  const now = Date.now();
  if (now - lastHealAt < HEAL_COOLDOWN_MS) {
    return false;
  }
  lastHealAt = now;
  return true;
}

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const observed = await getTerminalTransportHealth({ heal: false });
  if (!observed.degraded || !shouldHeal()) {
    return jsonWithCorrelation(observed, { status: 200 }, correlationId);
  }

  const health = await getTerminalTransportHealth({ heal: true });
  return jsonWithCorrelation(health, { status: 200 }, correlationId);
}
