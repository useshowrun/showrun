#!/usr/bin/env node
// salesnav-account-profile.mjs — Fetch comprehensive Sales Navigator account/company profiles
//
// Setup:   node salesnav-account-profile.mjs auth
// Usage:   node salesnav-account-profile.mjs view <companyId> [--sections=basic,iq,employees,alerts]
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-account-profile');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, data) {
  ensureDir(resolve(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// CDP integration
// ---------------------------------------------------------------------------

function findCdpScript() {
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(new URL('.', import.meta.url).pathname, '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Sales Navigator tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('linkedin.com/sales')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('linkedin.com')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No LinkedIn/Sales Navigator tab found.');

  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.linkedin.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const cookieStr = cookies
    .filter(c => c.domain.includes('linkedin.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const csrfToken = (cookieMap['JSESSIONID'] || '').replace(/"/g, '');
  if (!csrfToken) throw new Error('JSESSIONID not found. Are you logged in?');
  if (!cookieMap['li_at']) throw new Error('li_at cookie not found. Are you logged in?');

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// REST-li decoration strings must be percent-encoded for the decoration= query param
function encodeDecoration(str) {
  return str
    .replace(/%/g, '%25').replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/,/g, '%2C').replace(/\*/g, '%2A').replace(/~/g, '%7E')
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/ /g, '%20');
}

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node salesnav-account-profile.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'csrf-token': auth.csrfToken,
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url) {
  const resp = await fetch(url, { headers: baseHeaders(auth) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node salesnav-account-profile.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/** Accept numeric ID or full URN, return numeric company ID. */
function parseCompanyId(input) {
  if (!input) return null;
  // urn:li:fs_salesCompany:1035 -> 1035
  const urnMatch = input.match(/fs_salesCompany:(\d+)/);
  if (urnMatch) return urnMatch[1];
  // urn:li:organization:1035 -> 1035
  const orgMatch = input.match(/organization:(\d+)/);
  if (orgMatch) return orgMatch[1];
  // Plain numeric
  if (/^\d+$/.test(input)) return input;
  console.error(`Invalid company ID: ${input}. Use a numeric ID (e.g., 1035) or URN.`);
  process.exit(1);
}

function companyUrn(id) {
  return `urn:li:fs_salesCompany:${id}`;
}

// ---------------------------------------------------------------------------
// API: Company main data
// ---------------------------------------------------------------------------

const COMPANY_DECORATION = encodeDecoration(
  '(entityUrn,name,account(saved,noteCount,listCount,crmStatus),' +
  'pictureInfo,companyPictureDisplayImage,industry,location,' +
  'employeeCount,employeeDisplayCount,employeeCountRange,' +
  'decisionMakersDisplayCount,personaResultCounts,' +
  'description,website,flagshipCompanyUrl,revenue,' +
  'employeeGrowthPercentages,employeeCountInfo)');

async function fetchCompanyMain(auth, companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiCompanies/${companyId}?decoration=${COMPANY_DECORATION}`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// API: Account IQ dossier
// ---------------------------------------------------------------------------

async function fetchAccountIQ(auth, companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiAccountDossier/${companyId}?accountIQUseCase=SALES_NAVIGATOR`;
  try {
    return await apiFetch(auth, url);
  } catch (err) {
    if (err.message.includes('404')) {
      console.warn(`Account IQ not available for company ${companyId} (404).`);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API: Employee insights
// ---------------------------------------------------------------------------

async function fetchEmployeeInsights(auth, companyId) {
  const [total, functional] = await Promise.all([
    apiFetch(auth, `https://www.linkedin.com/sales-api/salesApiEmployeeInsights/${companyId}?employeeInsightType=TOTAL_HEADCOUNT`),
    apiFetch(auth, `https://www.linkedin.com/sales-api/salesApiEmployeeInsights/${companyId}?employeeInsightType=FUNCTIONAL_HEADCOUNT`),
  ]);
  return { totalHeadcount: total, functionalHeadcount: functional };
}

// ---------------------------------------------------------------------------
// API: Relationship maps
// ---------------------------------------------------------------------------

async function fetchRelationshipMaps(auth, companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiRelationshipMaps?q=account&organizationId=${companyId}&count=20`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// API: Entity alerts
// ---------------------------------------------------------------------------

async function fetchAlerts(auth, companyId) {
  const urn = encodeURIComponent(companyUrn(companyId));
  const url = `https://www.linkedin.com/sales-api/salesApiEntityAlerts?q=criteria&entityUrn=${urn}&sortBy=TIME&start=0&count=20`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// API: Similar / also viewed companies
// ---------------------------------------------------------------------------

const ALSO_VIEWED_DECORATION = encodeDecoration(
  '(companiesAlsoViewed*~fs_salesCompany(entityUrn,name,industry,companyPictureDisplayImage,employeeCountRange))');

async function fetchSimilarCompanies(auth, companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiCompanyAlsoViewed/${companyId}?decoration=${ALSO_VIEWED_DECORATION}`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// API: Notes
// ---------------------------------------------------------------------------

async function fetchNotes(auth, companyId) {
  const urn = encodeURIComponent(companyUrn(companyId));
  const url = `https://www.linkedin.com/sales-api/salesApiEntityNote?count=20&entityUrn=${urn}&q=entity&start=0&visibility=ALL`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// API: Personas
// ---------------------------------------------------------------------------

async function fetchPersonas(auth, companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiPersonas?q=seat&targetCompanyId=${companyId}&decorationId=com.linkedin.sales.deco.desktop.common.Persona-3`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// View: comprehensive profile with optional section filtering
// ---------------------------------------------------------------------------

const ALL_SECTIONS = ['basic', 'iq', 'employees', 'alerts', 'similar', 'notes', 'personas', 'relationship-map'];

async function viewCompany(auth, companyId, sections) {
  const result = {};

  const fetchers = {
    'basic': async () => { result.company = await fetchCompanyMain(auth, companyId); },
    'iq': async () => { result.accountIQ = await fetchAccountIQ(auth, companyId); },
    'employees': async () => { result.employees = await fetchEmployeeInsights(auth, companyId); },
    'alerts': async () => { result.alerts = await fetchAlerts(auth, companyId); },
    'similar': async () => { result.similar = await fetchSimilarCompanies(auth, companyId); },
    'notes': async () => { result.notes = await fetchNotes(auth, companyId); },
    'personas': async () => { result.personas = await fetchPersonas(auth, companyId); },
    'relationship-map': async () => { result.relationshipMaps = await fetchRelationshipMaps(auth, companyId); },
  };

  const tasks = sections.map(s => {
    const fn = fetchers[s];
    if (!fn) {
      console.warn(`Unknown section: ${s}. Valid: ${ALL_SECTIONS.join(', ')}`);
      return Promise.resolve();
    }
    return fn().catch(err => {
      console.warn(`Failed to fetch section "${s}": ${err.message}`);
    });
  });

  await Promise.all(tasks);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) flags[match[1]] = match[2];
    else positional.push(arg);
  }
  return { flags, positional };
}

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'view': {
    const { flags, positional } = parseFlags(args);
    const companyId = parseCompanyId(positional[0]);
    if (!companyId) {
      console.error('Usage: node salesnav-account-profile.mjs view <companyId> [--sections=basic,iq,employees,alerts,similar,notes,personas,relationship-map]');
      process.exit(1);
    }

    const sections = flags.sections ? flags.sections.split(',').map(s => s.trim()) : ALL_SECTIONS;
    const auth = getAuth();

    console.log(`Fetching company ${companyId} (sections: ${sections.join(', ')})...`);
    const result = await viewCompany(auth, companyId, sections);

    const outFile = resolve(CACHE_DIR, `company-${companyId}.json`);
    saveJson(outFile, result);
    console.log(`Saved to: ${outFile}`);

    // Print summary
    if (result.company) {
      const c = result.company;
      console.log(`\n${c.name || 'Unknown'}`);
      if (c.industry) console.log(`  Industry: ${c.industry}`);
      if (c.location) console.log(`  Location: ${c.location}`);
      if (c.employeeDisplayCount) console.log(`  Employees: ${c.employeeDisplayCount}`);
      if (c.website) console.log(`  Website: ${c.website}`);
      if (c.account) {
        const a = c.account;
        console.log(`  Saved: ${a.saved || false}, Notes: ${a.noteCount || 0}, Lists: ${a.listCount || 0}`);
      }
    }
    if (result.accountIQ) {
      console.log('\n  Account IQ available');
      if (result.accountIQ.strategicPriorities?.length) {
        console.log(`    Strategic priorities: ${result.accountIQ.strategicPriorities.length}`);
      }
      if (result.accountIQ.challenges?.length) {
        console.log(`    Challenges: ${result.accountIQ.challenges.length}`);
      }
      if (result.accountIQ.annualRevenue) {
        console.log(`    Annual revenue: ${JSON.stringify(result.accountIQ.annualRevenue)}`);
      }
    }
    if (result.alerts?.elements?.length) {
      console.log(`\n  Alerts: ${result.alerts.elements.length}`);
    }
    if (result.similar?.elements?.length) {
      console.log(`  Similar companies: ${result.similar.elements.length}`);
    }
    break;
  }

  case 'account-iq': {
    const companyId = parseCompanyId(args[0]);
    if (!companyId) {
      console.error('Usage: node salesnav-account-profile.mjs account-iq <companyId>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching Account IQ dossier for company ${companyId}...`);
    const data = await fetchAccountIQ(auth, companyId);

    if (!data) {
      console.log('Account IQ not available for this company.');
      break;
    }

    const outFile = resolve(CACHE_DIR, `account-iq-${companyId}.json`);
    saveJson(outFile, data);
    console.log(`Saved to: ${outFile}`);

    // Print summary
    if (data.cxoSummary) console.log(`\nCXO Summary: ${data.cxoSummary?.summary || JSON.stringify(data.cxoSummary)}`);
    if (data.strategicPriorities?.length) {
      console.log(`\nStrategic Priorities (${data.strategicPriorities.length}):`);
      for (const p of data.strategicPriorities) console.log(`  - ${typeof p === 'string' ? p : JSON.stringify(p)}`);
    }
    if (data.challenges?.length) {
      console.log(`\nChallenges (${data.challenges.length}):`);
      for (const c of data.challenges) console.log(`  - ${typeof c === 'string' ? c : JSON.stringify(c)}`);
    }
    if (data.annualRevenue) console.log(`\nAnnual Revenue: ${JSON.stringify(data.annualRevenue)}`);
    if (data.quarterRevenue) console.log(`Quarter Revenue: ${JSON.stringify(data.quarterRevenue)}`);
    if (data.competitorDetails?.length) {
      console.log(`\nCompetitors: ${data.competitorDetails.map(c => c.name || JSON.stringify(c)).join(', ')}`);
    }
    break;
  }

  case 'employees': {
    const companyId = parseCompanyId(args[0]);
    if (!companyId) {
      console.error('Usage: node salesnav-account-profile.mjs employees <companyId>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching employee insights for company ${companyId}...`);
    const data = await fetchEmployeeInsights(auth, companyId);

    const outFile = resolve(CACHE_DIR, `employees-${companyId}.json`);
    saveJson(outFile, data);
    console.log(`Saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'relationship-map': {
    const companyId = parseCompanyId(args[0]);
    if (!companyId) {
      console.error('Usage: node salesnav-account-profile.mjs relationship-map <companyId>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching relationship maps for company ${companyId}...`);
    const data = await fetchRelationshipMaps(auth, companyId);

    const outFile = resolve(CACHE_DIR, `relationship-map-${companyId}.json`);
    saveJson(outFile, data);
    console.log(`Saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'alerts': {
    const companyId = parseCompanyId(args[0]);
    if (!companyId) {
      console.error('Usage: node salesnav-account-profile.mjs alerts <companyId>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching alerts for company ${companyId}...`);
    const data = await fetchAlerts(auth, companyId);

    const outFile = resolve(CACHE_DIR, `alerts-${companyId}.json`);
    saveJson(outFile, data);
    console.log(`Saved to: ${outFile}`);

    const elements = data.elements || [];
    console.log(`\n${elements.length} alerts:`);
    for (const alert of elements) {
      console.log(`  - ${alert.headline?.text || alert.type || JSON.stringify(alert).substring(0, 120)}`);
    }
    break;
  }

  case 'similar': {
    const companyId = parseCompanyId(args[0]);
    if (!companyId) {
      console.error('Usage: node salesnav-account-profile.mjs similar <companyId>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching similar companies for company ${companyId}...`);
    const data = await fetchSimilarCompanies(auth, companyId);

    const outFile = resolve(CACHE_DIR, `similar-${companyId}.json`);
    saveJson(outFile, data);
    console.log(`Saved to: ${outFile}`);

    const elements = data.elements || [];
    console.log(`\n${elements.length} similar companies:`);
    for (const co of elements) {
      console.log(`  - ${co.name || '?'} (${co.industry || '?'}, ${co.employeeDisplayCount || '?'} employees)`);
    }
    break;
  }

  case 'notes': {
    const companyId = parseCompanyId(args[0]);
    if (!companyId) {
      console.error('Usage: node salesnav-account-profile.mjs notes <companyId>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching notes for company ${companyId}...`);
    const data = await fetchNotes(auth, companyId);

    const outFile = resolve(CACHE_DIR, `notes-${companyId}.json`);
    saveJson(outFile, data);
    console.log(`Saved to: ${outFile}`);

    const elements = data.elements || [];
    console.log(`\n${elements.length} notes:`);
    for (const note of elements) {
      const preview = (note.body || note.text || JSON.stringify(note)).substring(0, 100);
      console.log(`  - ${preview}`);
    }
    break;
  }

  case 'personas': {
    const companyId = parseCompanyId(args[0]);
    if (!companyId) {
      console.error('Usage: node salesnav-account-profile.mjs personas <companyId>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching personas for company ${companyId}...`);
    const data = await fetchPersonas(auth, companyId);

    const outFile = resolve(CACHE_DIR, `personas-${companyId}.json`);
    saveJson(outFile, data);
    console.log(`Saved to: ${outFile}`);

    const elements = data.elements || [];
    console.log(`\n${elements.length} personas:`);
    for (const persona of elements) {
      console.log(`  - ${persona.personaName || JSON.stringify(persona).substring(0, 100)}`);
    }
    break;
  }

  default:
    console.log(`salesnav-account-profile — Fetch comprehensive Sales Navigator account/company profiles

Commands:
  auth                                          Authenticate via Chrome (one-time)
  view <companyId> [--sections=...]             Fetch full company profile (all sections)
  account-iq <companyId>                        Fetch AI-generated Account IQ dossier
  employees <companyId>                         Fetch employee insights (headcount, functional)
  relationship-map <companyId>                  Fetch relationship maps
  alerts <companyId>                            Fetch entity alerts/signals
  similar <companyId>                           Fetch similar/also-viewed companies
  notes <companyId>                             Fetch notes on this account
  personas <companyId>                          Fetch buyer personas for this company

Sections for 'view' command (comma-separated):
  basic, iq, employees, alerts, similar, notes, personas, relationship-map
  Default: all sections

Company ID formats:
  1035                                          Numeric company ID
  urn:li:fs_salesCompany:1035                   Sales Nav URN
  urn:li:organization:1035                      Organization URN

Examples:
  node salesnav-account-profile.mjs auth
  node salesnav-account-profile.mjs view 1035
  node salesnav-account-profile.mjs view 1035 --sections=basic,iq,employees
  node salesnav-account-profile.mjs account-iq 1035
  node salesnav-account-profile.mjs employees 1035

Data: ${DATA_DIR}/
  session.json       Auth cookies
  cache/             Cached API responses`);
}
