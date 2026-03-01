import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

export const manifest = {
  name: "daytona",
  slot: "runtime" as const,
  description: "Runtime plugin: Daytona cloud workspaces",
  version: "0.1.0",
};

const DAYTONA_SETUP_MESSAGE =
  "Daytona runtime requires the '@daytonaio/sdk' npm package and a Daytona API key.\n\n" +
  "To set up Daytona:\n" +
  "  1. Install the SDK: pnpm add @daytonaio/sdk\n" +
  "  2. Sign up at https://daytona.io and get an API key\n" +
  "  3. Set DAYTONA_API_KEY in your environment or agent-orchestrator.yaml\n\n" +
  "See https://daytona.io/docs for full documentation.";

function throwNotConfigured(method: string): never {
  throw new Error(
    `[runtime-daytona] ${method}() failed: ${DAYTONA_SETUP_MESSAGE}`,
  );
}

export function create(): Runtime {
  return {
    name: "daytona",

    async create(_config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      throwNotConfigured("create");
    },

    async destroy(_handle: RuntimeHandle): Promise<void> {
      throwNotConfigured("destroy");
    },

    async sendMessage(_handle: RuntimeHandle, _message: string): Promise<void> {
      throwNotConfigured("sendMessage");
    },

    async getOutput(_handle: RuntimeHandle, _lines?: number): Promise<string> {
      throwNotConfigured("getOutput");
    },

    async isAlive(_handle: RuntimeHandle): Promise<boolean> {
      throwNotConfigured("isAlive");
    },

    async getMetrics(_handle: RuntimeHandle): Promise<RuntimeMetrics> {
      throwNotConfigured("getMetrics");
    },

    async getAttachInfo(_handle: RuntimeHandle): Promise<AttachInfo> {
      throwNotConfigured("getAttachInfo");
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
