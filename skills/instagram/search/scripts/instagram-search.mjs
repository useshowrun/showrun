#!/usr/bin/env node
// instagram-search.mjs — Instagram top search (users, hashtags, places)
//
// Commands:
//   node instagram-search.mjs top <query>           Blended search (users + hashtags + places)
//   node instagram-search.mjs users <query>         Users-only filter
//   node instagram-search.mjs hashtags <query>      Hashtags-only filter
//   node instagram-search.mjs places <query>        Places-only filter
//
// Runs the same GraphQL query as the instagram.com search box
// (PolarisSearchBoxRefetchableQuery -> xdt_api__v1__fbsearch__topsearch_connection)
// inside the logged-in Chrome tab. See ../../_shared/instagram-fetch.mjs.

import { resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  CACHE_DIR, ensureDir, saveJson, igGraphql, rememberUserPk, InstagramStopError,
} from '../../_shared/instagram-fetch.mjs';

// PolarisSearchConstants.SEARCH_CONTEXT in the web app. Places are not a
// topsearch context (context "location" fails with a server field_exception
// and blended results rarely carry places on web); the web app's location
// search uses PolarisAPILocationSearchQuery instead — see placeSearch().
const CONTEXTS = { top: 'blended', users: 'user', hashtags: 'hashtag' };

function topsearch(query, context) {
  const data = igGraphql('PolarisSearchBoxRefetchableQuery', {
    data: {
      context,
      include_reel: 'true',
      query,
      rank_token: '',
      search_session_id: randomUUID(),
      search_surface: 'web_top_search',
    },
    hasQuery: true,
  });
  const conn = data.xdt_api__v1__fbsearch__topsearch_connection;
  if (!conn) throw new Error('Search returned no results object');
  return conn;
}

// Same request as PolarisAPILocationSearch in the web app (no coordinates =
// global text search). Returns Facebook place pages, not IG location pks.
function placeSearch(query) {
  const data = igGraphql('PolarisAPILocationSearchQuery', {
    request: { latitude: null, longitude: null, search_query: query },
  });
  return data.ig_place_search?.meta_places || [];
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

// The web search query does not return is_private / follower_count; those
// keys stay null so the output shape matches the old REST version.
function formatUserHit(entry) {
  const u = entry.user || entry;
  return {
    id: u.pk || u.id,
    username: u.username,
    full_name: u.full_name,
    is_private: u.is_private ?? null,
    is_verified: u.is_verified,
    profile_pic_url: u.hd_profile_pic_url_info?.url || u.profile_pic_url,
    follower_count: u.follower_count ?? null,
    social_context: u.search_social_context || null,
    position: entry.position,
  };
}

function formatHashtagHit(entry) {
  const h = entry.hashtag || entry;
  return {
    id: h.id,
    name: h.name,
    media_count: h.media_count,
    subtitle: h.search_result_subtitle || null,
    position: entry.position,
  };
}

function formatPlaceHit(entry) {
  const p = entry.place || entry;
  return {
    id: p.location?.pk || p.pk,
    title: p.title,
    subtitle: p.subtitle,
    name: p.location?.name,
    facebook_places_id: p.location?.facebook_places_id || null,
    lat: p.location?.lat ?? null,
    lng: p.location?.lng ?? null,
    city: p.location?.city ?? null,
    address: p.location?.address ?? null,
    position: entry.position,
  };
}

// ig_place_search meta_places entry -> same keys as formatPlaceHit.
function formatMetaPlace(p, position) {
  // subtitle is "<distance from viewer> · <address>"; keep just the address.
  const address = String(p.subtitle || '').replace(/^\s*[<~]?[\d.,]+\s?(?:mi|km|m|ft)\b\s*(?:·\s*)?/, '').trim() || null;
  return {
    id: null, // no IG location pk on this surface
    title: p.name,
    subtitle: p.subtitle || null,
    name: p.name,
    facebook_places_id: p.best_page_fbid || null,
    lat: p.latitude ?? null,
    lng: p.longitude ?? null,
    city: null,
    address,
    position,
  };
}

function cacheIds(users) {
  for (const u of users) if (u.username && u.id) rememberUserPk(u.username, u.id);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdTop(query) {
  if (!query) { console.error('Usage: top <query>'); process.exit(1); }
  const conn = topsearch(query, CONTEXTS.top);
  const result = {
    users: (conn.users || []).map(formatUserHit),
    hashtags: (conn.hashtags || []).map(formatHashtagHit),
    places: (conn.places || []).map(formatPlaceHit),
  };
  cacheIds(result.users);
  saveJson(resolve(CACHE_DIR, `search-${query.toLowerCase().replace(/\W+/g, '_')}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

function cmdScoped(query, scope) {
  if (!query) { console.error(`Usage: ${scope} <query>`); process.exit(1); }
  let result;
  if (scope === 'places') {
    result = { places: placeSearch(query).map(formatMetaPlace) };
  } else {
    const conn = topsearch(query, CONTEXTS[scope]);
    if (scope === 'users') {
      result = { users: (conn.users || []).map(formatUserHit) };
      cacheIds(result.users);
    } else result = { hashtags: (conn.hashtags || []).map(formatHashtagHit) };
  }
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : 'true';
    else positional.push(arg);
  }
  return { flags, positional };
}

function printUsage() {
  console.log(`instagram-search — Instagram top search

Commands:
  top <query>        Blended (users + hashtags + places)
  users <query>      Users only
  hashtags <query>   Hashtags only
  places <query>     Places only

Requests run inside the logged-in instagram.com tab in Chrome (chrome-cdp).`);
}

function main() {
  const { positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];
  const arg1 = positional.slice(1).join(' ');

  ensureDir(CACHE_DIR);

  try {
    switch (command) {
      case 'top':       cmdTop(arg1); break;
      case 'users':     cmdScoped(arg1, 'users'); break;
      case 'hashtags':  cmdScoped(arg1, 'hashtags'); break;
      case 'places':    cmdScoped(arg1, 'places'); break;
      default: printUsage();
    }
  } catch (err) {
    if (err instanceof InstagramStopError) console.error(`STOP: ${err.message}`);
    else console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
