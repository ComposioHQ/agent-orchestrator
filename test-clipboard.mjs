import { chromium } from 'playwright';

async function testClipboard(url, name) {
  console.log(`\n=== Testing ${name} ===`);
  console.log(`URL: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write']
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle' });

    // Wait for terminal to load
    await page.waitForTimeout(2000);

    // Test clipboard permissions
    const results = await page.evaluate(async () => {
      const tests = {};

      // Test 1: Permissions API
      try {
        const result = await navigator.permissions.query({ name: 'clipboard-write' });
        tests.permissionState = result.state;
      } catch (e) {
        tests.permissionState = `Error: ${e.message}`;
      }

      // Test 2: Clipboard API availability
      tests.clipboardAPI = navigator.clipboard ? 'available' : 'not available';

      // Test 3: Secure context
      tests.secureContext = window.isSecureContext;

      // Test 4: Try to write to clipboard
      try {
        await navigator.clipboard.writeText('test');
        tests.clipboardWrite = 'success';
      } catch (e) {
        tests.clipboardWrite = `failed: ${e.message}`;
      }

      // Test 5: Check if document.execCommand is available
      tests.execCommand = typeof document.execCommand === 'function';

      return tests;
    });

    console.log('Results:');
    console.log(JSON.stringify(results, null, 2));

  } catch (error) {
    console.error(`Error: ${error.message}`);
  } finally {
    await browser.close();
  }
}

// Test both URLs
await testClipboard('http://localhost:7800/ao-orchestrator/', 'Port 7800 (working)');
await testClipboard('http://localhost:7804/ao-16/', 'Port 7804 (broken)');

console.log('\n=== Test Complete ===\n');
