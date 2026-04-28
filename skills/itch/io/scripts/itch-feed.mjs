#!/usr/bin/env node
// itch-feed.mjs — authenticated reads from itch.io user surfaces.
//
// Commands:
//   feed [--from-event=<id>]        # /my-feed?format=json&fetch_alt=true
//   purchases [--page=N]            # /my-purchases?format=json
//   collections                     # /my-collections
//   notifications [--page=N]        # /my-notifications
//   dashboard                       # /dashboard (creator tools)

import {
  apiFetch, jsonHeaders, baseHeaders, getAuth, parseArgs,
  printJson, writeCache, parseGameCells, parseEventCells, stripTags, decodeHtml,
} from './itch-lib.mjs';

const HELP = `Usage: itch-feed <command>
  feed [--from-event=<id>]
  purchases [--page=N]
  collections
  notifications [--page=N]
  dashboard
`;

function assertAuthed(res) {
  if (res.status === 401 || res.status === 403) {
    console.error('Session expired. Run: node scripts/itch-auth.mjs');
    process.exit(1);
  }
}

async function cmdFeed(flags) {
  const auth = getAuth();
  const params = new URLSearchParams({ format: 'json', fetch_alt: 'true' });
  if (flags['from-event']) params.set('from_event', String(flags['from-event']));
  const url = `https://itch.io/my-feed?${params.toString()}`;
  const res = await apiFetch(url, { headers: jsonHeaders(auth, 'https://itch.io/my-feed') });
  assertAuthed(res);
  if (!res.ok) throw new Error(`feed failed: HTTP ${res.status}`);
  const events = parseEventCells(res.data?.content || '');
  const out = {
    source: url,
    num_items: res.data?.num_items ?? events.length,
    events,
    next_cursor: events.length ? events[events.length - 1].id : null,
  };
  writeCache('feed', Date.now(), out);
  printJson(out);
}

async function cmdPurchases(flags) {
  const auth = getAuth();
  const page = Number(flags.page || 1);
  // Fetch HTML first — it carries gating notices (email unverified) that the JSON endpoint swallows.
  const htmlUrl = `https://itch.io/my-purchases${page > 1 ? `?page=${page}` : ''}`;
  const htmlRes = await apiFetch(htmlUrl, { headers: baseHeaders(auth) });
  assertAuthed(htmlRes);
  if (!htmlRes.ok) throw new Error(`purchases failed: HTTP ${htmlRes.status}`);
  const html = htmlRes.text || htmlRes.data || '';

  // Detect gating: unverified email hides purchases entirely
  if (/Your email address is not verified/i.test(html) ||
      /verify your email address on the Email Settings page/i.test(html)) {
    const out = {
      source: htmlUrl,
      error: 'email_not_verified',
      message: 'Your itch.io email address is not verified. Purchases are hidden until you verify. Visit https://itch.io/user/settings/email-addresses and click the verification link sent to your inbox.',
      hint_url: 'https://itch.io/user/settings/email-addresses',
    };
    printJson(out);
    return;
  }

  // Detect empty-state message (legitimate zero purchases)
  if (/You haven&#039;t purchased anything yet|You haven't purchased anything yet/i.test(html)) {
    const out = {
      source: htmlUrl,
      page,
      num_items: 0,
      games: [],
      note: "This account has no purchases (itch.io shows no library entries). Free downloads don't appear here — only paid purchases and bundle claims.",
    };
    writeCache('purchases', `p${page}`, out);
    printJson(out);
    return;
  }

  // Normal path: use JSON endpoint for paginated cells
  const jsonUrl = `https://itch.io/my-purchases?format=json${page > 1 ? `&page=${page}` : ''}`;
  const res = await apiFetch(jsonUrl, { headers: jsonHeaders(auth, 'https://itch.io/my-purchases') });
  let games = [];
  if (typeof res.data === 'object' && res.data?.content) {
    games = parseGameCells(res.data.content);
  }
  const out = {
    source: jsonUrl,
    page,
    num_items: res.data?.num_items ?? games.length,
    games,
  };
  writeCache('purchases', `p${page}`, out);
  printJson(out);
}

async function cmdCollections() {
  const auth = getAuth();
  const url = 'https://itch.io/my-collections';
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  assertAuthed(res);
  if (!res.ok) throw new Error(`collections failed: HTTP ${res.status}`);
  const h = res.text;
  const collections = [];
  // Typical markup: <a href="/c/<id>/<slug>" class="collection_row_title">
  const colRe = /<a[^>]*href="\/c\/(\d+)\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  const seen = new Set();
  while ((m = colRe.exec(h))) {
    const id = Number(m[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    collections.push({
      id,
      slug: m[2],
      title: stripTags(m[3]),
      url: `https://itch.io/c/${m[1]}/${m[2]}`,
    });
  }
  const out = { source: url, num_collections: collections.length, collections };
  writeCache('collections', 'list', out);
  printJson(out);
}

async function cmdNotifications(flags) {
  const auth = getAuth();
  const page = Number(flags.page || 1);
  const url = `https://itch.io/my-notifications${page > 1 ? `?page=${page}` : ''}`;
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  assertAuthed(res);
  if (!res.ok) throw new Error(`notifications failed: HTTP ${res.status}`);
  const events = parseEventCells(res.text);
  // Also try the simpler notification_row pattern
  const rows = [];
  const rowRe = /<div[^>]*class="[^"]*notification_row[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let m;
  while ((m = rowRe.exec(res.text))) {
    rows.push({ text: stripTags(m[1]).slice(0, 500) });
  }
  const out = {
    source: url,
    page,
    events,
    rows: rows.slice(0, 50),
  };
  writeCache('notifications', `p${page}`, out);
  printJson(out);
}

async function cmdDashboard() {
  const auth = getAuth();
  const url = 'https://itch.io/dashboard';
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  assertAuthed(res);
  if (!res.ok) throw new Error(`dashboard failed: HTTP ${res.status}`);
  const h = res.text;
  const title = (h.match(/<title>([^<]+)<\/title>/) || [])[1];
  const links = [];
  const linkRe = /<a[^>]*href="(\/dashboard[^"]*)"[^>]*>([^<]+)<\/a>/g;
  let m;
  const seen = new Set();
  while ((m = linkRe.exec(h))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    links.push({ url: `https://itch.io${m[1]}`, label: decodeHtml(m[2].trim()) });
  }
  const out = { source: url, title: title || null, links };
  writeCache('dashboard', 'main', out);
  printJson(out);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return;
  }
  const cmd = argv[0];
  const { flags } = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'feed':          return cmdFeed(flags);
    case 'purchases':     return cmdPurchases(flags);
    case 'collections':   return cmdCollections();
    case 'notifications': return cmdNotifications(flags);
    case 'dashboard':     return cmdDashboard();
    default:
      console.error(`Unknown command: ${cmd}\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`itch-feed error: ${e.message}`);
  process.exit(1);
});
