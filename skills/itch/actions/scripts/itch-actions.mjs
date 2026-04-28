#!/usr/bin/env node
// itch-actions.mjs — itch.io mutations (dry-run by default).
//
// All mutations default to DRY-RUN. Pass --live to actually send.
// You can also set ITCH_DRY_RUN=0 to force live mode, or ITCH_DRY_RUN=1 to force dry.
//
// Commands:
//   follow <username> [--source=<s>]
//   unfollow <username> [--source=<s>]
//   like-event <event_id>
//   unlike-event <event_id>
//   rate <dev/slug> --stars=N [--blurb="..."]
//   comment <topic_id> "<body>" [--no-subscribe]
//   vote <post_id> --dir=up|down
//   download <dev/slug> [--upload-id=<id>]
//   add-to-collection <dev/slug> --collection=<id>
//   add-to-collection <dev/slug> --new="My Collection" [--blurb=...] [--private]
//
// Flags:
//   --live            actually perform the mutation (otherwise dry-run)

import {
  apiFetch, baseHeaders, getAuth, parseArgs, parseGameSlug, parseUserSlug,
  postForm, printJson, dryRunEnabled,
} from '../../lib/itch-lib.mjs';

const HELP = `Usage: itch-actions <command> [args] [--live]
  follow <username> [--source=profile]
  unfollow <username> [--source=profile]
  like-event <event_id>
  unlike-event <event_id>
  rate <dev/slug> --stars=N [--blurb="..."]
  comment <topic_id> "<body>" [--no-subscribe]
  vote <post_id> --dir=up|down
  download <dev/slug> [--upload-id=<id>]
  add-to-collection <dev/slug> --collection=<id>
  add-to-collection <dev/slug> --new="Title" [--blurb=...] [--private]

Safety: mutations default to DRY-RUN. Add --live to actually perform the action.
`;

async function cmdFollow(positional, flags, argv) {
  const auth = getAuth();
  const user = parseUserSlug(positional[0]);
  const url = `https://itch.io/g/${encodeURIComponent(user)}/-/follow`;
  const res = await postForm(auth, url, { source: flags.source || 'profile' }, {
    referer: `https://itch.io/profile/${user}`,
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'follow', user, status: res.status, data: res.data });
}

async function cmdUnfollow(positional, flags, argv) {
  const auth = getAuth();
  const user = parseUserSlug(positional[0]);
  const url = `https://itch.io/g/${encodeURIComponent(user)}/-/unfollow`;
  const res = await postForm(auth, url, { source: flags.source || 'profile' }, {
    referer: `https://itch.io/profile/${user}`,
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'unfollow', user, status: res.status, data: res.data });
}

async function cmdLikeEvent(positional, _flags, argv) {
  const auth = getAuth();
  const id = positional[0];
  if (!id) throw new Error('event_id required');
  const url = `https://itch.io/event/${encodeURIComponent(id)}/like`;
  const res = await postForm(auth, url, {}, {
    referer: 'https://itch.io/my-feed',
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'like-event', event_id: id, status: res.status, data: res.data });
}

async function cmdUnlikeEvent(positional, _flags, argv) {
  const auth = getAuth();
  const id = positional[0];
  if (!id) throw new Error('event_id required');
  const url = `https://itch.io/event/${encodeURIComponent(id)}/unlike`;
  const res = await postForm(auth, url, {}, {
    referer: 'https://itch.io/my-feed',
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'unlike-event', event_id: id, status: res.status, data: res.data });
}

async function cmdRate(positional, flags, argv) {
  const auth = getAuth();
  const { dev, slug, url } = parseGameSlug(positional[0]);
  const stars = Number(flags.stars);
  if (!stars || stars < 1 || stars > 5) throw new Error('--stars=1..5 required');
  const rateUrl = `${url}/rate`;
  const res = await postForm(auth, rateUrl, {
    game_rating: String(stars),
    game_rating_blurb: flags.blurb || '',
  }, {
    referer: url,
    origin: `https://${dev}.itch.io`,
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'rate', dev, slug, stars, blurb: flags.blurb || null, status: res.status, data: res.data });
}

async function cmdComment(positional, flags, argv) {
  const auth = getAuth();
  const topicId = positional[0];
  const body = positional[1];
  if (!topicId || !body) throw new Error('comment <topic_id> "<body>" required');
  const url = `https://itch.io/topic/${encodeURIComponent(topicId)}/new-post`;
  const subscribe = flags['no-subscribe'] ? '0' : '1';
  const res = await postForm(auth, url, {
    'post[body]': body,
    subscribe,
  }, {
    referer: `https://itch.io/t/${topicId}/reply`,
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'comment', topic_id: topicId, status: res.status, data: res.data });
}

async function cmdVote(positional, flags, argv) {
  const auth = getAuth();
  const postId = positional[0];
  if (!postId) throw new Error('post_id required');
  const dir = (flags.dir || 'up').toLowerCase();
  if (dir !== 'up' && dir !== 'down') throw new Error('--dir=up|down required');
  const url = `https://itch.io/vote/post/${encodeURIComponent(postId)}`;
  const res = await postForm(auth, url, { direction: dir }, {
    referer: 'https://itch.io/',
    origin: 'https://itch.io',
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'vote', post_id: postId, direction: dir, status: res.status, data: res.data });
}

async function cmdDownload(positional, flags, argv) {
  const auth = getAuth();
  const { dev, slug, url } = parseGameSlug(positional[0]);
  let uploadId = flags['upload-id'];

  // Auto-discover first upload_id from the game page if not given
  if (!uploadId) {
    const pageRes = await apiFetch(url, { headers: baseHeaders(auth) });
    if (!pageRes.ok) throw new Error(`Failed to fetch game page: HTTP ${pageRes.status}`);
    const m = pageRes.text.match(/data-upload_id="(\d+)"/);
    if (!m) throw new Error('No data-upload_id found on the game page. Pass --upload-id=<id> explicitly.');
    uploadId = m[1];
    console.error(`[auto] upload_id=${uploadId}`);
  }

  const dlUrl = `${url}/file/${encodeURIComponent(uploadId)}?source=view_game&after_download_lightbox=true`;
  const res = await postForm(auth, dlUrl, {}, {
    referer: url,
    origin: `https://${dev}.itch.io`,
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'download', dev, slug, upload_id: uploadId, status: res.status, data: res.data });
}

async function cmdAddToCollection(positional, flags, argv) {
  const auth = getAuth();
  const { dev, slug, url } = parseGameSlug(positional[0]);
  const collectionId = flags.collection;
  const newTitle = flags.new;
  if (!collectionId && !newTitle) throw new Error('--collection=<id> or --new="Title" required');
  const addUrl = `${url}/add-to-collection`;
  const fields = {};
  if (collectionId) {
    fields.add_to = String(collectionId);
  } else {
    fields.add_to = 'new';
    fields['collection[title]'] = newTitle;
    if (flags.blurb) fields['collection[blurb]'] = flags.blurb;
    if (flags.private) fields['collection[private]'] = '1';
  }
  const res = await postForm(auth, addUrl, fields, {
    referer: url,
    origin: `https://${dev}.itch.io`,
    dryRun: dryRunEnabled(argv),
  });
  printJson({ action: 'add-to-collection', dev, slug, collection: collectionId || newTitle, status: res.status, data: res.data });
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
    case 'follow':             return cmdFollow(positional, flags, argv);
    case 'unfollow':           return cmdUnfollow(positional, flags, argv);
    case 'like-event':         return cmdLikeEvent(positional, flags, argv);
    case 'unlike-event':       return cmdUnlikeEvent(positional, flags, argv);
    case 'rate':               return cmdRate(positional, flags, argv);
    case 'comment':            return cmdComment(positional, flags, argv);
    case 'vote':               return cmdVote(positional, flags, argv);
    case 'download':           return cmdDownload(positional, flags, argv);
    case 'add-to-collection':  return cmdAddToCollection(positional, flags, argv);
    default:
      console.error(`Unknown command: ${cmd}\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`itch-actions error: ${e.message}`);
  process.exit(1);
});
