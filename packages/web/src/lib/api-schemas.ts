import { z } from "zod";

/** POST /api/projects — register a new project */
export const RegisterProjectSchema = z.object({
  path: z.string().min(1, "Path is required"),
  name: z.string().optional(),
  configProjectKey: z.string().optional(),
});
export type RegisterProjectInput = z.infer<typeof RegisterProjectSchema>;

/** POST /api/projects/clone — clone and register a project */
export const CloneProjectSchema = z.object({
  url: z.string().url("A valid Git URL is required"),
  location: z.string().min(1, "Location is required"),
});
export type CloneProjectInput = z.infer<typeof CloneProjectSchema>;

/** PUT /api/projects/[id] — update project preferences */
export const UpdateProjectPrefsSchema = z.object({
  pinned: z.boolean().optional(),
  enabled: z.boolean().optional(),
  displayName: z.string().optional(),
});
export type UpdateProjectPrefsInput = z.infer<typeof UpdateProjectPrefsSchema>;

/** PATCH /api/projects/[id] — update project behavior (not identity/preferences) */
export const UpdateProjectBehaviorSchema = z.object({
  repo: z.string().optional(),
  defaultBranch: z.string().optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  tracker: z.record(z.unknown()).optional(),
  scm: z.record(z.unknown()).optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  agentConfig: z.record(z.unknown()).optional(),
  orchestrator: z.record(z.unknown()).optional(),
  worker: z.record(z.unknown()).optional(),
  reactions: z.record(z.record(z.unknown())).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  orchestratorRules: z.string().optional(),
  orchestratorSessionStrategy: z
    .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
    .optional(),
  opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
  decomposer: z.record(z.unknown()).optional(),
});
export type UpdateProjectBehaviorInput = z.infer<typeof UpdateProjectBehaviorSchema>;

/** PUT /api/settings/preferences — update portfolio preferences */
export const UpdatePreferencesSchema = z.object({
  projectOrder: z.array(z.string()).optional(),
  defaultProject: z.string().optional(),
});
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesSchema>;
