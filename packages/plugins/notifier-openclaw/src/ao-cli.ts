import { execFile } from "node:child_process";

export interface AoCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
}

export type AoCliRunner = (args: string[]) => Promise<AoCliResult>;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function createAoCliRunner(options?: {
  binary?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): AoCliRunner {
  const binary = options?.binary ?? "ao";
  const timeoutMs = options?.timeoutMs ?? 15_000;

  return async (args: string[]): Promise<AoCliResult> => {
    return await new Promise<AoCliResult>((resolve) => {
      execFile(
        binary,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, ...options?.env, FORCE_COLOR: "0" },
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({
              ok: true,
              stdout: normalizeText(stdout),
              stderr: normalizeText(stderr),
              exitCode: 0,
            });
            return;
          }

          const errWithMeta = error as NodeJS.ErrnoException & {
            code?: string | number | null;
            signal?: string | null;
          };
          const code = typeof errWithMeta.code === "string" ? errWithMeta.code : undefined;
          const exitCode = typeof errWithMeta.code === "number" ? errWithMeta.code : 1;

          resolve({
            ok: false,
            stdout: normalizeText(stdout),
            stderr: normalizeText(stderr) || normalizeText(error.message),
            exitCode,
            errorCode: code,
          });
        },
      );
    });
  };
}
