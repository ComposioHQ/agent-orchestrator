export interface DecomposerNode<TStatus extends string = string> {
  id?: string;
  title?: string;
  status?: TStatus;
  children?: DecomposerNode<TStatus>[];
}

export interface DecomposerConfig {
  maxDepth?: number;
}

export const DEFAULT_DECOMPOSER_CONFIG: Readonly<Required<DecomposerConfig>> = {
  maxDepth: 8,
};

export function decompose<TNode extends DecomposerNode>(
  plan: TNode,
  _config: DecomposerConfig = DEFAULT_DECOMPOSER_CONFIG,
): TNode {
  return plan;
}

export function getLeaves<TNode extends DecomposerNode>(plan: TNode): TNode[] {
  const children = plan.children ?? [];
  if (children.length === 0) {
    return [plan];
  }

  return children.flatMap((child) => getLeaves(child as TNode));
}

function findParent<TNode extends DecomposerNode>(
  plan: TNode,
  targetId: string,
): { parent: TNode | null; node: TNode | null } {
  if (plan.id === targetId) {
    return { parent: null, node: plan };
  }

  for (const child of plan.children ?? []) {
    if (child.id === targetId) {
      return { parent: plan, node: child as TNode };
    }

    const nested = findParent(child as TNode, targetId);
    if (nested.node) {
      return nested.parent ? nested : { parent: plan, node: nested.node };
    }
  }

  return { parent: null, node: null };
}

export function getSiblings<TNode extends DecomposerNode>(plan: TNode, targetId: string): TNode[] {
  const { parent, node } = findParent(plan, targetId);
  if (!parent || !node) {
    return [];
  }

  return (parent.children ?? []).filter((child) => child !== node) as TNode[];
}

function formatNodeLabel(node: DecomposerNode, prefix = ""): string[] {
  const label = node.title ?? node.id ?? "untitled";
  const suffix = node.status ? ` [${node.status}]` : "";
  const lines = [`${prefix}${label}${suffix}`];
  const children = node.children ?? [];

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const branch = index === children.length - 1 ? "└─ " : "├─ ";
    const childPrefix = prefix + (index === children.length - 1 ? "   " : "│  ");
    lines.push(...formatNodeLabel(child, `${prefix}${branch}`).map((line, lineIndex) => {
      if (lineIndex === 0) return line;
      return `${childPrefix}${line.slice((`${prefix}${branch}`).length)}`;
    }));
  }

  return lines;
}

export function formatPlanTree(plan: DecomposerNode): string {
  return formatNodeLabel(plan).join("\n");
}

function findLineage<TNode extends DecomposerNode>(plan: TNode, targetId: string): TNode[] {
  if (plan.id === targetId) {
    return [plan];
  }

  for (const child of plan.children ?? []) {
    const lineage = findLineage(child as TNode, targetId);
    if (lineage.length > 0) {
      return [plan, ...lineage];
    }
  }

  return [];
}

export function formatLineage<TNode extends DecomposerNode>(plan: TNode, targetId: string): string {
  return findLineage(plan, targetId)
    .map((node) => node.title ?? node.id ?? "untitled")
    .join(" > ");
}

export function propagateStatus<TNode extends DecomposerNode>(plan: TNode): TNode {
  const children = (plan.children ?? []).map((child) => propagateStatus(child as TNode));
  if (children.length === 0) {
    return {
      ...plan,
      ...(children.length > 0 ? { children } : {}),
    };
  }

  const childStatuses = children
    .map((child) => child.status)
    .filter((status): status is string => typeof status === "string" && status.length > 0);
  const nextStatus =
    childStatuses.length === 0
      ? plan.status
      : childStatuses.every((status) => status === childStatuses[0])
        ? childStatuses[0]
        : "mixed";

  return {
    ...plan,
    children,
    ...(nextStatus ? { status: nextStatus as TNode["status"] } : {}),
  };
}
