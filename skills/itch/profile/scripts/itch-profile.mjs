#!/usr/bin/env node
// itch-profile.mjs — itch.io profile and settings editing (dry-run by default).
//
// Commands:
//   get                                  # scrape /user/settings form state
//   edit --summary="..." [--website=...] [--twitter=...] [--display-name=...]
//        [--location=...] [--mastodon=...] [--bluesky=...] [--threads=...]
//   avatar <path>                        # multipart upload to /user/settings
//   notifications --email-purchases=on|off [--email-followers=...] ...
//   privacy --enable-events=on|off
//   dark-mode toggle
//
// Safety: all writes default to DRY-RUN. Add --live to actually send.

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import {
  apiFetch, baseHeaders, mutationHeaders, getAuth, parseArgs,
  postForm, printJson, dryRunEnabled, extractCsrfFromHtml, stripTags, decodeHtml,
} from '../../lib/itch-lib.mjs';

const HELP = `Usage: itch-profile <command> [flags] [--live]
  get                                  # show current profile values
  edit --summary="..." [--website=...] [--twitter=...] [--mastodon=...]
       [--bluesky=...] [--threads=...] [--display-name=...]
  avatar <path>                        # upload avatar/profile image
  notifications --email-<topic>=on|off # purchases, followers, jam_events, community,
                                       # game_sales, features, featured_jams, devlogs,
                                       # game_updates, disable_all
  privacy --enable-events=on|off
  dark-mode toggle                     # POST /user/settings/toggle-dark-mode

All write commands default to DRY-RUN. Add --live to actually execute.
`;

// ----- form parsing -----

// Parse input / textarea / select values from an HTML form string.
// Returns a map: {name -> value} (for checkboxes, returns 'on' if checked attribute present, else omitted).
function parseFormFields(html) {
  const fields = {};
  if (!html) return fields;

  // <input ...>
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname=["']([^"']+)["']/) || [])[1];
    if (!name) continue;
    const type = ((tag.match(/\btype=["']([^"']+)["']/) || [])[1] || 'text').toLowerCase();
    const value = (tag.match(/\bvalue=["']([^"']*)["']/) || [])[1] ?? '';
    const checked = /\bchecked\b/.test(tag);
    if (type === 'checkbox' || type === 'radio') {
      if (checked) fields[name] = value || 'on';
    } else if (type !== 'submit' && type !== 'button' && type !== 'file' && type !== 'image') {
      fields[name] = decodeHtml(value);
    }
  }

  // <textarea name="..."> ... </textarea>
  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname=["']([^"']+)["']/) || [])[1];
    if (!name) continue;
    fields[name] = decodeHtml(m[2]);
  }

  // <select name="..."> ... <option value="..." selected> </select>
  const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname=["']([^"']+)["']/) || [])[1];
    if (!name) continue;
    const body = m[2];
    const selMatch = body.match(/<option[^>]*\bselected\b[^>]*value=["']([^"']*)["']/)
                  || body.match(/<option[^>]*value=["']([^"']*)["'][^>]*\bselected\b/);
    if (selMatch) fields[name] = decodeHtml(selMatch[1]);
    else {
      const first = body.match(/<option[^>]*value=["']([^"']*)["']/);
      if (first) fields[name] = decodeHtml(first[1]);
    }
  }

  return fields;
}

// Isolate the profile-editing <form>.
// On /user/settings the main profile form has an EMPTY action (posts to current URL)
// and is identified by containing the user[display_name] + data[profile] inputs.
function extractProfileForm(html) {
  const forms = html.split(/<\/form>/i);
  for (const part of forms) {
    const formStart = part.match(/<form\b([^>]*)>/i);
    if (!formStart) continue;
    const attrs = formStart[1];
    const action = (attrs.match(/\baction=["']([^"']*)["']/) || [])[1] || '/user/settings';
    // Skip the small single-purpose forms
    if (/\/search|toggle-dark-mode|email-notifications|privacy|password|email-addresses|billing-address|analytics|seller|two-factor|oauth-apps|api-keys|credit-cards|delete-account|data-export|connected-accounts|bluesky|partners|support-email/.test(action)) continue;
    const startIdx = part.indexOf(formStart[0]);
    const body = part.slice(startIdx);
    // Positive signal: this is the profile form if it has the display_name field
    if (!/name=["']user\[display_name\]["']/.test(body)) continue;
    return { action, html: body };
  }
  return null;
}

function toCheckbox(v) {
  if (v === true || v === 'on' || v === '1' || v === 'true' || v === 'yes') return 'on';
  return null;
}

// ----- commands -----

async function cmdGet() {
  const auth = getAuth();
  const url = 'https://itch.io/user/settings';
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  if (res.status === 401 || res.status === 403) {
    console.error('Session expired. Run: node scripts/itch-auth.mjs');
    process.exit(1);
  }
  if (!res.ok) throw new Error(`profile get failed: HTTP ${res.status}`);
  const form = extractProfileForm(res.text);
  if (!form) throw new Error('Could not locate profile form on /user/settings.');
  const fields = parseFormFields(form.html);
  // Also attempt to pull username
  const unameMatch = res.text.match(/<a[^>]*class="[^"]*user_name[^"]*"[^>]*>([^<]+)</);
  const out = {
    source: url,
    action: form.action,
    username: unameMatch ? stripTags(unameMatch[1]) : null,
    csrf_token: fields.csrf_token ? fields.csrf_token.slice(0, 12) + '…' : null,
    display_name: fields['user[display_name]'] || null,
    profile_image_id: fields['user[profile_image_id]'] || null,
    website: fields['data[website]'] || null,
    twitter: fields['data[twitter]'] || null,
    mastodon: fields['data[mastodon]'] || null,
    bluesky: fields['data[bluesky]'] || null,
    threads: fields['data[threads]'] || null,
    summary: fields['data[profile]'] || null,
    gamer: fields['data[gamer]'] === 'on',
    developer: fields['data[developer]'] === 'on',
    nsfw: fields['data[nsfw]'] === 'on',
    dark_theme: fields['data[dark_theme]'] === 'on',
    language: fields['data[language]'] || null,
    prefer_markdown: fields['data[prefer_markdown]'] === 'on',
  };
  printJson(out);
}

async function cmdEdit(flags, argv) {
  const auth = getAuth();
  // Step 1: fetch current form to get csrf_token + all existing field values
  const getRes = await apiFetch('https://itch.io/user/settings', { headers: baseHeaders(auth) });
  if (!getRes.ok) throw new Error(`Could not fetch /user/settings: HTTP ${getRes.status}`);
  const form = extractProfileForm(getRes.text);
  if (!form) throw new Error('Could not locate profile form.');
  const current = parseFormFields(form.html);
  // Use fresh csrf from the form (more reliable than session.csrfToken)
  const csrf = current.csrf_token || extractCsrfFromHtml(getRes.text) || auth.csrfToken;
  if (!csrf) throw new Error('csrf_token not found in /user/settings HTML.');

  // Build update: start from current, overlay flags
  const body = { ...current };
  body.csrf_token = csrf;

  const mapping = {
    'summary': 'data[profile]',
    'website': 'data[website]',
    'twitter': 'data[twitter]',
    'mastodon': 'data[mastodon]',
    'bluesky': 'data[bluesky]',
    'threads': 'data[threads]',
    'display-name': 'user[display_name]',
    'location': 'data[location]',
    'language': 'data[language]',
  };
  const changed = {};
  for (const [flagKey, formKey] of Object.entries(mapping)) {
    if (flags[flagKey] !== undefined && flags[flagKey] !== true) {
      body[formKey] = flags[flagKey];
      changed[formKey] = flags[flagKey];
    }
  }
  if (Object.keys(changed).length === 0) {
    console.error('No editable fields provided. Use --summary=..., --website=..., etc.');
    process.exit(1);
  }

  // Use postForm-style dry-run handling manually so we can pass a merged body directly
  const url = form.action.startsWith('http') ? form.action : `https://itch.io${form.action}`;
  const referer = 'https://itch.io/user/settings';
  const origin = 'https://itch.io';

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }

  const dry = dryRunEnabled(argv);
  if (dry) {
    console.log('\n[DRY-RUN] would POST profile edit:');
    console.log(`  URL:    ${url}`);
    console.log('  Changed fields:');
    for (const [k, v] of Object.entries(changed)) console.log(`    ${k}=${v}`);
    console.log(`  (merged body carries ${params.size} fields total incl. csrf + untouched values)`);
    printJson({ action: 'profile-edit', dryRun: true, changed });
    return;
  }

  const res = await apiFetch(url, {
    method: 'POST',
    headers: mutationHeaders(auth, referer, origin),
    body: params.toString(),
  });
  printJson({ action: 'profile-edit', status: res.status, changed, location: res.headers?.location || null });
}

// Avatar upload is a 4-step dance:
//   1. POST /dashboard/upload-image action=prepare → returns GCS URL + pre-signed post_params + upload_id + success_url
//   2. Multipart POST to GCS (trailing slash required) with post_params + file → 204
//   3. POST /dashboard/upload-image action=success → registers the upload, returns {success, upload:{id,thumb_url}}
//   4. POST /user/settings with user[profile_image_id]=<upload_id> merged into the full form body
async function cmdAvatar(positional, argv) {
  const auth = getAuth();
  const path = positional[0];
  if (!path || !existsSync(path)) throw new Error(`avatar file not found: ${path}`);

  const buf = readFileSync(path);
  const ext = (path.match(/\.([a-zA-Z0-9]+)$/) || [])[1]?.toLowerCase() || 'png';
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4' }[ext] || 'application/octet-stream';

  // Fetch settings HTML once: grab csrf + existing form field values
  const getRes = await apiFetch('https://itch.io/user/settings', { headers: baseHeaders(auth) });
  if (!getRes.ok) throw new Error(`Could not fetch /user/settings: HTTP ${getRes.status}`);
  const form = extractProfileForm(getRes.text);
  if (!form) throw new Error('Could not locate profile form on /user/settings.');
  const current = parseFormFields(form.html);
  const csrf = current.csrf_token || extractCsrfFromHtml(getRes.text) || auth.csrfToken;
  if (!csrf) throw new Error('csrf_token not found.');

  const dry = dryRunEnabled(argv);
  if (dry) {
    console.log('\n[DRY-RUN] would run 4-step avatar upload:');
    console.log(`  1. POST https://itch.io/dashboard/upload-image action=prepare (filename=${basename(path)}, size=${buf.length}, content_type=${mime})`);
    console.log('  2. POST <gcs_url>/ (multipart) with pre-signed post_params + file');
    console.log('  3. POST https://itch.io/dashboard/upload-image action=success upload_id=<id>');
    console.log('  4. POST https://itch.io/user/settings with user[profile_image_id]=<id> (merged with existing form)');
    printJson({ action: 'avatar', dryRun: true, file: path, bytes: buf.length, mime });
    return;
  }

  // Step 1: prepare
  const prepFd = new FormData();
  prepFd.set('csrf_token', csrf);
  prepFd.set('action', 'prepare');
  prepFd.set('thumb_size', 'avatar_preview');
  prepFd.set('filename', basename(path));
  prepFd.set('size', String(buf.length));
  prepFd.set('content_type', mime);
  const prepHdr = mutationHeaders(auth, 'https://itch.io/user/settings', 'https://itch.io');
  delete prepHdr['content-type'];
  const prepResp = await fetch('https://itch.io/dashboard/upload-image', { method: 'POST', headers: prepHdr, body: prepFd });
  const prep = await prepResp.json();
  if (!prep.action || !prep.post_params || !prep.upload_id) {
    throw new Error('prepare failed: ' + JSON.stringify(prep));
  }

  // Step 2: multipart upload to GCS
  const gcsFd = new FormData();
  for (const [k, v] of Object.entries(prep.post_params)) gcsFd.set(k, String(v));
  gcsFd.set('file', new Blob([buf], { type: mime }), basename(path));
  const gcsResp = await fetch(prep.action + '/', { method: 'POST', body: gcsFd });
  if (gcsResp.status !== 204) {
    const txt = await gcsResp.text();
    throw new Error(`GCS upload failed: HTTP ${gcsResp.status} — ${txt.substring(0, 300)}`);
  }

  // Step 3: success
  const succFd = new FormData();
  succFd.set('csrf_token', csrf);
  succFd.set('action', 'success');
  succFd.set('upload_id', String(prep.upload_id));
  succFd.set('thumb_size', 'avatar_preview');
  const succHdr = mutationHeaders(auth, 'https://itch.io/user/settings', 'https://itch.io');
  delete succHdr['content-type'];
  const succResp = await fetch('https://itch.io/dashboard/upload-image', { method: 'POST', headers: succHdr, body: succFd });
  const succ = await succResp.json();
  if (!succ.success || !succ.upload) {
    throw new Error('success step failed: ' + JSON.stringify(succ));
  }

  // Step 4: commit profile_image_id in the main settings form
  const body = { ...current };
  body['user[profile_image_id]'] = String(prep.upload_id);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const commitResp = await apiFetch('https://itch.io/user/settings', {
    method: 'POST',
    headers: mutationHeaders(auth, 'https://itch.io/user/settings', 'https://itch.io'),
    body: params.toString(),
  });

  printJson({
    action: 'avatar',
    uploaded: true,
    upload_id: prep.upload_id,
    thumb_url: succ.upload.thumb_url,
    commit_status: commitResp.status,
  });
}

async function cmdNotifications(flags, argv) {
  const auth = getAuth();
  // Known checkbox keys from forms-inventory.json
  const keys = ['purchases', 'followers', 'jam_events', 'community', 'game_sales', 'features', 'featured_jams', 'devlogs', 'game_updates', 'disable_all'];
  const fields = { 'email_settings[do_update]': '1' };
  let anyChange = false;
  for (const k of keys) {
    const flagName = `email-${k.replace(/_/g, '-')}`;
    const altName = `email-${k}`;
    let v = flags[flagName];
    if (v === undefined) v = flags[altName];
    if (v === undefined) continue;
    anyChange = true;
    if (toCheckbox(v) === 'on') fields[`email_settings[${k}]`] = '1';
    // otherwise: omit (unchecked)
  }
  if (!anyChange) {
    console.error('No flags provided. Example: --email-purchases=on --email-followers=off');
    process.exit(1);
  }
  const res = await postForm(auth, 'https://itch.io/user/settings/email-notifications', fields, {
    referer: 'https://itch.io/user/settings/email-notifications',
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'notifications', status: res.status, data: res.data });
}

async function cmdPrivacy(flags, argv) {
  const auth = getAuth();
  const fields = {};
  if (flags['enable-events'] !== undefined) {
    if (toCheckbox(flags['enable-events']) === 'on') fields['enable_events'] = '1';
  }
  if (Object.keys(fields).length === 0 && flags['enable-events'] === undefined) {
    console.error('No flags provided. Example: --enable-events=on');
    process.exit(1);
  }
  const res = await postForm(auth, 'https://itch.io/user/settings/privacy', fields, {
    referer: 'https://itch.io/user/settings/privacy',
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'privacy', status: res.status, data: res.data });
}

async function cmdDarkMode(positional, argv) {
  const auth = getAuth();
  const sub = positional[0];
  if (sub !== 'toggle') throw new Error('Usage: dark-mode toggle');
  const res = await postForm(auth, 'https://itch.io/user/settings/toggle-dark-mode', {}, {
    referer: 'https://itch.io/user/settings',
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'dark-mode', status: res.status, data: res.data });
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return;
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'get':           return cmdGet();
    case 'edit':          return cmdEdit(flags, argv);
    case 'avatar':        return cmdAvatar(positional, argv);
    case 'notifications': return cmdNotifications(flags, argv);
    case 'privacy':       return cmdPrivacy(flags, argv);
    case 'dark-mode':     return cmdDarkMode(positional, argv);
    default:
      console.error(`Unknown command: ${cmd}\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`itch-profile error: ${e.message}`);
  process.exit(1);
});
