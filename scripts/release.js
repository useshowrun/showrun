#!/usr/bin/env node

/**
 * Release script for the ShowRun monorepo.
 *
 * Usage:
 *   node scripts/release.js rc 0.1.10          # start new RC cycle
 *   node scripts/release.js rc                  # bump existing RC number
 *   node scripts/release.js stable              # promote current RC to stable
 *   node scripts/release.js rc 0.1.10 --dry-run # dry run (no publish)
 *   node scripts/release.js publish-only        # retry publish (no version changes)
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// Publish order — respects the dependency graph
const PACKAGES = [
  "packages/core",
  "packages/harness",
  "packages/techniques",
  "packages/mcp-server",
  "packages/browser-inspector-mcp",
  "packages/taskpack-editor-mcp",
  "packages/dashboard",
  "packages/showrun",
];

const TECHNIQUES_DEP_PATH = "packages/showrun/package.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPkg(relPath) {
  const abs = join(ROOT, relPath, "package.json");
  return JSON.parse(readFileSync(abs, "utf-8"));
}

function writePkg(relPath, data) {
  const abs = join(ROOT, relPath, "package.json");
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
}

function currentVersion() {
  return readPkg(".").version;
}

function parseRC(version) {
  const m = version.match(/^(.+)-rc\.(\d+)$/);
  if (!m) return null;
  return { base: m[1], num: parseInt(m[2], 10) };
}

function die(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  console.log(`\x1b[36m$ ${cmd}\x1b[0m`);
  return execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

function resolveVersion(mode, targetArg) {
  const cur = currentVersion();
  const rc = parseRC(cur);

  if (mode === "rc") {
    if (targetArg) {
      // Explicit target version given
      if (rc && rc.base === targetArg) {
        // Already on an RC of this version — bump RC number
        return `${targetArg}-rc.${rc.num + 1}`;
      }
      // Start a new RC cycle
      return `${targetArg}-rc.0`;
    }
    // No target — bump existing RC
    if (!rc) die(`Current version "${cur}" is not an RC. Provide a target version: node scripts/release.js rc <version>`);
    return `${rc.base}-rc.${rc.num + 1}`;
  }

  if (mode === "stable") {
    if (!rc) die(`Current version "${cur}" is not an RC. Nothing to promote.`);
    return rc.base;
  }

  die(`Unknown mode "${mode}". Use "rc" or "stable".`);
}

// ---------------------------------------------------------------------------
// Update versions
// ---------------------------------------------------------------------------

function updateVersions(newVersion, dryRun) {
  const rc = parseRC(newVersion);
  // RC: pin exact version (npm won't resolve ^0.1.10 to 0.1.10-rc.0)
  // Stable: use caret range
  const techniquesDep = rc ? newVersion : `^${newVersion}`;

  if (dryRun) {
    console.log(`\n  [dry-run] Would set all package versions to ${newVersion}`);
    console.log(`  [dry-run] Would set @showrun/techniques dep to ${techniquesDep}`);
    return;
  }

  // Root package.json
  const rootPkg = readPkg(".");
  rootPkg.version = newVersion;
  writePkg(".", rootPkg);

  // Each workspace package
  for (const dir of PACKAGES) {
    const pkg = readPkg(dir);
    pkg.version = newVersion;
    writePkg(dir, pkg);
  }

  // Update @showrun/techniques dependency in showrun CLI package
  const cliPkg = readPkg("packages/showrun");
  if (cliPkg.dependencies?.["@showrun/techniques"]) {
    cliPkg.dependencies["@showrun/techniques"] = techniquesDep;
    writePkg("packages/showrun", cliPkg);
  }

  console.log(`\nVersions updated to \x1b[32m${newVersion}\x1b[0m`);
  console.log(`@showrun/techniques dep set to \x1b[32m${techniquesDep}\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build() {
  console.log("\n\x1b[1mBuilding all packages...\x1b[0m\n");
  try {
    run("pnpm build");
  } catch {
    die("Build failed. Fix the errors above and try again.");
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function publish(newVersion, dryRun) {
  const rc = parseRC(newVersion);
  const tag = rc ? "rc" : "latest";

  console.log(`\n\x1b[1mPublishing ${PACKAGES.length} packages (tag: ${tag})...\x1b[0m\n`);

  for (const dir of PACKAGES) {
    const pkg = readPkg(dir);
    const label = `${pkg.name}@${newVersion}`;

    if (dryRun) {
      console.log(`  [dry-run] Would publish ${label} --tag ${tag}`);
      continue;
    }

    try {
      run(`pnpm publish --tag ${tag} --no-git-checks`, { cwd: join(ROOT, dir) });
      console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    } catch {
      die(`Failed to publish ${label}. Earlier packages may already be published.\nTo retry: node scripts/release.js publish-only`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(newVersion, dryRun) {
  const rc = parseRC(newVersion);
  console.log("\n" + "=".repeat(50));

  if (dryRun) {
    console.log("\x1b[33m[DRY RUN]\x1b[0m No packages were published.\n");
  } else {
    console.log(`\x1b[32mPublished ${PACKAGES.length} packages @ ${newVersion}\x1b[0m\n`);
  }

  console.log("Install:");
  if (rc) {
    console.log(`  npx showrun@rc`);
    console.log(`  npm install showrun@${newVersion}`);
  } else {
    console.log(`  npx showrun`);
    console.log(`  npm install showrun@${newVersion}`);
  }

  console.log("\nNext steps:");
  if (rc) {
    console.log("  - Test the RC, then run: node scripts/release.js stable");
    console.log("  - Or bump RC:            node scripts/release.js rc");
  } else {
    console.log("  - Update CHANGELOG.md: rename Unreleased → " + newVersion);
    console.log("  - git tag v" + newVersion + " && git push --tags");
  }
  console.log("=".repeat(50) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));

  const mode = positional[0];
  const targetArg = positional[1];

  if (!mode || !["rc", "stable", "publish-only"].includes(mode)) {
    console.log(`Usage:
  node scripts/release.js rc <version>   Start new RC cycle
  node scripts/release.js rc             Bump existing RC number
  node scripts/release.js stable         Promote current RC to stable
  node scripts/release.js publish-only   Retry publish at current version (no version changes)

Options:
  --dry-run   Show what would happen without publishing`);
    process.exit(0);
  }

  if (mode === "publish-only") {
    const version = currentVersion();
    console.log(`\n\x1b[1mShowRun Publish-Only\x1b[0m`);
    console.log(`  Version:  ${version}`);
    if (dryRun) console.log(`  \x1b[33m[DRY RUN]\x1b[0m`);

    if (!dryRun) {
      build();
    }

    publish(version, dryRun);
    printSummary(version, dryRun);
    return;
  }

  const curVersion = currentVersion();
  const newVersion = resolveVersion(mode, targetArg);

  console.log(`\n\x1b[1mShowRun Release\x1b[0m`);
  console.log(`  Current:  ${curVersion}`);
  console.log(`  Target:   ${newVersion}`);
  if (dryRun) console.log(`  \x1b[33m[DRY RUN]\x1b[0m`);

  updateVersions(newVersion, dryRun);

  if (!dryRun) {
    build();
  }

  publish(newVersion, dryRun);
  printSummary(newVersion, dryRun);
}

main();
