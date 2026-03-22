import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firefox } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const VENV_PYTHON = "/home/karacasoft/.openclaw/.venv/bin/python3";
export const SERVER_SCRIPT = path.join(__dirname, "server.py");
export const DEFAULT_PORT = Number.parseInt(process.env.CAMOUFOX_PORT || "19222", 10);
export const DEFAULT_WS_PATH = process.env.CAMOUFOX_WS_PATH || "camoufox";
export const DEFAULT_PROFILE_DIR =
  process.env.CAMOUFOX_PROFILE_DIR || "/home/karacasoft/.camoufox-profile";
export const DEFAULT_HEADLESS = parseBoolean(process.env.CAMOUFOX_HEADLESS, true);
export const DEFAULT_PROXY = process.env.CAMOUFOX_PROXY || process.env.SOCKS5_PROXY || null;
export const DEFAULT_WS_URL =
  process.env.CAMOUFOX_WS_URL || `ws://127.0.0.1:${DEFAULT_PORT}/${DEFAULT_WS_PATH}`;

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function withDefaults(contextOptions = {}) {
  return {
    locale: process.env.CAMOUFOX_LOCALE || "en-US",
    timezoneId: process.env.CAMOUFOX_TIMEZONE || "America/New_York",
    ...contextOptions,
  };
}

export async function createContext(browser, options = {}) {
  return browser.newContext(withDefaults(options));
}

export async function connectCamoufox(wsUrl = DEFAULT_WS_URL) {
  const browser = await firefox.connect(wsUrl);

  return {
    browser,
    async newPage(contextOptions = {}) {
      const context = await createContext(browser, contextOptions);
      const page = await context.newPage();
      return { context, page };
    },
    async close() {
      await browser.close();
    },
  };
}

function normalizeOptions(options = {}) {
  const port = Number.parseInt(String(options.port ?? DEFAULT_PORT), 10);
  const wsPath = options.wsPath ?? DEFAULT_WS_PATH;
  const wsUrl = options.wsUrl ?? `ws://127.0.0.1:${port}/${wsPath}`;
  return {
    python: options.python ?? process.env.CAMOUFOX_PYTHON ?? VENV_PYTHON,
    port,
    wsPath,
    wsUrl,
    profileDir: options.profileDir ?? DEFAULT_PROFILE_DIR,
    headless: options.headless ?? DEFAULT_HEADLESS,
    proxy: options.proxy ?? DEFAULT_PROXY,
    serverScript: options.serverScript ?? SERVER_SCRIPT,
    startupTimeoutMs: options.startupTimeoutMs ?? 45000,
    connectRetries: options.connectRetries ?? 2,
  };
}

async function tryConnect(wsUrl) {
  try {
    return await firefox.connect(wsUrl);
  } catch {
    return null;
  }
}

async function waitForServerUrl(child, startupTimeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`camoufox server startup timed out after ${startupTimeoutMs}ms: ${stderr || stdout}`));
    }, startupTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith("ws://"));
      if (!line || settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(line);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `camoufox server exited before startup completed (code=${code}, signal=${signal}): ${stderr || stdout}`,
        ),
      );
    });
  });
}

async function startServer(options) {
  const args = [
    options.serverScript,
    "--port",
    String(options.port),
    "--ws-path",
    options.wsPath,
    "--profile-dir",
    options.profileDir,
    "--headless",
    String(options.headless),
  ];

  if (options.proxy) {
    args.push("--proxy", options.proxy);
  }

  const child = spawn(options.python, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const wsUrl = await waitForServerUrl(child, options.startupTimeoutMs);
  return { child, wsUrl };
}

function buildManagedClient(options, state) {
  const setBrowser = (browser) => {
    state.browser = browser;
    if (browser) {
      browser.on("disconnected", () => {
        if (state.browser === browser) {
          state.browser = null;
        }
      });
    }
    return browser;
  };

  const ensureBrowser = async () => {
    const disconnected = state.browser && !state.browser.isConnected();
    if (disconnected) {
      state.browser = null;
    }

    if (state.browser) {
      return state.browser;
    }

    const direct = await tryConnect(state.wsUrl);
    if (direct) {
      return setBrowser(direct);
    }

    if (state.serverProcess && state.serverProcess.exitCode === null) {
      state.serverProcess.kill("SIGTERM");
      state.serverProcess = null;
    }

    const started = await startServer(options);
    state.serverProcess = started.child;
    state.wsUrl = started.wsUrl;
    return setBrowser(await firefox.connect(state.wsUrl));
  };

  return {
    get browser() {
      return state.browser;
    },
    get wsUrl() {
      return state.wsUrl;
    },
    get serverProcess() {
      return state.serverProcess;
    },
    async ensureBrowser() {
      return ensureBrowser();
    },
    async createContext(contextOptions = {}) {
      const browser = await ensureBrowser();
      return createContext(browser, contextOptions);
    },
    async newPage(contextOptions = {}) {
      const context = await this.createContext(contextOptions);
      const page = await context.newPage();
      return { context, page };
    },
    async reconnect() {
      if (state.browser) {
        try {
          await state.browser.close();
        } catch {
          // Ignore disconnection noise during reconnect.
        }
      }
      state.browser = null;
      return ensureBrowser();
    },
    async close() {
      if (state.browser) {
        try {
          await state.browser.close();
        } catch {
          // Ignore already-closed browser failures.
        }
        state.browser = null;
      }

      if (state.serverProcess && state.serverProcess.exitCode === null) {
        state.serverProcess.kill("SIGTERM");
      }
      state.serverProcess = null;
    },
  };
}

export default async function createManagedCamoufox(options = {}) {
  const normalized = normalizeOptions(options);
  const state = {
    wsUrl: normalized.wsUrl,
    browser: null,
    serverProcess: null,
  };

  state.browser = await tryConnect(state.wsUrl);
  if (!state.browser) {
    const started = await startServer(normalized);
    state.serverProcess = started.child;
    state.wsUrl = started.wsUrl;
    state.browser = await firefox.connect(state.wsUrl);
  }

  state.browser.on("disconnected", () => {
    if (state.browser && !state.browser.isConnected()) {
      state.browser = null;
    }
  });

  return buildManagedClient(normalized, state);
}
