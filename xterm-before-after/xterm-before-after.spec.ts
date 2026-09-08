import { test, expect } from '@playwright/test';
import { ChatUIRegressionHarness } from '../support/test';
import fs from 'node:fs/promises';

const variant = process.env.AO_XTERM_VARIANT!;
const artifactRoot = process.env.AO_CHATUI_E2E_ARTIFACT_DIR!;

test('captures the real xterm lifecycle before and after PR 5105', async ({ page }, testInfo) => {
  const harness = await ChatUIRegressionHarness.create(page, {sessionId: 'terminal-lifecycle-demo'});
  const steps: unknown[] = [];
  await harness.open();
  steps.push({step: 'Initial Chat', errors: [...harness.pageErrors]});
  await page.screenshot({path: `${artifactRoot}/chat.png`});
  for (let cycle = 1; cycle <= 3; cycle++) {
    await harness.setMode('tui');
    await expect(page.getByTestId('terminal-interaction-surface')).toBeVisible();
    // Let normal queued initialization and paint finish. Timers and xterm are unmodified.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    steps.push({step: `Terminal ${cycle}`, errors: [...harness.pageErrors]});
    await page.screenshot({path: `${artifactRoot}/terminal.png`});
    await harness.setMode('chat');
    await expect(page.getByRole('region', {name: 'Chat'})).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    steps.push({step: `Back to Chat ${cycle}`, errors: [...harness.pageErrors]});
  }
  await page.screenshot({path: `${artifactRoot}/returned-chat.png`});
  const result = {variant, commit: process.env.AO_XTERM_COMMIT, scope: 'Unmodified AO renderer and real xterm in Chromium development mode; simulated daemon, preload and PTY. Normal timers; no fault injection.', steps, pageErrors: harness.pageErrors, consoleErrors: harness.consoleErrors, unexpectedRequests: harness.unexpectedRequests};
  await fs.writeFile(`${artifactRoot}/observed.json`, JSON.stringify(result, null, 2));
  await harness.attachEvidence(testInfo);
  if (variant === 'before') {
    expect(harness.pageErrors.filter(error => error.includes("reading 'dimensions'"))).toHaveLength(3);
  } else {
    expect(harness.pageErrors).toEqual([]);
  }
  expect(harness.consoleErrors).toEqual([]);
  expect(harness.unexpectedRequests).toEqual([]);
});
