/**
 * Shared utilities for Glassdoor scrapers.
 */

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

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a count string like "69.2Kreviews" or "6.7Kjobs" into a number.
 */
export function parseCountString(str) {
  if (!str) return null;
  const m = str.match(/([\d.]+)([KMBkmb]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
  return Math.round(n * mult);
}
