import chalk from "chalk";
import { confirm, isCancel, select, type Option } from "@clack/prompts";

type SelectOption<T extends string> = Option<T>;

export async function promptConfirm(message: string, initialValue = true): Promise<boolean> {
  const result = await confirm({ message, initialValue });
  if (isCancel(result)) {
    console.log(chalk.yellow("\nCancelled."));
    process.exit(0);
  }
  return result;
}

export async function promptSelect<T extends string>(
  message: string,
  options: SelectOption<T>[],
  initialValue?: T,
): Promise<T> {
  const result = await select({
    message,
    options,
    ...(initialValue !== undefined ? { initialValue } : {}),
  });
  if (isCancel(result)) {
    console.log(chalk.yellow("\nRequest Cancelled."));
    process.exit(0);
  }
  return result;
}
