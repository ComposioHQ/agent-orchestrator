import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

export const manifest = {
  name: "modal",
  slot: "runtime" as const,
  description: "Runtime plugin: Modal cloud compute",
  version: "0.1.0",
};

const MODAL_SETUP_MESSAGE =
  "Modal runtime requires the 'modal' Python package and a Modal account.\n\n" +
  "To set up Modal:\n" +
  "  1. Install the Modal CLI: pip install modal\n" +
  "  2. Authenticate: modal token new\n" +
  "  3. Sign up at https://modal.com if you don't have an account\n" +
  "  4. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in your environment\n\n" +
  "See https://modal.com/docs for full documentation.";

function throwNotConfigured(method: string): never {
  throw new Error(
    `[runtime-modal] ${method}() failed: ${MODAL_SETUP_MESSAGE}`,
  );
}

export function create(): Runtime {
  return {
    name: "modal",

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
