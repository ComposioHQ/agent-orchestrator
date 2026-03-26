export type ArrowDirection = "up" | "down" | "left" | "right";

export function escSeq(): string {
  return "\x1b";
}

export function tabSeq(): string {
  return "\t";
}

export function arrowSeq(dir: ArrowDirection): string {
  if (dir === "up") return "\x1b[A";
  if (dir === "down") return "\x1b[B";
  if (dir === "right") return "\x1b[C";
  return "\x1b[D";
}

export function pgUpSeq(): string {
  return "\x1b[5~";
}

export function pgDnSeq(): string {
  return "\x1b[6~";
}

export function ctrlChar(char: string): string {
  if (char.length === 0) return "";
  const code = char.toUpperCase().charCodeAt(0);
  if (code < 64 || code > 95) return char;
  return String.fromCharCode(code - 64);
}
