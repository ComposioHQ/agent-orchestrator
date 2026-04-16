#!/usr/bin/env node
/* global fetch */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_TOKEN_FILE = resolve(homedir(), ".discord_bot_token");
const DEFAULT_OUTPUT_DIR = ".ao/discord";
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

function printHelp() {
  console.log(`Usage: pnpm discord:fetch-thread -- <discord-thread-url> [options]

Fetch every message in a Discord thread or channel URL and save the result as JSON.

Options:
  --out <path>         Write output JSON to a specific file
  --stdout             Print JSON to stdout instead of writing a file
  --token-file <path>  Read the bot token from this file if DISCORD_BOT_TOKEN is unset
  --no-parent          Skip fetching the parent channel starter message
  -h, --help           Show this help
`);
}

function expandHome(pathValue) {
  if (pathValue === "~") {
    return homedir();
  }

  if (pathValue.startsWith("~/")) {
    return resolve(homedir(), pathValue.slice(2));
  }

  return resolve(pathValue);
}

function parseArgs(argv) {
  const options = {
    includeParent: true,
    outputPath: null,
    stdout: false,
    tokenFile: DEFAULT_TOKEN_FILE,
    input: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--stdout") {
      options.stdout = true;
      continue;
    }

    if (arg === "--no-parent") {
      options.includeParent = false;
      continue;
    }

    if (arg === "--out" || arg === "--token-file") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === "--out") {
        options.outputPath = expandHome(nextArg);
      } else {
        options.tokenFile = expandHome(nextArg);
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (options.input) {
      throw new Error("Only one Discord thread URL can be fetched at a time.");
    }

    options.input = arg;
  }

  return options;
}

function parseDiscordThreadInput(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error("Expected a Discord URL like https://discord.com/channels/<guild>/<channel>/<message>.");
  }

  if (!/^(.+\.)?discord(?:app)?\.com$/u.test(url.hostname)) {
    throw new Error(`Unsupported host: ${url.hostname}`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "channels") {
    throw new Error("Expected a Discord channels URL.");
  }

  const [, guildId, channelId, messageId = null] = parts;

  if (!guildId || !channelId) {
    throw new Error("Discord thread URL is missing guild or thread identifiers.");
  }

  return {
    channelId,
    guildId,
    messageId,
    sourceUrl: url.toString(),
  };
}

async function loadToken(tokenFile) {
  const existingToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (existingToken) {
    return existingToken;
  }

  const tokenFromFile = (await readFile(tokenFile, "utf8")).trim();
  if (!tokenFromFile) {
    throw new Error(`Token file is empty: ${tokenFile}`);
  }

  process.env.DISCORD_BOT_TOKEN = tokenFromFile;
  return tokenFromFile;
}

async function discordRequest(pathname, token, searchParams = null) {
  const normalizedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const url = new URL(normalizedPath, `${DISCORD_API_BASE_URL}/`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${token}`,
      },
    });

    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const retryAfterMs = Math.ceil(Number(body.retry_after ?? 1) * 1000);
      await sleep(retryAfterMs);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord API ${response.status} for ${url.pathname}: ${body}`);
    }

    return response.json();
  }

  throw new Error(`Discord API rate limited too many times for ${url.pathname}`);
}

async function fetchAllThreadMessages(channelId, token) {
  const batches = [];
  let before = null;

  for (;;) {
    const batch = await discordRequest(`/channels/${channelId}/messages`, token, {
      before,
      limit: 100,
    });

    if (!Array.isArray(batch)) {
      throw new Error("Discord API returned a non-array messages payload.");
    }

    batches.push(...batch);

    if (batch.length < 100) {
      break;
    }

    before = batch.at(-1)?.id ?? null;
    if (!before) {
      break;
    }
  }

  return batches.reverse();
}

async function fetchParentMessage(channel, token) {
  if (!THREAD_CHANNEL_TYPES.has(channel.type) || typeof channel.parent_id !== "string") {
    return null;
  }

  try {
    return await discordRequest(`/channels/${channel.parent_id}/messages/${channel.id}`, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Discord API 404")) {
      return null;
    }

    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (!options.input) {
    printHelp();
    throw new Error("Missing Discord thread URL.");
  }

  const input = parseDiscordThreadInput(options.input);
  const token = await loadToken(options.tokenFile);
  const channel = await discordRequest(`/channels/${input.channelId}`, token);
  const [messages, parentMessage] = await Promise.all([
    fetchAllThreadMessages(input.channelId, token),
    options.includeParent ? fetchParentMessage(channel, token) : Promise.resolve(null),
  ]);

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: input,
    channel,
    parentMessage,
    focusMessage:
      input.messageId === null
        ? null
        : messages.find((message) => typeof message.id === "string" && message.id === input.messageId) ?? null,
    messageCount: messages.length,
    messages,
  };

  if (options.stdout) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    console.error(`Fetched ${messages.length} messages from Discord thread ${input.channelId}.`);
    return;
  }

  const outputPath =
    options.outputPath ?? resolve(DEFAULT_OUTPUT_DIR, `thread-${input.channelId}.json`);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Fetched ${messages.length} messages from Discord thread ${input.channelId}.`);
  console.log(`Saved JSON to ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
