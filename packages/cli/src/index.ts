#!/usr/bin/env node

import { maybeShowUpdateNotice, scheduleBackgroundRefresh } from "./lib/update-check.js";

// Synchronous cache read — no network call on startup.
maybeShowUpdateNotice();

import { createProgram } from "./program.js";
createProgram().parse();

// Background cache refresh so next run has fresh data.
scheduleBackgroundRefresh();
