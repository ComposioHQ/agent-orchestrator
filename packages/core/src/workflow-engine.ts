import { parse as parseYaml } from "yaml";

export type WorkflowTransition = string | "COMPLETE" | "ABORT";

export interface WorkflowRule {
  condition: string;
  next: WorkflowTransition;
}

export interface WorkflowMovement {
  name: string;
  persona?: string;
  edit?: boolean;
  rules: WorkflowRule[];
}

export interface WorkflowPiece {
  name: string;
  initial_movement: string;
  max_movements?: number;
  loop_threshold?: number;
  movements: WorkflowMovement[];
}

export interface WorkflowRunState {
  readonly history: string[];
  readonly transitions: Array<{ from: string; to: WorkflowTransition; condition: string }>;
}

export interface WorkflowMovementResult {
  matchedCondition?: string;
}

export interface WorkflowRunnerDeps {
  executeMovement: (
    movement: WorkflowMovement,
    state: WorkflowRunState,
  ) => Promise<WorkflowMovementResult> | WorkflowMovementResult;
  evaluateCondition?: (
    condition: string,
    movement: WorkflowMovement,
    state: WorkflowRunState,
  ) => Promise<boolean> | boolean;
}

export interface WorkflowRunResult {
  status: "complete" | "aborted" | "max_movements_exceeded";
  finalMovement: string;
  history: string[];
}

function assertPiece(piece: WorkflowPiece): void {
  if (!piece.name) throw new Error("Workflow piece must have a name");
  if (!piece.initial_movement) throw new Error("Workflow piece must define initial_movement");
  if (!Array.isArray(piece.movements) || piece.movements.length === 0) {
    throw new Error("Workflow piece must define at least one movement");
  }
  const names = new Set<string>();
  for (const movement of piece.movements) {
    if (!movement.name) throw new Error("Workflow movement is missing name");
    if (names.has(movement.name)) throw new Error(`Duplicate movement name: ${movement.name}`);
    names.add(movement.name);
    if (!Array.isArray(movement.rules)) {
      throw new Error(`Movement '${movement.name}' must define rules`);
    }
  }
  if (!names.has(piece.initial_movement)) {
    throw new Error(`initial_movement '${piece.initial_movement}' not found in movements`);
  }
}

function findMovement(piece: WorkflowPiece, name: string): WorkflowMovement {
  const movement = piece.movements.find((m) => m.name === name);
  if (!movement) throw new Error(`Unknown movement '${name}'`);
  return movement;
}

export class WorkflowEngine {
  constructor(private readonly piece: WorkflowPiece) {
    assertPiece(piece);
  }

  async run(deps: WorkflowRunnerDeps): Promise<WorkflowRunResult> {
    const maxMovements = this.piece.max_movements ?? 10;
    const loopThreshold = this.piece.loop_threshold ?? 10;
    const history: string[] = [];
    const transitions: Array<{ from: string; to: WorkflowTransition; condition: string }> = [];
    let current = this.piece.initial_movement;
    let consecutiveSameMovement = 0;

    for (let i = 0; i < maxMovements; i++) {
      const movement = findMovement(this.piece, current);
      history.push(movement.name);

      if (history.length >= 2 && history[history.length - 2] === movement.name) {
        consecutiveSameMovement += 1;
      } else {
        consecutiveSameMovement = 1;
      }
      if (consecutiveSameMovement > loopThreshold) {
        return {
          status: "aborted",
          finalMovement: movement.name,
          history,
        };
      }

      const state: WorkflowRunState = { history, transitions };
      const movementResult = await deps.executeMovement(movement, state);

      let nextTransition: WorkflowTransition | null = null;
      let matchedCondition = "";

      for (const rule of movement.rules) {
        if (movementResult.matchedCondition && movementResult.matchedCondition === rule.condition) {
          nextTransition = rule.next;
          matchedCondition = rule.condition;
          break;
        }

        if (deps.evaluateCondition) {
          const matched = await deps.evaluateCondition(rule.condition, movement, state);
          if (matched) {
            nextTransition = rule.next;
            matchedCondition = rule.condition;
            break;
          }
        }
      }

      if (!nextTransition) {
        throw new Error(`No rule matched for movement '${movement.name}'`);
      }

      transitions.push({ from: movement.name, to: nextTransition, condition: matchedCondition });

      if (nextTransition === "COMPLETE") {
        return {
          status: "complete",
          finalMovement: movement.name,
          history,
        };
      }
      if (nextTransition === "ABORT") {
        return {
          status: "aborted",
          finalMovement: movement.name,
          history,
        };
      }

      current = nextTransition;
    }

    return {
      status: "max_movements_exceeded",
      finalMovement: history[history.length - 1] ?? this.piece.initial_movement,
      history,
    };
  }
}

export function parseWorkflowPieceYaml(yamlText: string): WorkflowPiece {
  const parsed = parseYaml(yamlText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid workflow YAML");
  }
  return parsed as WorkflowPiece;
}

