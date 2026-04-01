import { jsonWithCorrelation } from "./observability";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "PATH_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "NOT_A_GIT_REPO"
  | "ALREADY_REGISTERED"
  | "CONFIG_WRITE_ERROR"
  | "CONCURRENT_MODIFICATION";

/** Build a JSON error response with correlation ID */
export function apiError(
  correlationId: string,
  message: string,
  code: ApiErrorCode,
  status: number,
  details?: Record<string, unknown>,
) {
  return jsonWithCorrelation(
    { error: message, code, ...(details ? { details } : {}) },
    { status },
    correlationId,
  );
}

/** Build a validation error response from a Zod error */
export function zodValidationError(
  correlationId: string,
  zodError: { issues: Array<{ path: (string | number)[]; message: string }> },
) {
  const fields = zodError.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return apiError(correlationId, "Validation failed", "VALIDATION_ERROR", 400, { fields });
}
