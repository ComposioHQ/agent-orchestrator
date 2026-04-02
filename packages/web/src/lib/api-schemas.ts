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

/** PUT /api/settings/preferences — update portfolio preferences */
export const UpdatePreferencesSchema = z.object({
  projectOrder: z.array(z.string()).optional(),
  defaultProject: z.string().optional(),
});
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesSchema>;
