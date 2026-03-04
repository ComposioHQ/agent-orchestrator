import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

export const manifest = {
  name: "e2b",
  slot: "runtime" as const,
  description: "Runtime plugin: E2B cloud sandboxes",
  version: "0.1.0",
};

const E2B_SETUP_MESSAGE =
  "E2B runtime requires the 'e2b' npm package and an E2B_API_KEY environment variable.\n\n" +
  "To set up E2B:\n" +
  "  1. Install the SDK: pnpm add e2b\n" +
  "  2. Sign up at https://e2b.dev and get an API key\n" +
  "  3. Set E2B_API_KEY in your environment or agent-orchestrator.yaml\n\n" +
  "See https://e2b.dev/docs for full documentation.";

function throwNotConfigured(method: string): never {
  throw new Error(
    `[runtime-e2b] ${method}() failed: ${E2B_SETUP_MESSAGE}`,
  );
}

export function create(): Runtime {
  return {
    name: "e2b",

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
