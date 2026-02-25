import { z, type ZodIssue } from "zod";
import type { AcceptanceContract, TaskNode, WorkPlan } from "./types.js";

export interface WorkPlanValidationIssue {
  path: string;
  message: string;
}

export class WorkPlanValidationError extends Error {
  constructor(public readonly issues: WorkPlanValidationIssue[]) {
    super(
      `WorkPlan validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n` +
        issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"),
    );
    this.name = "WorkPlanValidationError";
  }
}

const TaskPrioritySchema = z.enum(["critical", "high", "medium", "low"]);

const AcceptanceCheckSchema = z
  .object({
    id: z.string().min(1, "acceptance check id cannot be empty"),
    description: z.string().min(1, "acceptance check description cannot be empty"),
    verification: z.string().min(1, "acceptance check verification cannot be empty"),
    required: z.boolean(),
  })
  .strict();

export const AcceptanceContractSchema: z.ZodType<AcceptanceContract> = z
  .object({
    definitionOfDone: z.string().min(1, "acceptance.definitionOfDone cannot be empty"),
    checks: z.array(AcceptanceCheckSchema).min(1, "acceptance.checks must contain at least one check"),
  })
  .strict();

export const TaskNodeSchema: z.ZodType<TaskNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1, "task id cannot be empty"),
      title: z.string().min(1, "task title cannot be empty"),
      description: z.string().min(1, "task description cannot be empty"),
      priority: TaskPrioritySchema,
      dependencies: z.array(z.string().min(1, "dependency id cannot be empty")),
      risks: z.array(z.string().min(1, "risk entries cannot be empty")),
      acceptanceChecks: z.array(z.string().min(1, "acceptance check id cannot be empty")),
      subtasks: z.array(TaskNodeSchema).optional(),
    })
    .strict(),
);

export const WorkPlanSchema: z.ZodType<WorkPlan> = z
  .object({
    schemaVersion: z.literal("1.0"),
    goal: z.string().min(1, "goal cannot be empty"),
    assumptions: z.array(z.string().min(1, "assumption entries cannot be empty")).optional(),
    tasks: z.array(TaskNodeSchema).min(1, "tasks must contain at least one task"),
    acceptance: AcceptanceContractSchema,
  })
  .strict();

interface FlattenedTask {
  task: TaskNode;
  path: string;
}

function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return "(root)";

  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }

    formatted += formatted.length === 0 ? segment : `.${segment}`;
  }

  return formatted;
}

function issueFromZod(issue: ZodIssue): WorkPlanValidationIssue {
  const path = formatPath(issue.path);

  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return { path, message: "is required" };
  }

  return { path, message: issue.message };
}

function flattenTasks(tasks: TaskNode[], parentPath = "tasks"): FlattenedTask[] {
  const flattened: FlattenedTask[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    const path = `${parentPath}[${i}]`;
    if (!task) continue;
    flattened.push({ task, path });

    if (task.subtasks) {
      flattened.push(...flattenTasks(task.subtasks, `${path}.subtasks`));
    }
  }

  return flattened;
}

function validateReferentialIntegrity(plan: WorkPlan): WorkPlanValidationIssue[] {
  const issues: WorkPlanValidationIssue[] = [];

  const acceptanceIdToPath = new Map<string, string>();
  for (let i = 0; i < plan.acceptance.checks.length; i += 1) {
    const check = plan.acceptance.checks[i];
    const path = `acceptance.checks[${i}].id`;
    if (!check) continue;

    if (acceptanceIdToPath.has(check.id)) {
      issues.push({
        path,
        message: `duplicate acceptance check id "${check.id}" (first declared at ${acceptanceIdToPath.get(check.id)})`,
      });
      continue;
    }

    acceptanceIdToPath.set(check.id, path);
  }

  const tasks = flattenTasks(plan.tasks);
  const taskIdToPath = new Map<string, string>();

  for (const { task, path } of tasks) {
    const idPath = `${path}.id`;
    if (taskIdToPath.has(task.id)) {
      issues.push({
        path: idPath,
        message: `duplicate task id "${task.id}" (first declared at ${taskIdToPath.get(task.id)})`,
      });
      continue;
    }

    taskIdToPath.set(task.id, idPath);
  }

  const knownTaskIds = Array.from(taskIdToPath.keys()).sort();
  const knownChecks = Array.from(acceptanceIdToPath.keys()).sort();

  for (const { task, path } of tasks) {
    const seenDeps = new Set<string>();
    for (let i = 0; i < task.dependencies.length; i += 1) {
      const depId = task.dependencies[i];
      const depPath = `${path}.dependencies[${i}]`;
      if (!depId) continue;

      if (seenDeps.has(depId)) {
        issues.push({
          path: depPath,
          message: `duplicate dependency "${depId}" in the same task`,
        });
        continue;
      }
      seenDeps.add(depId);

      if (depId === task.id) {
        issues.push({
          path: depPath,
          message: `task "${task.id}" cannot depend on itself`,
        });
        continue;
      }

      if (!taskIdToPath.has(depId)) {
        issues.push({
          path: depPath,
          message: `unknown task dependency "${depId}". Known task IDs: ${knownTaskIds.join(", ") || "(none)"}`,
        });
      }
    }

    const seenChecks = new Set<string>();
    for (let i = 0; i < task.acceptanceChecks.length; i += 1) {
      const checkId = task.acceptanceChecks[i];
      const checkPath = `${path}.acceptanceChecks[${i}]`;
      if (!checkId) continue;

      if (seenChecks.has(checkId)) {
        issues.push({
          path: checkPath,
          message: `duplicate acceptance check reference "${checkId}" in the same task`,
        });
        continue;
      }
      seenChecks.add(checkId);

      if (!acceptanceIdToPath.has(checkId)) {
        issues.push({
          path: checkPath,
          message: `unknown acceptance check "${checkId}". Known checks: ${knownChecks.join(", ") || "(none)"}`,
        });
      }
    }
  }

  return issues;
}

export function validateWorkPlan(raw: unknown): WorkPlan {
  const parsed = WorkPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkPlanValidationError(parsed.error.issues.map(issueFromZod));
  }

  const referentialIssues = validateReferentialIntegrity(parsed.data);
  if (referentialIssues.length > 0) {
    throw new WorkPlanValidationError(referentialIssues);
  }

  return parsed.data;
}
