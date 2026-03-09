import { chromium } from './node_modules/.pnpm/playwright@1.58.0/node_modules/playwright/index.mjs';
import { mkdirSync } from 'fs';
import { join } from 'path';

const DASHBOARD_URL = 'http://localhost:3333';
const SCREENSHOT_DIR = './screenshots';
const TIMEOUT_AGENT = 3 * 60 * 1000;

mkdirSync(SCREENSHOT_DIR, { recursive: true });

let screenshotIdx = 0;

async function screenshot(page, label) {
  screenshotIdx++;
  const name = `${String(screenshotIdx).padStart(2, '0')}-${label}.png`;
  const path = join(SCREENSHOT_DIR, name);
  await page.screenshot({ path, fullPage: false });
  console.log(`  [screenshot] ${name}`);
}

async function main() {
  console.log('Launching Chromium (non-headless)...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    // --- Step 1: Open the dashboard ---
    console.log('\n=== Step 1: Open dashboard ===');
    await page.goto(DASHBOARD_URL, { timeout: 20000, waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await screenshot(page, 'dashboard-loaded');
    console.log('Dashboard loaded successfully.');

    // --- Step 2: Click "New Chat" / "+" button ---
    console.log('\n=== Step 2: Start new conversation ===');
    // Try multiple selector strategies
    const newChatSelectors = [
      'button.new-chat-btn',
      'button:has-text("New Chat")',
      'button:has-text("+")',
      '[aria-label="New Chat"]',
      'button >> text=/new|chat|\\+/i',
    ];
    let clicked = false;
    for (const sel of newChatSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          clicked = true;
          console.log(`Clicked new chat using selector: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }
    if (!clicked) {
      console.log('WARN: Could not find a New Chat button. Continuing anyway (might already be on chat).');
    }
    await page.waitForTimeout(2000);
    await screenshot(page, 'new-conversation');

    // --- Step 3: Type message and send ---
    console.log('\n=== Step 3: Send message ===');
    const inputSelectors = [
      'textarea.chat-input',
      'textarea[placeholder]',
      'textarea',
      'input[type="text"]',
    ];
    let chatInput = null;
    for (const sel of inputSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          chatInput = el;
          console.log(`Found chat input: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }

    if (!chatInput) {
      throw new Error('Could not find chat input element');
    }

    const message = 'Get yc companies, filter by batch';
    await chatInput.fill(message);
    await screenshot(page, 'message-typed');

    // Send the message - try clicking send button or pressing Enter
    const sendSelectors = [
      'button.send-btn',
      'button:has-text("Send")',
      'button[type="submit"]',
      'button[aria-label="Send"]',
    ];
    let sent = false;
    for (const sel of sendSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          sent = true;
          console.log(`Sent via button: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }
    if (!sent) {
      await chatInput.press('Enter');
      console.log('Sent via Enter key.');
    }
    await page.waitForTimeout(3000);
    await screenshot(page, 'message-sent');
    console.log(`Message sent: "${message}"`);

    // --- Step 4: Wait for the agent to finish ---
    console.log('\n=== Step 4: Wait for agent response (up to 3 minutes) ===');

    // Detect that the agent started
    try {
      await page.waitForSelector('button.stop-btn', { timeout: 15000 });
      console.log('Agent is processing (stop button visible)...');
    } catch {
      console.log('Stop button not found — agent may have already finished or uses a different indicator.');
    }

    let agentFinished = false;
    const startTime = Date.now();

    while (!agentFinished && (Date.now() - startTime) < TIMEOUT_AGENT) {
      await page.waitForTimeout(15000);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      const stopVisible = await page.locator('button.stop-btn').isVisible().catch(() => false);
      if (!stopVisible) {
        const sendVisible = await page.locator('button.send-btn').isVisible().catch(() => false);
        const textareaVisible = await page.locator('textarea').first().isVisible().catch(() => false);
        if (sendVisible || textareaVisible) {
          agentFinished = true;
        }
      }

      await screenshot(page, agentFinished ? 'agent-done' : `agent-progress-${elapsed}s`);
      console.log(`  ${elapsed}s elapsed — ${agentFinished ? 'Agent finished!' : 'still running...'}`);
    }

    if (!agentFinished) {
      console.log('WARNING: Agent did not finish within timeout. Continuing anyway.');
    }
    await screenshot(page, 'after-agent');

    // Log any visible text about pack creation
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/pack|flow|created|saved/i.test(bodyText)) {
      const relevant = bodyText.split('\n').filter(l => /pack|flow|created|saved/i.test(l)).slice(0, 5);
      console.log('Relevant page text:', relevant.join(' | '));
    }

    // --- Step 5: Try to click Publish ---
    console.log('\n=== Step 5: Look for Publish button ===');

    // First check if there's a Publish button on the current view
    let publishBtn = page.locator('button:has-text("Publish")').first();
    let publishVisible = await publishBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (!publishVisible) {
      // Try navigating to Packs view
      console.log('No Publish button on current view. Trying Packs nav...');
      const packsNav = page.locator('button:has-text("Packs"), a:has-text("Packs"), [data-tab="packs"]').first();
      if (await packsNav.isVisible({ timeout: 3000 }).catch(() => false)) {
        await packsNav.click();
        await page.waitForTimeout(2000);
        await screenshot(page, 'packs-view');
        publishBtn = page.locator('button:has-text("Publish")').first();
        publishVisible = await publishBtn.isVisible({ timeout: 3000 }).catch(() => false);
      }
    }

    if (publishVisible) {
      console.log('Found Publish button — clicking it.');
      await publishBtn.click();
      await page.waitForTimeout(3000);
      await screenshot(page, 'publish-clicked');

      // Check for auth modal, confirm dialog, etc.
      const modalText = await page.locator('.modal, .dialog, [role="dialog"], .card').last()
        .innerText({ timeout: 3000 }).catch(() => '');
      if (modalText) {
        console.log('Modal/dialog content:', modalText.slice(0, 300));
      }
      await screenshot(page, 'publish-result');
    } else {
      console.log('No Publish button found. Pack may not have been created yet.');
    }

    await screenshot(page, 'final');
    console.log('\n=== Done ===');
    console.log(`Screenshots saved in ${SCREENSHOT_DIR}/`);

  } catch (err) {
    console.error('\n[ERROR]', err.message);
    await screenshot(page, 'error').catch(() => {});
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
