export interface DispatchTask {
  id: string;
  assignedWorkerId?: string;
}

export interface DispatchWorker {
  id: string;
  busy: boolean;
}

export interface DispatchDaemonStore {
  listPendingTasks(): Promise<DispatchTask[]>;
  listWorkers(): Promise<DispatchWorker[]>;
  assignTask(taskId: string, workerId: string): Promise<void>;
}

export interface DispatchDaemonOptions {
  pollIntervalMs?: number;
}

export class DispatchDaemon {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly store: DispatchDaemonStore,
    private readonly options: DispatchDaemonOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.pollIntervalMs ?? 1000;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const [tasks, workers] = await Promise.all([
        this.store.listPendingTasks(),
        this.store.listWorkers(),
      ]);
      const idleWorkers = workers.filter((worker) => !worker.busy);
      if (idleWorkers.length === 0 || tasks.length === 0) return;

      const assignmentCount = Math.min(idleWorkers.length, tasks.length);
      for (let i = 0; i < assignmentCount; i++) {
        await this.store.assignTask(tasks[i].id, idleWorkers[i].id);
      }
    } finally {
      this.polling = false;
    }
  }
}

