import chalk from "chalk";
import { confirm, isCancel } from "@clack/prompts";

export async function promptConfirm(message: string, initialValue = true): Promise<boolean> {
  const result = await confirm({ message, initialValue });
  if (isCancel(result)) {
    console.log(chalk.yellow("\nCancelled."));
    process.exit(0);
  }
  return result;
}
