export interface CloudSessionOperationOptions<T> {
  organizationId: string;
  sessionId: string;
  key: string;
  run: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  coalesce?: boolean;
}

interface Consumer {
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
  signal?: AbortSignal;
  settled: boolean;
}

interface Operation {
  controller: AbortController;
  consumers: Set<Consumer>;
  key: string;
  run: (signal: AbortSignal) => Promise<unknown>;
}

class SessionOperationQueue {
  private active: Operation | null = null;
  private readonly coalesced = new Map<string, Operation>();
  private readonly pending: Operation[] = [];

  schedule<T>({
    key,
    run,
    signal,
    coalesce = true,
  }: Omit<CloudSessionOperationOptions<T>, "organizationId" | "sessionId">): Promise<T> {
    let operation = coalesce ? this.coalesced.get(key) : undefined;
    if (!operation) {
      operation = {
        controller: new AbortController(),
        consumers: new Set(),
        key,
        run,
      };
      this.pending.push(operation);
      if (coalesce) this.coalesced.set(key, operation);
    }

    const result = this.attach<T>(operation, signal);
    this.startNext();
    return result;
  }

  clear() {
    this.active?.controller.abort();
    for (const operation of this.pending) operation.controller.abort();
    this.active = null;
    this.pending.length = 0;
    this.coalesced.clear();
  }

  private attach<T>(operation: Operation, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const consumer: Consumer = {
        reject,
        resolve: (value) => resolve(value as T),
        signal,
        settled: false,
      };
      const cancel = () => {
        if (consumer.settled) return;
        consumer.settled = true;
        operation.consumers.delete(consumer);
        reject(abortError());
        if (operation.consumers.size === 0) this.cancel(operation);
      };

      if (signal?.aborted) {
        cancel();
        return;
      }
      operation.consumers.add(consumer);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  private cancel(operation: Operation) {
    if (this.active === operation) {
      operation.controller.abort();
      return;
    }
    const index = this.pending.indexOf(operation);
    if (index >= 0) this.pending.splice(index, 1);
    if (this.coalesced.get(operation.key) === operation) {
      this.coalesced.delete(operation.key);
    }
    operation.controller.abort();
  }

  private startNext() {
    if (this.active) return;
    const operation = this.pending.shift();
    if (!operation) return;
    this.active = operation;
    void this.run(operation);
  }

  private async run(operation: Operation) {
    try {
      const value = await operation.run(operation.controller.signal);
      for (const consumer of operation.consumers) {
        if (!consumer.settled) {
          consumer.settled = true;
          consumer.resolve(value);
        }
      }
    } catch (error) {
      for (const consumer of operation.consumers) {
        if (!consumer.settled) {
          consumer.settled = true;
          consumer.reject(error);
        }
      }
    } finally {
      operation.consumers.clear();
      if (this.coalesced.get(operation.key) === operation) {
        this.coalesced.delete(operation.key);
      }
      if (this.active === operation) this.active = null;
      this.startNext();
    }
  }
}

const queues = new Map<string, SessionOperationQueue>();

// Worker transport has a small durable request budget. Serializing work at this
// boundary keeps independent panels from racing the same session, while still
// allowing different sessions to progress independently.
export function scheduleCloudSessionOperation<T>(
  options: CloudSessionOperationOptions<T>,
): Promise<T> {
  const key = `${options.organizationId}:${options.sessionId}`;
  let queue = queues.get(key);
  if (!queue) {
    queue = new SessionOperationQueue();
    queues.set(key, queue);
  }
  return queue.schedule(options);
}

export function clearCloudSessionOperations() {
  for (const queue of queues.values()) queue.clear();
  queues.clear();
}

function abortError() {
  const error = new Error("Cloud session operation was cancelled.");
  error.name = "AbortError";
  return error;
}
