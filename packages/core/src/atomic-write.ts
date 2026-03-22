import { renameSync, writeFileSync } from "node:fs";

/**
 * Atomically write a file by writing to a temp file then renaming.
 * rename() is atomic on POSIX, so concurrent writers never produce torn data.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}
