import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import * as OTPAuth from "otpauth";
import { parse as parseDomain } from "tldts";

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const SESSION_FILE = path.join(os.homedir(), ".pitchbook-session.json");

export function loadSession() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveSession(headers, cookies, username) {
  const session = {
    headers,
    cookies,
    username: username || null,
    capturedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  log("Session saved to", SESSION_FILE);
  return session;
}

export function isSessionValid(session) {
  if (!session || !session.headers || !session.cookies) return false;
  const capturedAt = new Date(session.capturedAt);
  const ageMs = Date.now() - capturedAt.getTime();
  return ageMs < 30 * 60 * 1000; // 30 minutes
}

// ---------------------------------------------------------------------------
// Custom error for expired sessions
// ---------------------------------------------------------------------------

export class SessionExpiredError extends Error {
  constructor(message = "Session expired") {
    super(message);
    this.name = "SessionExpiredError";
    this.code = "SESSION_EXPIRED";
  }
}

// ---------------------------------------------------------------------------
// curl helpers
// ---------------------------------------------------------------------------

const CURL_BINARY = process.env.CURL_BINARY || "curl";

function buildCurlHeaders(session, referer, isPost = false) {
  const h = session.headers;
  const args = [];

  // Core headers from session
  if (h["host"]) args.push("-H", `host: ${h["host"]}`);
  if (h["user-agent"]) args.push("-H", `user-agent: ${h["user-agent"]}`);
  args.push("-H", "accept: application/json");
  if (h["accept-language"])
    args.push("-H", `accept-language: ${h["accept-language"]}`);
  if (referer) args.push("-H", `referer: ${referer}`);
  if (h["x-requested-with"])
    args.push("-H", `x-requested-with: ${h["x-requested-with"]}`);

  if (isPost) {
    args.push("-H", "content-type: application/json");
    args.push("-H", "origin: https://my.pitchbook.com");
  }

  if (h["alt-used"]) args.push("-H", `alt-used: ${h["alt-used"]}`);
  if (h["connection"]) args.push("-H", `connection: ${h["connection"]}`);

  // Cookies
  args.push("-b", session.cookies);

  // Security headers
  args.push("-H", "sec-fetch-dest: empty");
  args.push("-H", "sec-fetch-mode: cors");
  args.push("-H", "sec-fetch-site: same-origin");
  args.push("-H", "dnt: 1");

  // TLS + HTTP/2
  args.push("--tlsv1.3", "--http2");

  return args;
}

function execCurl(args) {
  // Add flags for capturing HTTP status
  const fullArgs = [
    CURL_BINARY,
    ...args,
    "-s", // silent
    "-w",
    "\n%{http_code}", // append status code
  ];

  const cmd = fullArgs
    .map((a) => {
      // Quote arguments that contain spaces or special chars
      if (/[\s'"\\&|;$`!{}()*?<>]/.test(a)) {
        return `'${a.replace(/'/g, "'\\''")}'`;
      }
      return a;
    })
    .join(" ");

  log("curl command:", cmd.substring(0, 200) + "...");

  const output = execSync(cmd, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 60_000,
  });

  // Last line is status code
  const lines = output.trimEnd().split("\n");
  const statusCode = parseInt(lines.pop(), 10);
  const body = lines.join("\n");

  if (statusCode === 401 || statusCode === 403) {
    throw new SessionExpiredError(
      `HTTP ${statusCode} — session likely expired`
    );
  }

  // Detect redirect to login page
  if (body.includes('"loginUrl"') || body.includes("/login")) {
    throw new SessionExpiredError("Response contains login redirect");
  }

  try {
    return JSON.parse(body);
  } catch {
    // Return raw body wrapped
    return { _raw: body, _statusCode: statusCode };
  }
}

export function curlGet(url, session, referer) {
  const args = [url, ...buildCurlHeaders(session, referer, false)];
  return execCurl(args);
}

export function curlPost(url, session, body, referer) {
  const args = [
    url,
    ...buildCurlHeaders(session, referer, true),
    "--data-raw",
    JSON.stringify(body),
  ];
  return execCurl(args);
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

export async function cdpConnect(cdpUrl = "http://localhost:9222") {
  const resp = await fetch(`${cdpUrl}/json`);
  const tabs = await resp.json();

  // Prefer a Pitchbook tab
  let tab =
    tabs.find((t) => t.url && t.url.includes("my.pitchbook.com")) || tabs[0];

  if (!tab || !tab.webSocketDebuggerUrl) {
    throw new Error("No debuggable tab found via CDP");
  }

  log("Connecting to tab:", tab.title || tab.url);

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  let msgId = 0;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.id !== undefined && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  });

  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return { ws, send, tab };
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

export function generateTOTP(base32Secret) {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
  return totp.generate();
}

// ---------------------------------------------------------------------------
// Domain extraction
// ---------------------------------------------------------------------------

export function extractDomain(url) {
  const result = parseDomain(url);
  return result.domain ? `${result.domain}.${result.publicSuffix}` : url;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

export function emitError(code, message) {
  process.stdout.write(
    "RESULT:" + JSON.stringify({ error: true, code, message }) + "\n"
  );
  process.exit(1);
}

export function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}
