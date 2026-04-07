#!/usr/bin/env node

import { ConfigNotFoundError } from "@composio/ao-core";
import { createProgram } from "./program.js";

createProgram()
  .parseAsync()
  .catch((err) => {
    if (err instanceof ConfigNotFoundError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
      return;
    }
    throw err;
  });
