/**
 * Plan Validator — validates plan.json against the schema and team config.
 *
 * Checks:
 *   1. Schema validation (required fields, correct types)
 *   2. File scope exclusivity (no file in multiple work_units)
 *   3. shared_files absent from all work_units.files
 *   4. integrate_order completeness
 *   5. assigned_to references valid agent names
 */

import type {
  Plan,
  PlanValidationResult,
  PlanValidationError,
  TeamDefinition,
} from "@composio/ao-core";

/** Validate a plan against the schema and team configuration */
export function validatePlan(plan: Plan, team: TeamDefinition): PlanValidationResult {
  const errors: PlanValidationError[] = [];

  // 1. Schema validation
  if (!plan.summary || typeof plan.summary !== "string") {
    errors.push({ field: "summary", message: "Plan must have a non-empty summary string" });
  }

  if (!Array.isArray(plan.workUnits)) {
    errors.push({ field: "workUnits", message: "Plan must have a workUnits array" });
    return { valid: false, errors };
  }

  if (plan.workUnits.length === 0) {
    errors.push({ field: "workUnits", message: "Plan must have at least one work unit" });
  }

  if (!Array.isArray(plan.sharedFiles)) {
    errors.push({ field: "sharedFiles", message: "Plan must have a sharedFiles array" });
  }

  if (!Array.isArray(plan.integrateOrder)) {
    errors.push({ field: "integrateOrder", message: "Plan must have an integrateOrder array" });
  }

  // Validate each work unit
  for (let i = 0; i < plan.workUnits.length; i++) {
    const wu = plan.workUnits[i];

    if (!wu.id) {
      errors.push({ field: `workUnits[${i}].id`, message: "Work unit must have an id" });
    }
    if (!wu.description) {
      errors.push({
        field: `workUnits[${i}].description`,
        message: "Work unit must have a description",
      });
    }
    if (!wu.assignedTo) {
      errors.push({
        field: `workUnits[${i}].assignedTo`,
        message: "Work unit must have an assignedTo field",
      });
    }
    if (!Array.isArray(wu.files) || wu.files.length === 0) {
      errors.push({
        field: `workUnits[${i}].files`,
        message: "Work unit must have a non-empty files array",
      });
    }
    if (!wu.criteria) {
      errors.push({
        field: `workUnits[${i}].criteria`,
        message: "Work unit must have acceptance criteria",
      });
    }
  }

  // 2. File scope exclusivity
  const fileToUnit = new Map<string, string>();
  for (const wu of plan.workUnits) {
    if (!Array.isArray(wu.files)) continue;
    for (const file of wu.files) {
      const existing = fileToUnit.get(file);
      if (existing) {
        errors.push({
          field: "workUnits.files",
          message: `File "${file}" appears in both work unit "${existing}" and "${wu.id}" — each file must be in exactly one work unit`,
        });
      } else {
        fileToUnit.set(file, wu.id);
      }
    }
  }

  // 3. shared_files must not appear in any work unit's files
  if (Array.isArray(plan.sharedFiles)) {
    for (const shared of plan.sharedFiles) {
      const unit = fileToUnit.get(shared);
      if (unit) {
        errors.push({
          field: "sharedFiles",
          message: `Shared file "${shared}" also appears in work unit "${unit}" — shared files must not be in any work unit's files array`,
        });
      }
    }
  }

  // 4. integrate_order completeness
  if (Array.isArray(plan.integrateOrder)) {
    const assignedAgents = new Set(plan.workUnits.map((wu) => wu.assignedTo));
    for (const agent of assignedAgents) {
      if (!plan.integrateOrder.includes(agent)) {
        errors.push({
          field: "integrateOrder",
          message: `Agent "${agent}" is assigned work units but missing from integrateOrder`,
        });
      }
    }
    for (const agent of plan.integrateOrder) {
      if (!assignedAgents.has(agent)) {
        errors.push({
          field: "integrateOrder",
          message: `Agent "${agent}" is in integrateOrder but has no assigned work units`,
        });
      }
    }
  }

  // 5. assigned_to references valid agent names from team config
  const validAgentNames = new Set(Object.keys(team.agents));
  for (const wu of plan.workUnits) {
    if (wu.assignedTo && !validAgentNames.has(wu.assignedTo)) {
      errors.push({
        field: `workUnits.assignedTo`,
        message: `Work unit "${wu.id}" is assigned to "${wu.assignedTo}" which is not a valid agent in the team config. Valid agents: ${[...validAgentNames].join(", ")}`,
      });
    }
  }

  // Check for duplicate work unit IDs
  const seenIds = new Set<string>();
  for (const wu of plan.workUnits) {
    if (wu.id && seenIds.has(wu.id)) {
      errors.push({
        field: "workUnits.id",
        message: `Duplicate work unit ID: "${wu.id}"`,
      });
    }
    if (wu.id) seenIds.add(wu.id);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
