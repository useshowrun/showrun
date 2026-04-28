#!/usr/bin/env node
// itch-browse.mjs — public scraping commands for itch.io.
//
// Commands:
//   browse [--filter=<f>] [--page=N]           # /games[/<filter>]?format=json
//   search <query> [--classification=<c>] [--page=N]
//   game <dev/slug|url>                        # game detail + merged HTML extras
//   dev <username>                             # developer profile page
//   comments <dev/slug> [--before=<id>]
//   devlog <dev/slug> [--page=N]
//   jam <slug>
//   jam-entries <slug>
//   topic <topic_id> [--slug=<slug>] [--page=N]
//   board <board_id> [--slug=<slug>] [--page=N]
//
// Works cookie-less; uses session if present.

import {
  apiFetch, jsonHeaders, baseHeaders, getAuthOptional, parseArgs,
  parseGameSlug, parseUserSlug, printJson, writeCache,
  parseGameCells, stripTags, decodeHtml,
} from './itch-lib.mjs';

const HELP = `Usage: itch-browse <command> [args]
  browse [--filter=top-rated|free|paid|newest|genre-puzzle|tag-2d|platform-web] [--page=N]
  search <query> [--classification=games|game_mods|physical_games|books|comics|assets|tools] [--page=N]
  game <dev/slug|url>
  dev <username>
  comments <dev/slug> [--before=<id>]
  devlog <dev/slug> [--page=N]
  jam <slug>
  jam-entries <slug>
  topic <topic_id> [--slug=<slug>] [--page=N]
  board <board_id> [--slug=<slug>] [--page=N]
`;

async function cmdBrowse(flags) {
  const auth = getAuthOptional();
  const filter = flags.filter;
  const page = Number(flags.page || 1);
  const path = filter ? `/games/${encodeURIComponent(filter)}` : '/games';
  const url = `https://itch.io${path}?format=json&page=${page}`;
  const referer = `https://itch.io${path}`;
  const res = await apiFetch(url, { headers: jsonHeaders(auth, referer) });
  if (!res.ok) throw new Error(`browse failed: HTTP ${res.status}`);
  if (typeof res.data !== 'object' || !res.data.content) {
    throw new Error(`Unexpected response shape from ${url}: ${res.text.slice(0, 300)}`);
  }
  const games = parseGameCells(res.data.content);
  const out = {
    source: url,
    page,
    filter: filter || null,
    num_items: res.data.num_items ?? games.length,
    games,
  };
  const cachePath = writeCache('browse', `${filter || 'top'}-p${page}`, out);
  printJson(out);
  console.error(`[cached: ${cachePath}]`);
}

async function cmdSearch(positional, flags) {
  const auth = getAuthOptional();
  const q = positional[0];
  if (!q) throw new Error('search <query> required');
  const page = Number(flags.page || 1);
  const params = new URLSearchParams({ q });
  if (flags.classification) params.set('classification', flags.classification);
  if (page > 1) params.set('page', String(page));
  const url = `https://itch.io/search?${params.toString()}`;
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  const html = res.text;

  // Parse .game_cell blocks from the HTML
  const games = parseGameCells(html);

  // Also parse "user_cell" and "game_grid_widget" results where applicable
  const userRe = /<div[^>]*class="[^"]*\buser_cell\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  const users = [];
  let m;
  while ((m = userRe.exec(html))) {
    const nameMatch = m[1].match(/<a[^>]*class="[^"]*user_link[^"]*"[^>]*>([^<]+)</)
                   || m[1].match(/<a[^>]*href="(https:\/\/[^.]+\.itch\.io\/)"/);
    if (nameMatch) users.push({ name: decodeHtml(nameMatch[1]) });
  }

  const out = {
    source: url,
    query: q,
    classification: flags.classification || null,
    page,
    num_results: games.length,
    games,
    users,
  };
  writeCache('search', `${q.replace(/\s+/g, '_')}-p${page}`, out);
  printJson(out);
}

async function cmdGame(positional) {
  const auth = getAuthOptional();
  const input = positional[0];
  const { dev, slug, url } = parseGameSlug(input);

  // Primary: /data.json dedicated route on the dev subdomain
  const dataUrl = `${url}/data.json`;
  const dataRes = await apiFetch(dataUrl, {
    headers: jsonHeaders(auth, url),
  });

  let data = {};
  if (dataRes.ok && typeof dataRes.data === 'object') {
    data = dataRes.data;
  } else if (dataRes.status !== 404) {
    console.error(`[warn] data.json HTTP ${dataRes.status}`);
  }

  // Secondary: HTML page, to scrape supplementary fields + upload_ids + topic_id
  const htmlRes = await apiFetch(url, { headers: baseHeaders(auth) });
  let extras = {};
  if (htmlRes.ok) {
    const h = htmlRes.text;
    const titleMatch = h.match(/<h1[^>]*class="[^"]*game_title[^"]*"[^>]*>([^<]+)</)
                    || h.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
    const descMatch = h.match(/<meta\s+name="description"\s+content="([^"]+)"/);
    const ratingMatch = h.match(/aggregateRating[\s\S]{0,500}?"ratingValue"\s*:\s*"?([\d.]+)"?/i);
    const ratingCountMatch = h.match(/aggregateRating[\s\S]{0,500}?"ratingCount"\s*:\s*"?(\d+)"?/i);
    const authorMatch = h.match(/<a[^>]*href="https:\/\/([a-z0-9-]+)\.itch\.io\/?"[^>]*>([^<]+)<\/a>\s*<\/h2>/i);

    // Scrape upload_ids
    const uploads = [];
    const uploadRe = /data-upload_id="(\d+)"[^>]*>([\s\S]*?)(?=data-upload_id="|<\/div>\s*<div\s+class="buy_row)/g;
    let um;
    while ((um = uploadRe.exec(h))) {
      const name = (um[2].match(/class="[^"]*upload_name[^"]*"[^>]*>([\s\S]*?)</) || [])[1];
      const size = (um[2].match(/class="[^"]*file_size[^"]*"[^>]*>([\s\S]*?)</) || [])[1];
      uploads.push({
        upload_id: Number(um[1]),
        name: name ? stripTags(name) : null,
        size: size ? stripTags(size) : null,
      });
    }
    // Alt: simpler match
    if (uploads.length === 0) {
      const simpleRe = /data-upload_id="(\d+)"/g;
      let sm;
      while ((sm = simpleRe.exec(h))) {
        uploads.push({ upload_id: Number(sm[1]), name: null, size: null });
      }
    }

    // Topic id (for comments)
    const topicMatch = h.match(/community_topic_(\d+)/)
                    || h.match(/\/topic\/(\d+)\//);

    // Devlog count
    const devlogMatch = h.match(/>Development log\b[\s\S]{0,200}?(\d+)\s+(?:posts?|entries)/i);

    extras = {
      title: titleMatch ? decodeHtml(titleMatch[1]) : null,
      description: descMatch ? decodeHtml(descMatch[1]) : null,
      rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
      rating_count: ratingCountMatch ? Number(ratingCountMatch[1]) : null,
      author: authorMatch ? decodeHtml(authorMatch[2]) : null,
      author_slug: authorMatch ? authorMatch[1] : dev,
      uploads,
      topic_id: topicMatch ? Number(topicMatch[1]) : null,
      devlog_count: devlogMatch ? Number(devlogMatch[1]) : null,
    };
  } else {
    console.error(`[warn] HTML page HTTP ${htmlRes.status}`);
  }

  const out = {
    source: url,
    dev,
    slug,
    data,
    extras,
  };
  writeCache('game', `${dev}_${slug}`, out);
  printJson(out);
}

async function cmdDev(positional) {
  const auth = getAuthOptional();
  const user = parseUserSlug(positional[0]);
  const url = `https://${user}.itch.io/`;
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  if (!res.ok) throw new Error(`dev fetch failed: HTTP ${res.status}`);
  const h = res.text;
  const titleMatch = h.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  const descMatch = h.match(/<meta\s+name="description"\s+content="([^"]+)"/);
  // Scrape game cells in their "games list" section
  const games = parseGameCells(h);
  // Simpler anchor-only scrape for older pages
  const simpleGames = [];
  const gameLinkRe = /<a[^>]*class="[^"]*game_link[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
  let lm;
  while ((lm = gameLinkRe.exec(h))) {
    simpleGames.push({ url: lm[1], title: decodeHtml(lm[2]) });
  }
  const out = {
    source: url,
    user,
    name: titleMatch ? decodeHtml(titleMatch[1]) : null,
    description: descMatch ? decodeHtml(descMatch[1]) : null,
    games: games.length ? games : simpleGames,
  };
  writeCache('dev', user, out);
  printJson(out);
}

async function cmdComments(positional, flags) {
  const auth = getAuthOptional();
  const { dev, slug, url } = parseGameSlug(positional[0]);
  const params = new URLSearchParams();
  if (flags.before) params.set('before', String(flags.before));
  const qs = params.toString();
  const commentsUrl = `${url}/comments${qs ? `?${qs}` : ''}`;
  const res = await apiFetch(commentsUrl, { headers: jsonHeaders(auth, url) });
  if (!res.ok) throw new Error(`comments fetch failed: HTTP ${res.status}`);
  const out = {
    source: commentsUrl,
    dev,
    slug,
    data: res.data,
  };
  writeCache('comments', `${dev}_${slug}`, out);
  printJson(out);
}

async function cmdDevlog(positional, flags) {
  const auth = getAuthOptional();
  const { dev, slug, url } = parseGameSlug(positional[0]);
  const page = Number(flags.page || 1);
  const devlogUrl = `${url}/devlog${page > 1 ? `?page=${page}` : ''}`;
  const res = await apiFetch(devlogUrl, { headers: baseHeaders(auth) });
  if (!res.ok) throw new Error(`devlog fetch failed: HTTP ${res.status}`);
  const h = res.text;
  const posts = [];
  const postRe = /<div[^>]*class="[^"]*post_grid_widget_cell[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
  // Simpler: find post links
  const linkRe = /<a[^>]*class="[^"]*post_link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(h))) {
    posts.push({ url: m[1], title: stripTags(m[2]) });
  }
  const out = { source: devlogUrl, dev, slug, page, posts };
  writeCache('devlog', `${dev}_${slug}-p${page}`, out);
  printJson(out);
}

async function cmdJam(positional) {
  const auth = getAuthOptional();
  const slug = positional[0];
  if (!slug) throw new Error('jam <slug> required');
  const url = `https://itch.io/jam/${encodeURIComponent(slug)}`;
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  if (!res.ok) throw new Error(`jam fetch failed: HTTP ${res.status}`);
  const h = res.text;
  const title = (h.match(/<meta\s+property="og:title"\s+content="([^"]+)"/) || [])[1];
  const description = (h.match(/<meta\s+name="description"\s+content="([^"]+)"/) || [])[1];
  const hostMatch = h.match(/Hosted by\s*<a[^>]*href="https:\/\/([a-z0-9-]+)\.itch\.io\/?"[^>]*>([^<]+)</i);
  const joinedMatch = h.match(/(\d[\d,]*)\s+joined/i);
  const submissionsMatch = h.match(/(\d[\d,]*)\s+submissions?/i);
  const out = {
    source: url,
    slug,
    title: title ? decodeHtml(title) : null,
    description: description ? decodeHtml(description) : null,
    host: hostMatch ? { user: hostMatch[1], name: decodeHtml(hostMatch[2]) } : null,
    joined: joinedMatch ? Number(joinedMatch[1].replace(/,/g, '')) : null,
    submissions: submissionsMatch ? Number(submissionsMatch[1].replace(/,/g, '')) : null,
  };
  writeCache('jam', slug, out);
  printJson(out);
}

async function cmdJamEntries(positional) {
  const auth = getAuthOptional();
  const slug = positional[0];
  if (!slug) throw new Error('jam-entries <slug> required');
  const url = `https://itch.io/jam/${encodeURIComponent(slug)}/entries`;
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  if (!res.ok) throw new Error(`jam-entries fetch failed: HTTP ${res.status}`);
  const games = parseGameCells(res.text);
  const out = { source: url, slug, num_results: games.length, games };
  writeCache('jam-entries', slug, out);
  printJson(out);
}

async function cmdTopic(positional, flags) {
  const auth = getAuthOptional();
  const id = positional[0];
  if (!id) throw new Error('topic <id> required');
  const slug = flags.slug || 'topic';
  const page = Number(flags.page || 1);
  const url = `https://itch.io/t/${id}/${slug}${page > 1 ? `?page=${page}` : ''}`;
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  if (!res.ok) throw new Error(`topic fetch failed: HTTP ${res.status}`);
  const h = res.text;
  const title = (h.match(/<meta\s+property="og:title"\s+content="([^"]+)"/) || [])[1];
  const posts = [];
  const postRe = /<div[^>]*id="post-(\d+)"[\s\S]*?class="[^"]*post_body[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = postRe.exec(h))) {
    posts.push({ post_id: Number(m[1]), body: stripTags(m[2]).slice(0, 2000) });
  }
  const out = {
    source: url,
    topic_id: Number(id),
    title: title ? decodeHtml(title) : null,
    page,
    posts,
  };
  writeCache('topic', id, out);
  printJson(out);
}

async function cmdBoard(positional, flags) {
  const auth = getAuthOptional();
  const id = positional[0];
  if (!id) throw new Error('board <id> required');
  const slug = flags.slug || 'board';
  const page = Number(flags.page || 1);
  const url = `https://itch.io/board/${id}/${slug}${page > 1 ? `?page=${page}` : ''}`;
  const res = await apiFetch(url, { headers: baseHeaders(auth) });
  if (!res.ok) throw new Error(`board fetch failed: HTTP ${res.status}`);
  const h = res.text;
  const title = (h.match(/<meta\s+property="og:title"\s+content="([^"]+)"/) || [])[1];
  const topics = [];
  const topicRe = /<a[^>]*href="\/t\/(\d+)\/([^"]+)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = topicRe.exec(h))) {
    topics.push({ topic_id: Number(m[1]), slug: m[2], title: decodeHtml(m[3]) });
  }
  const out = {
    source: url,
    board_id: Number(id),
    title: title ? decodeHtml(title) : null,
    page,
    topics: topics.slice(0, 100),
  };
  writeCache('board', id, out);
  printJson(out);
}

// ----- dispatch -----
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return;
  }
  const cmd = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'browse':       return cmdBrowse(flags);
    case 'search':       return cmdSearch(positional, flags);
    case 'game':         return cmdGame(positional);
    case 'dev':          return cmdDev(positional);
    case 'comments':     return cmdComments(positional, flags);
    case 'devlog':       return cmdDevlog(positional, flags);
    case 'jam':          return cmdJam(positional);
    case 'jam-entries':  return cmdJamEntries(positional);
    case 'topic':        return cmdTopic(positional, flags);
    case 'board':        return cmdBoard(positional, flags);
    default:
      console.error(`Unknown command: ${cmd}\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`itch-browse error: ${e.message}`);
  process.exit(1);
});
