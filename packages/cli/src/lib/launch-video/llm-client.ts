import OpenAI from "openai";
import { existsSync, readFileSync } from "node:fs";

let _client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Set it in your environment.",
      );
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export function hasApiKey(): boolean {
  return Boolean(process.env["OPENAI_API_KEY"]);
}

export function encodeImageForApi(
  filePath: string,
): string | null {
  if (!filePath || !existsSync(filePath)) return null;
  const data = readFileSync(filePath).toString("base64");
  const mediaType = filePath.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mediaType};base64,${data}`;
}

export function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]);
}
