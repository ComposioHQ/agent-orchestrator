import type { LinearWebhookPayload } from "./types.js";

export function wasLabelAdded(payload: LinearWebhookPayload, labelName: string): boolean {
  const currentLabels = payload.data.labels;
  if (!currentLabels) return false;

  const target = labelName.toLowerCase();
  const matchingLabel = currentLabels.find((l) => l.name.toLowerCase() === target);
  if (!matchingLabel) return false;

  const previousLabelIds = payload.updatedFrom?.labelIds;
  if (previousLabelIds && previousLabelIds.includes(matchingLabel.id)) {
    return false;
  }

  return true;
}

export function wasMovedToCompleted(payload: LinearWebhookPayload): boolean {
  const currentState = payload.data.state;
  const previousState = payload.updatedFrom?.state;

  if (!currentState || currentState.type !== "completed") return false;
  if (previousState?.type === "completed") return false;

  return true;
}
