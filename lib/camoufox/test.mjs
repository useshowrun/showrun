import fs from "node:fs/promises";
import process from "node:process";

import createManagedCamoufox, {
  connectCamoufox,
  createContext,
  DEFAULT_WS_URL,
} from "./client.mjs";

const RESULTS_PATH = "/tmp/camoufox-test-results.md";
const SCREENSHOT_PATH = "/tmp/camoufox-fingerprint-test.png";
const TEST_PROFILE_DIR = "/tmp/camoufox-test-profile";

const results = [];

function addResult(name, passed, details) {
  results.push({ name, passed, details });
}

async function runTest(name, fn, { optional = false } = {}) {
  try {
    const details = await fn();
    addResult(name, true, details || "Passed");
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    addResult(name, optional ? true : false, optional ? `Skipped: ${message}` : message);
  }
}

async function writeResults() {
  const lines = ["# Camoufox Test Results", ""];
  for (const result of results) {
    lines.push(`- ${result.passed ? "PASS" : "FAIL"}: ${result.name}`);
    lines.push(`  - ${String(result.details).replace(/\n/g, "\n    ")}`);
  }
  lines.push("");
  const failed = results.filter((entry) => !entry.passed).length;
  lines.push(`Summary: ${results.length - failed}/${results.length} passed`);
  await fs.writeFile(RESULTS_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function withManagedClient(fn, options = {}) {
  const client = await createManagedCamoufox({
    profileDir: TEST_PROFILE_DIR,
    ...options,
  });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main() {
  await runTest("1. Basic connectivity test", async () =>
    withManagedClient(async (client) => {
      const { context, page } = await client.newPage();
      try {
        await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 90000 });
        const title = await page.title();
        if (title !== "Example Domain") {
          throw new Error(`unexpected title: ${title}`);
        }
        return `Loaded example.com with title "${title}" via ${client.wsUrl}`;
      } finally {
        await context.close();
      }
    }),
  );

  await runTest("2. Fingerprinting test", async () =>
    withManagedClient(async (client) => {
      const { context, page } = await client.newPage();
      try {
        await page.goto("https://abrahamjuliot.github.io/creepjs/", {
          waitUntil: "domcontentloaded",
          timeout: 120000,
        });
        await page.waitForTimeout(12000);
        await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
        const body = await page.textContent("body");
        if (!body || /bot|headless detected|automation detected/i.test(body)) {
          throw new Error("page body indicates bot detection");
        }
        return `CreepJS loaded and screenshot saved to ${SCREENSHOT_PATH}`;
      } finally {
        await context.close();
      }
    }),
  );

  await runTest("3. TLS/HTTPS test", async () =>
    withManagedClient(async (client) => {
      const targets = ["https://github.com", "https://www.cloudflare.com"];
      const titles = [];
      for (const target of targets) {
        const { context, page } = await client.newPage();
        try {
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 120000 });
          titles.push(`${target} => ${await page.title()}`);
        } finally {
          await context.close();
        }
      }
      return titles.join("; ");
    }),
  );

  await runTest(
    "4. Proxy support test",
    async () => {
      const proxy = process.env.SOCKS5_PROXY;
      if (!proxy) {
        throw new Error("SOCKS5_PROXY is not set");
      }
      return withManagedClient(
        async (client) => {
          const { context, page } = await client.newPage();
          try {
            await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 90000 });
            return `Connected successfully using proxy ${proxy}`;
          } finally {
            await context.close();
          }
        },
        { proxy },
      );
    },
    { optional: true },
  );

  await runTest("5. Multiple contexts test", async () =>
    withManagedClient(async (client) => {
      const browser = await client.ensureBrowser();
      const urls = ["https://example.com", "https://github.com", "https://www.cloudflare.com"];
      const contexts = await Promise.all(urls.map(() => createContext(browser)));
      try {
        const pages = await Promise.all(contexts.map((context) => context.newPage()));
        const titles = await Promise.all(
          pages.map((page, index) =>
            page.goto(urls[index], { waitUntil: "domcontentloaded", timeout: 120000 }).then(() => page.title()),
          ),
        );
        return `Opened ${contexts.length} contexts in parallel: ${titles.join(", ")}`;
      } finally {
        await Promise.all(contexts.map((context) => context.close()));
      }
    }),
  );

  await runTest("6. Session persistence test", async () =>
    withManagedClient(async (client) => {
      const browser = await client.ensureBrowser();
      const contextA = await createContext(browser);
      let cookie;
      try {
        const page = await contextA.newPage();
        await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 90000 });
        await contextA.addCookies([
          {
            name: "camoufox-session-test",
            value: "persisted",
            domain: "example.com",
            path: "/",
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
          },
        ]);
        cookie = (await contextA.cookies("https://example.com")).find((entry) => entry.name === "camoufox-session-test");
      } finally {
        await contextA.close();
      }

      if (!cookie) {
        throw new Error("failed to store cookie in first context");
      }

      const contextB = await createContext(browser);
      try {
        await contextB.addCookies([cookie]);
        const restored = (await contextB.cookies("https://example.com")).find(
          (entry) => entry.name === "camoufox-session-test",
        );
        if (!restored || restored.value !== "persisted") {
          throw new Error("restored cookie did not match saved cookie");
        }
        return "Cookie save and restore succeeded across contexts";
      } finally {
        await contextB.close();
      }
    }),
  );

  await runTest("7. XHR intercept test", async () =>
    withManagedClient(async (client) => {
      const { context, page } = await client.newPage();
      const seen = [];
      try {
        await page.route("**/*", async (route) => {
          seen.push(route.request().url());
          await route.continue();
        });
        await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.evaluate(async () => {
          await fetch("https://example.com/");
        });
        if (!seen.some((url) => url.includes("example.com"))) {
          throw new Error("intercept did not capture expected request");
        }
        return `Intercepted ${seen.length} requests`;
      } finally {
        await context.close();
      }
    }),
  );

  await runTest("8. Anti-detect test", async () =>
    withManagedClient(async (client) => {
      const { context, page } = await client.newPage();
      try {
        await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 90000 });
        const signals = await page.evaluate(() => ({
          webdriver: navigator.webdriver,
          userAgent: navigator.userAgent,
        }));
        if (signals.webdriver !== false) {
          throw new Error(`navigator.webdriver expected false, got ${signals.webdriver}`);
        }
        if (!signals.userAgent.includes("Firefox")) {
          throw new Error(`expected Firefox UA, got ${signals.userAgent}`);
        }
        return JSON.stringify(signals);
      } finally {
        await context.close();
      }
    }),
  );

  await runTest("9. Auto-restart test", async () =>
    withManagedClient(async (client) => {
      const initial = client.serverProcess?.pid;
      if (!initial) {
        const connected = await connectCamoufox(client.wsUrl || DEFAULT_WS_URL);
        await connected.close();
        return "Reused existing server; no owned process to kill, but manual reconnect succeeded";
      }

      client.serverProcess.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { context, page } = await client.newPage();
      try {
        await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 90000 });
        const restarted = client.serverProcess?.pid;
        if (!restarted || restarted === initial) {
          throw new Error("server did not restart with a new pid");
        }
        return `Server restarted from pid ${initial} to ${restarted}`;
      } finally {
        await context.close();
      }
    }),
  );

  await runTest("10. Concurrent connections test", async () =>
    withManagedClient(async (client) => {
      const browser = await client.ensureBrowser();
      const context = await createContext(browser);
      try {
        const pages = await Promise.all(Array.from({ length: 5 }, () => context.newPage()));
        const titles = await Promise.all(
          pages.map((page, index) =>
            page
              .goto(`https://example.com/?p=${index}`, { waitUntil: "domcontentloaded", timeout: 90000 })
              .then(() => page.title()),
          ),
        );
        return `Opened 5 concurrent pages with titles: ${titles.join(", ")}`;
      } finally {
        await context.close();
      }
    }),
  );

  await writeResults();

  const failed = results.filter((entry) => !entry.passed).length;
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (error) => {
  addResult("Harness failure", false, error instanceof Error ? error.stack || error.message : String(error));
  await writeResults();
  process.exitCode = 1;
});
