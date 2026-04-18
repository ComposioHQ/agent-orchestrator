const PROJECT_COLOR_COUNT = 6;

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getProjectColorIndex(projectId: string): number {
  return (fnv1a(projectId) % PROJECT_COLOR_COUNT) + 1;
}

export function getProjectColorVar(projectId: string): string {
  return `var(--color-project-${getProjectColorIndex(projectId)})`;
}
