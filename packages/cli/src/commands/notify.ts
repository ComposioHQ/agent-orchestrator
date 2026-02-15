import chalk from "chalk";
import type { Command } from "commander";
import {
  type OrchestratorConfig,
  type OrchestratorEvent,
  type Notifier,
  type EventPriority,
  type NotifierConfig,
  loadConfig,
} from "@composio/ao-core";
import { getNotifier } from "../lib/plugins.js";
import { banner } from "../lib/format.js";

const VALID_PRIORITIES: EventPriority[] = ["urgent", "action", "warning", "info"];

function makeTestEvent(priority: EventPriority): OrchestratorEvent {
  return {
    id: `test-${Date.now()}`,
    type: "session.working",
    priority,
    sessionId: "test-session",
    projectId: "test-project",
    timestamp: new Date(),
    message: `This is a test notification from Agent Orchestrator (priority: ${priority})`,
    data: {},
  };
}

async function testNotifier(
  name: string,
  notifier: Notifier,
  priority: EventPriority,
): Promise<{ name: string; success: boolean; error?: string }> {
  try {
    const event = makeTestEvent(priority);
    await notifier.notify(event);
    return { name, success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, success: false, error: message };
  }
}

function resolveNotifierNames(
  config: OrchestratorConfig,
  filterName?: string,
): string[] {
  if (filterName) {
    // User specified a single notifier to test
    if (!config.notifiers[filterName]) {
      throw new Error(
        `Unknown notifier: "${filterName}". Configured notifiers: ${Object.keys(config.notifiers).join(", ") || "(none)"}`,
      );
    }
    return [filterName];
  }

  // Collect all unique notifier names from routing + defaults
  const names = new Set<string>();
  for (const notifierList of Object.values(config.notificationRouting)) {
    for (const n of notifierList) {
      names.add(n);
    }
  }
  for (const n of config.defaults.notifiers) {
    names.add(n);
  }

  // Fall back to all configured notifiers if routing/defaults are empty
  if (names.size === 0) {
    for (const n of Object.keys(config.notifiers)) {
      names.add(n);
    }
  }

  return [...names];
}

function createNotifier(
  name: string,
  notifierConfig: NotifierConfig,
): Notifier {
  const pluginName = notifierConfig.plugin;
  const pluginModule = getNotifier(pluginName);
  // Pass the full notifier config (minus `plugin` key) to the plugin's create()
  const { plugin: _, ...rest } = notifierConfig;
  return pluginModule.create(rest);
}

export function registerNotify(program: Command): void {
  const notify = program
    .command("notify")
    .description("Notification management commands");

  notify
    .command("test")
    .description("Send a test notification to verify notifier configuration")
    .option("-n, --notifier <name>", "Test a specific notifier (by config name)")
    .option(
      "-p, --priority <level>",
      "Priority level for the test event (urgent, action, warning, info)",
      "action",
    )
    .action(async (opts: { notifier?: string; priority?: string }) => {
      const priority = (opts.priority ?? "action") as EventPriority;
      if (!VALID_PRIORITIES.includes(priority)) {
        console.error(
          chalk.red(
            `Invalid priority: "${opts.priority}". Must be one of: ${VALID_PRIORITIES.join(", ")}`,
          ),
        );
        process.exit(1);
      }

      let config: OrchestratorConfig;
      try {
        config = loadConfig();
      } catch {
        console.error(chalk.red("No config found. Run `ao init` first."));
        process.exit(1);
      }

      let notifierNames: string[];
      try {
        notifierNames = resolveNotifierNames(config, opts.notifier);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(message));
        process.exit(1);
      }

      if (notifierNames.length === 0) {
        console.log(
          chalk.yellow("No notifiers configured. Add notifiers to agent-orchestrator.yaml."),
        );
        return;
      }

      console.log(banner("NOTIFY TEST"));
      console.log();
      console.log(
        chalk.dim(`  Sending test notification (priority: ${priority}) to ${notifierNames.length} notifier${notifierNames.length !== 1 ? "s" : ""}...`),
      );
      console.log();

      let allPassed = true;

      for (const name of notifierNames) {
        const notifierConfig = config.notifiers[name];
        if (!notifierConfig) {
          console.log(`  ${chalk.yellow("skip")}  ${name} — no config in notifiers section`);
          continue;
        }

        let notifier: Notifier;
        try {
          notifier = createNotifier(name, notifierConfig);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`  ${chalk.red("FAIL")}  ${name} — plugin error: ${message}`);
          allPassed = false;
          continue;
        }

        const result = await testNotifier(name, notifier, priority);
        if (result.success) {
          console.log(`  ${chalk.green("OK")}    ${name} (${notifierConfig.plugin})`);
        } else {
          console.log(`  ${chalk.red("FAIL")}  ${name} (${notifierConfig.plugin}) — ${result.error}`);
          allPassed = false;
        }
      }

      console.log();
      if (allPassed) {
        console.log(chalk.green("  All notifiers passed."));
      } else {
        console.log(chalk.yellow("  Some notifiers failed. Check config and try again."));
      }
      console.log();
    });
}
