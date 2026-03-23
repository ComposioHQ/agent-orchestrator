import { cache } from "react";
import { loadConfig } from "@composio/ao-core";

export interface ColumnConfig {
  label: string;
  statuses?: string[];
}

export interface ProjectInfo {
  id: string;
  name: string;
  /** Labels used to filter backlog issues for this project (from tracker.trigger.labels) */
  triggerLabels?: string[];
  /** Default assignee to pre-filter backlog issues (from tracker.trigger.assignee) */
  triggerAssignee?: string;
  /** Column definitions for the backlog task view (from tracker.columns) */
  columns?: ColumnConfig[];
}

export const getProjectName = cache((): string => {
  try {
    const config = loadConfig();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) {
      const name = config.projects[firstKey].name ?? firstKey;
      return name || firstKey || "ao";
    }
  } catch {
    // Config not available
  }
  return "ao";
});

export const getPrimaryProjectId = cache((): string => {
  try {
    const config = loadConfig();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) return firstKey;
  } catch {
    // Config not available
  }
  return "ao";
});

export const getAllProjects = cache((): ProjectInfo[] => {
  try {
    const config = loadConfig();
    return Object.entries(config.projects).map(([id, project]) => {
      const tracker = project.tracker as
        | {
            trigger?: { labels?: string[]; assignee?: string };
            columns?: ColumnConfig[];
          }
        | undefined;
      return {
        id,
        name: project.name ?? id,
        triggerLabels: tracker?.trigger?.labels,
        triggerAssignee: tracker?.trigger?.assignee,
        columns: tracker?.columns,
      };
    });
  } catch {
    return [];
  }
});
