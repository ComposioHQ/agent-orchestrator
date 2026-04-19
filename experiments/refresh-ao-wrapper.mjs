import { setupPathWrapperWorkspace } from "../packages/core/dist/index.js";

await setupPathWrapperWorkspace(process.cwd());
console.log("wrapper refreshed");
