/**
 * Shared utilities for Realtor.com scrapers.
 *
 * Anti-bot Strategy (Updated 2026-03-22):
 *   Realtor.com uses Kasada bot protection which blocks camoufox and regular
 *   browsers without executing a complex JavaScript proof-of-work challenge.
 *
 *   KEY FINDING: Realtor.com serves full Next.js SSR pages (with __NEXT_DATA__)
 *   to Googlebot without the Kasada challenge. This allows pure HTTP scraping
 *   — no browser automation needed!
 *
 *   Data sources:
 *   1. SEARCH PAGE:
 *      URL: /realestateandhomes-search/{City_ST}/[price-na-N/][beds-N/][baths-N/][pg-N/]
 *      __NEXT_DATA__.props.pageProps.properties — array of listings
 *      __NEXT_DATA__.props.pageProps.totalProperties — total count
 *
 *   2. DETAIL PAGE:
 *      URL: /realestateandhomes-detail/{slug}/
 *      __NEXT_DATA__.props.pageProps.initialReduxState.propertyDetails — full object
 *      (Note: NOT at pageProps.property — Realtor.com uses Redux SSR state)
 *
 *   3. URL format:
 *      City_ST format: "Austin_TX", "San-Francisco_CA", "New-York_NY"
 *      Price: price-na-500000 (max), price-200000-500000 (range)
 *      Beds: beds-2 (min), Baths: baths-1 (min)
 *      Type: type-single-family, type-condos, type-townhomes, type-land
 *      Pagination: pg-2, pg-3
 *
 *   USER AGENT: Googlebot/2.1 (+http://www.google.com/bot.html)
 *   Proxy: optional SOCKS5_PROXY=host:port for residential routing
 */

import { createRequire } from 'module';
import https from 'https';
import http from 'http';
import zlib from 'zlib';
import net from 'net';
import tls from 'tls';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

export function log(...args) {
  process.stderr.write('[realtor] ' + args.join(' ') + '\n');
}

export function emitResult(data) {
  process.stdout.write('RESULT:' + JSON.stringify(data) + '\n');
}

export function emitError(code, message, extra = {}) {
  process.stdout.write('RESULT:' + JSON.stringify({ error: true, code, message, ...extra }) + '\n');
  process.exit(1);
}

export function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// HTTP fetch with SOCKS5 proxy support + Googlebot UA
// ---------------------------------------------------------------------------

const GOOGLEBOT_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

/**
 * Parse SOCKS5 proxy from env.
 */
function getSocksProxy() {
  const s = process.env.SOCKS5_PROXY;
  if (!s) return null;
  const [host, port] = s.split(':');
  return { host, port: parseInt(port, 10) };
}

/**
 * Connect through a SOCKS5 proxy.
 */
function connectSocks5(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(proxy.port, proxy.host);
    sock.once('connect', () => {
      // SOCKS5 greeting
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    sock.once('error', reject);

    let step = 0;
    sock.on('data', (chunk) => {
      if (step === 0) {
        // Auth response: 05 00 = no auth
        if (chunk[0] === 0x05 && chunk[1] === 0x00) {
          step = 1;
          // CONNECT request
          const hostBuf = Buffer.from(targetHost, 'utf8');
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ]);
          sock.write(req);
        } else {
          reject(new Error('SOCKS5 auth failed'));
        }
      } else if (step === 1) {
        // Connect response: 05 00 = success
        if (chunk[0] === 0x05 && chunk[1] === 0x00) {
          sock.removeAllListeners('data');
          resolve(sock);
        } else {
          reject(new Error(`SOCKS5 connect failed: ${chunk[1]}`));
        }
      }
    });
  });
}

/**
 * Fetch a URL via Googlebot UA (+ optional SOCKS5 proxy).
 * Returns the response body as a string.
 */
export async function fetchUrl(url, opts = {}) {
  const parsed = new URL(url);
  const proxy = getSocksProxy();
  const isHttps = parsed.protocol === 'https:';
  const targetPort = parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80);
  const targetHost = parsed.hostname;

  const headers = {
    'User-Agent': GOOGLEBOT_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive',
    ...opts.headers,
  };

  return new Promise(async (resolve, reject) => {
    let socket;

    try {
      if (proxy) {
        const rawSock = await connectSocks5(proxy, targetHost, targetPort);
        if (isHttps) {
          socket = tls.connect({ socket: rawSock, servername: targetHost });
          await new Promise((res, rej) => {
            socket.once('secureConnect', res);
            socket.once('error', rej);
          });
        } else {
          socket = rawSock;
        }
      }
    } catch (e) {
      return reject(new Error(`SOCKS5 connection failed: ${e.message}`));
    }

    const reqOptions = {
      method: opts.method || 'GET',
      hostname: targetHost,
      port: targetPort,
      path: parsed.pathname + parsed.search,
      headers,
    };

    if (socket) reqOptions.socket = socket;
    if (isHttps && !socket) reqOptions.rejectUnauthorized = false;

    const proto = isHttps ? https : http;

    const createRequest = () => {
      if (socket) {
        // Manual HTTP/1.1 over socket
        return new Promise((res2, rej2) => {
          const reqLine = `${reqOptions.method} ${reqOptions.path} HTTP/1.1\r\n`;
          const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
          const extra = `Host: ${targetHost}\r\nConnection: close\r\n`;
          socket.write(reqLine + headerLines + '\r\n' + extra + '\r\n');

          let raw = Buffer.alloc(0);
          socket.on('data', chunk => { raw = Buffer.concat([raw, chunk]); });
          socket.on('end', () => res2(raw));
          socket.on('error', rej2);
        });
      }
      return null;
    };

    if (socket) {
      try {
        const raw = await createRequest();
        // Parse HTTP response manually
        const rawStr = raw.toString('binary');
        const headerEnd = rawStr.indexOf('\r\n\r\n');
        if (headerEnd === -1) return reject(new Error('Invalid HTTP response'));
        
        const headerSection = rawStr.substring(0, headerEnd);
        const lines = headerSection.split('\r\n');
        const statusLine = lines[0];
        const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 0;

        // Check for redirect
        const locationHeader = lines.find(l => l.toLowerCase().startsWith('location:'));
        if (status >= 300 && status < 400 && locationHeader) {
          const newUrl = locationHeader.split(': ')[1]?.trim();
          if (newUrl) {
            socket.destroy();
            return resolve(await fetchUrl(newUrl, opts));
          }
        }

        const body = raw.slice(headerEnd + 4);
        const encodingHeader = lines.find(l => l.toLowerCase().startsWith('content-encoding:'));
        const encoding = encodingHeader ? encodingHeader.split(': ')[1]?.trim() : null;

        if (encoding === 'gzip') {
          zlib.gunzip(body, (err, result) => {
            if (err) reject(err);
            else resolve({ status, body: result.toString('utf8') });
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(body, (err, result) => {
            if (err) reject(err);
            else resolve({ status, body: result.toString('utf8') });
          });
        } else {
          resolve({ status, body: body.toString('utf8') });
        }
      } catch (e) {
        reject(e);
      }
    } else {
      // No proxy — use node's https/http
      const req = proto.request(reqOptions, res => {
        const { statusCode, headers: resHeaders } = res;
        
        if (statusCode >= 300 && statusCode < 400 && resHeaders.location) {
          req.destroy();
          // Resolve relative redirect URLs against the base URL
          const redirectUrl = resHeaders.location.startsWith('http')
            ? resHeaders.location
            : `${parsed.protocol}//${parsed.host}${resHeaders.location}`;
          return resolve(fetchUrl(redirectUrl, opts));
        }

        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const encoding = resHeaders['content-encoding'];
          if (encoding === 'gzip') {
            zlib.gunzip(body, (err, result) => {
              if (err) reject(err);
              else resolve({ status: statusCode, body: result.toString('utf8') });
            });
          } else if (encoding === 'deflate') {
            zlib.inflate(body, (err, result) => {
              if (err) reject(err);
              else resolve({ status: statusCode, body: result.toString('utf8') });
            });
          } else {
            resolve({ status: statusCode, body: body.toString('utf8') });
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    }
  });
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract __NEXT_DATA__ JSON from an HTML string.
 */
export function extractNextDataFromHtml(html) {
  const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    log(`Failed to parse __NEXT_DATA__: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/**
 * Normalise a location string to Realtor.com path format.
 * "Austin, TX" → "Austin_TX"
 * "New York, NY" → "New-York_NY"
 * "90210" → "90210" (zip code)
 * "Austin_TX" → "Austin_TX" (already formatted)
 */
export function normalizeLocation(location) {
  const loc = location.trim();

  // Zip code — pass through
  if (/^\d{5}$/.test(loc)) return loc;

  // Already formatted (contains _)
  if (loc.includes('_')) return loc.replace(/\s+/g, '-');

  // "City, ST" format
  const match = loc.match(/^(.+?),\s*([A-Z]{2})$/i);
  if (match) {
    const city = match[1].trim().replace(/\s+/g, '-');
    const state = match[2].toUpperCase();
    return `${city}_${state}`;
  }

  // Fall back: replace spaces with hyphens
  return loc.replace(/\s+/g, '-');
}

/**
 * Build a Realtor.com search URL with optional filters.
 */
export function buildSearchUrl(options) {
  const {
    location,
    minPrice,
    maxPrice,
    beds,
    baths,
    type,
    page = 1,
  } = options;

  const normalized = normalizeLocation(location);
  let path = `/realestateandhomes-search/${normalized}`;

  // Price filter
  if (minPrice && maxPrice) {
    path += `/price-${minPrice}-${maxPrice}`;
  } else if (minPrice) {
    path += `/price-${minPrice}-na`;
  } else if (maxPrice) {
    path += `/price-na-${maxPrice}`;
  }

  // Beds / baths
  if (beds) path += `/beds-${beds}`;
  if (baths) path += `/baths-${baths}`;

  // Property type
  if (type) {
    const typeMap = {
      house: 'single-family',
      'single-family': 'single-family',
      condo: 'condos',
      condos: 'condos',
      townhome: 'townhomes',
      townhomes: 'townhomes',
      land: 'land',
    };
    const mappedType = typeMap[type.toLowerCase()];
    if (mappedType) path += `/type-${mappedType}`;
  }

  // Pagination
  if (page > 1) path += `/pg-${page}`;

  return `https://www.realtor.com${path}/`;
}

// ---------------------------------------------------------------------------
// Property parsers
// ---------------------------------------------------------------------------

/**
 * Parse a single property from the search results array.
 * Works with __NEXT_DATA__.props.pageProps.properties
 */
export function parseSearchProperty(prop) {
  if (!prop) return null;

  const desc = prop.description || {};
  const loc = prop.location || {};
  const addr = loc.address || {};
  const coordinate = loc.coordinate || {};
  const photos = prop.photos || [];
  const primaryPhoto = prop.primary_photo || {};

  // Price
  const price = prop.list_price ?? prop.price ?? null;

  // Beds / baths / sqft
  const beds = desc.beds ?? desc.beds_min ?? null;
  const baths = desc.baths_consolidated ?? desc.baths ?? desc.baths_full ?? null;
  const sqft = desc.sqft ?? desc.sqft_min ?? null;

  // Address components
  const street = addr.line ?? null;
  const city = addr.city ?? null;
  const state = addr.state_code ?? addr.state ?? null;
  const zip = addr.postal_code ?? null;

  // Type / status
  const propertyType = desc.type ?? prop.sub_type ?? null;
  const listingStatus = prop.status ?? null;

  // Days on market
  const daysOnMarket = prop.list_date
    ? Math.floor((Date.now() - new Date(prop.list_date).getTime()) / (1000 * 60 * 60 * 24))
    : (prop.days_on_market ?? null);

  // URLs
  const slug = prop.permalink ?? null;
  const url = slug ? `https://www.realtor.com/realestateandhomes-detail/${slug}/` : null;

  // Thumbnail
  const thumbnailUrl = primaryPhoto.href ?? (photos[0]?.href) ?? null;

  // Coordinates
  const lat = coordinate.lat ?? null;
  const lng = coordinate.lon ?? null;

  return {
    listingId: String(prop.listing_id ?? prop.property_id ?? ''),
    propertyId: String(prop.property_id ?? ''),
    price,
    beds,
    baths,
    sqft,
    address: { street, city, state, zip },
    propertyType,
    listingStatus,
    daysOnMarket,
    url,
    thumbnailUrl,
    lat,
    lng,
    listingDate: prop.list_date ?? null,
  };
}

/**
 * Parse a full property detail from initialReduxState.propertyDetails
 * (as found on Realtor.com listing detail pages with Googlebot)
 */
export function parseDetailProperty(prop) {
  if (!prop) return null;

  // Start with search-compatible base fields
  const base = parseSearchProperty(prop);

  const desc = prop.description || {};
  const photos = prop.photos || [];
  const details = prop.details || [];
  const agents = prop.advertisers || [];

  // Full description text
  const description = desc.text ?? null;

  // All photo URLs
  const images = photos.map(p => p.href).filter(Boolean);

  // Features — flatten the details array (array of {category, text[]})
  const features = {};
  for (const detail of details) {
    if (detail.category && Array.isArray(detail.text)) {
      features[detail.category] = detail.text;
    }
  }

  // Agent info — take the first listing agent
  let agentName = null;
  let agentPhone = null;
  let agentBrokerage = null;
  for (const agent of agents) {
    if (agent.type === 'seller' || agent.type === 'agent' || agents.length === 1) {
      agentName = agent.name ?? agent.display_name ?? null;
      agentPhone = agent.phones?.[0]?.number ?? agent.phone ?? null;
      agentBrokerage = agent.broker?.name ?? agent.office?.name ?? null;
      break;
    }
  }
  // Fallback: first entry
  if (!agentName && agents.length > 0) {
    const a = agents[0];
    agentName = a.name ?? a.display_name ?? null;
    agentPhone = a.phones?.[0]?.number ?? a.phone ?? null;
    agentBrokerage = a.broker?.name ?? a.office?.name ?? null;
  }

  // Year built / lot size
  const yearBuilt = desc.year_built ?? null;
  const lotSize = desc.lot_sqft ?? desc.lot_size ?? null;

  // HOA
  const hoaFee = prop.hoa?.fee ?? null;

  // Tax info
  const taxHistory = prop.tax_history ?? null;

  // Price history
  const priceHistory = [];
  if (prop.last_price_change_amount != null) {
    priceHistory.push({ amount: prop.last_price_change_amount, event: 'price_reduced' });
  }

  // Nearby schools
  const nearbySchools = (prop.nearby_schools?.schools || []).map(s => ({
    name: s.name,
    rating: s.rating ?? null,
    grades: s.grades ?? null,
    distance: s.distance ?? null,
    type: s.education_levels?.[0] ?? null,
  }));

  return {
    ...base,
    description,
    images,
    features,
    agentName,
    agentPhone,
    agentBrokerage,
    yearBuilt,
    lotSize,
    hoaFee,
    taxHistory,
    priceHistory,
    nearbySchools,
  };
}
