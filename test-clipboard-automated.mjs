import { chromium } from 'playwright';

async function testClipboard(url, name) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log(`URL: ${url}`);
  console.log('='.repeat(60));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write']
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(3000); // Wait for terminal to fully load

    // Check clipboard API availability
    const apiCheck = await page.evaluate(() => ({
      clipboardAPI: !!navigator.clipboard,
      secureContext: window.isSecureContext,
    }));
    console.log('Clipboard API:', apiCheck.clipboardAPI ? '✅' : '❌');
    console.log('Secure Context:', apiCheck.secureContext ? '✅' : '❌');

    // Try to check permission (may fail in some contexts)
    try {
      const permission = await page.evaluate(async () => {
        const result = await navigator.permissions.query({ name: 'clipboard-write' });
        return result.state;
      });
      console.log('Permission:', permission);
    } catch (e) {
      console.log('Permission check failed:', e.message);
    }

    // Find the terminal canvas
    const canvas = await page.locator('canvas.xterm-cursor-layer').first();
    if (!await canvas.isVisible()) {
      throw new Error('Terminal canvas not found');
    }

    const box = await canvas.boundingBox();
    if (!box) {
      throw new Error('Could not get canvas bounding box');
    }

    console.log('\nAttempting to select and copy text...');

    // Move to start position
    const startX = box.x + 50;
    const startY = box.y + 50;

    await page.mouse.move(startX, startY);
    await page.mouse.down();

    // Drag to select text (simulate holding mouse)
    await page.mouse.move(startX + 200, startY, { steps: 10 });
    await page.waitForTimeout(500);

    // Press Cmd+C (or Ctrl+C on non-Mac) while mouse is still down
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+KeyC`);
    await page.waitForTimeout(200);

    // Now release mouse
    await page.mouse.up();

    // Try to read clipboard
    const clipboardContent = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch (e) {
        return `Error: ${e.message}`;
      }
    });

    console.log('\n📋 Clipboard content:', clipboardContent ? `"${clipboardContent.substring(0, 100)}..."` : '(empty)');

    if (clipboardContent && !clipboardContent.startsWith('Error:')) {
      console.log('✅ Copying WORKS!');
    } else {
      console.log('❌ Copying FAILED');
    }

  } catch (error) {
    console.error('❌ Test error:', error.message);
  } finally {
    await browser.close();
  }
}

// Test both sessions
console.log('\n🧪 Starting automated clipboard tests...\n');

await testClipboard('http://localhost:7800/ao-orchestrator/', 'ao-orchestrator (port 7800)');
await testClipboard('http://localhost:7804/ao-16/', 'ao-16 (port 7804)');

console.log('\n✅ Tests complete!\n');
