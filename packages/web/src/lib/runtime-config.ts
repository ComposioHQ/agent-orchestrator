export interface RuntimeConfig {
  terminalPort: string;
  directTerminalPort: string;
}

let runtimeConfigPromise: Promise<RuntimeConfig> | null = null;

export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = fetch("/api/runtime", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as Partial<RuntimeConfig>;
        return {
          terminalPort: data.terminalPort ?? "14800",
          directTerminalPort: data.directTerminalPort ?? "14801",
        };
      })
      .catch((error) => {
        runtimeConfigPromise = null;
        throw error;
      });
  }

  return runtimeConfigPromise;
}
