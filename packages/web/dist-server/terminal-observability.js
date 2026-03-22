import { createProjectObserver, loadConfig, resolveProjectIdForSessionId, } from "@composio/ao-core";
export function createObserverContext(surface) {
    try {
        const config = loadConfig();
        return {
            config,
            observer: createProjectObserver(config, surface),
        };
    }
    catch {
        return { config: undefined, observer: undefined };
    }
}
export function inferProjectId(config, sessionId) {
    return config ? resolveProjectIdForSessionId(config, sessionId) : undefined;
}
