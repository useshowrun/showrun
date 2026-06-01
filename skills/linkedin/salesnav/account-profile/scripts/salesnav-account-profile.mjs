#!/usr/bin/env node
// salesnav-account-profile.mjs — Fetch comprehensive Sales Navigator account/company profiles
//
// Setup:   node salesnav-account-profile.mjs auth
// Usage:   node salesnav-account-profile.mjs view <companyId> [--sections=basic,iq,employees,alerts]
//
// Requires Node 22+ and the chrome-cdp skill. Requests run inside your logged-in
// Chrome tab (via CDP), so keep a Sales Navigator tab open.

import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { apiFetch, doAuth as cdpDoAuth, requireAuth } from '../../_shared/salesnav-cdp.mjs';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-account-profile');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const AUTH_CMD = 'node salesnav-account-profile.mjs auth';

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
// HTTP helpers
// ---------------------------------------------------------------------------

// REST-li decoration strings must be percent-encoded for the decoration= query param
function encodeDecoration(str) {
  return str
    .replace(/%/g, '%25').replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/,/g, '%2C').replace(/\*/g, '%2A').replace(/~/g, '%7E')
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/ /g, '%20');
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

// Primary fetch — fatal on error (if the company itself can't be loaded, the
// whole view should fail clearly rather than return a hollow result).
async function fetchCompanyMain(companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiCompanies/${companyId}?decoration=${COMPANY_DECORATION}`;
  return apiFetch(url, {}, { authCmd: AUTH_CMD });
}

// ---------------------------------------------------------------------------
// API: Account IQ dossier
// ---------------------------------------------------------------------------

// Optional sections use softErrors so a per-section HTTP failure throws (caught
// below / by viewCompany) instead of aborting the process.
async function fetchAccountIQ(companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiAccountDossier/${companyId}?accountIQUseCase=SALES_NAVIGATOR`;
  try {
    return await apiFetch(url, {}, { authCmd: AUTH_CMD, softErrors: true });
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

async function fetchEmployeeInsights(companyId) {
  const total = await apiFetch(`https://www.linkedin.com/sales-api/salesApiEmployeeInsights/${companyId}?employeeInsightType=TOTAL_HEADCOUNT`, {}, { authCmd: AUTH_CMD, softErrors: true });
  const functional = await apiFetch(`https://www.linkedin.com/sales-api/salesApiEmployeeInsights/${companyId}?employeeInsightType=FUNCTIONAL_HEADCOUNT`, {}, { authCmd: AUTH_CMD, softErrors: true });
  return { totalHeadcount: total, functionalHeadcount: functional };
}

// ---------------------------------------------------------------------------
// API: Relationship maps
// ---------------------------------------------------------------------------

async function fetchRelationshipMaps(companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiRelationshipMaps?q=account&organizationId=${companyId}&count=20`;
  return apiFetch(url, {}, { authCmd: AUTH_CMD, softErrors: true });
}

// ---------------------------------------------------------------------------
// API: Entity alerts
// ---------------------------------------------------------------------------

async function fetchAlerts(companyId) {
  const urn = encodeURIComponent(companyUrn(companyId));
  const url = `https://www.linkedin.com/sales-api/salesApiEntityAlerts?q=criteria&entityUrn=${urn}&sortBy=TIME&start=0&count=20`;
  return apiFetch(url, {}, { authCmd: AUTH_CMD, softErrors: true });
}

// ---------------------------------------------------------------------------
// API: Similar / also viewed companies
// ---------------------------------------------------------------------------

const ALSO_VIEWED_DECORATION = encodeDecoration(
  '(companiesAlsoViewed*~fs_salesCompany(entityUrn,name,industry,companyPictureDisplayImage,employeeCountRange))');

async function fetchSimilarCompanies(companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiCompanyAlsoViewed/${companyId}?decoration=${ALSO_VIEWED_DECORATION}`;
  return apiFetch(url, {}, { authCmd: AUTH_CMD, softErrors: true });
}

// ---------------------------------------------------------------------------
// API: Notes
// ---------------------------------------------------------------------------

async function fetchNotes(companyId) {
  const urn = encodeURIComponent(companyUrn(companyId));
  const url = `https://www.linkedin.com/sales-api/salesApiEntityNote?count=20&entityUrn=${urn}&q=entity&start=0&visibility=ALL`;
  return apiFetch(url, {}, { authCmd: AUTH_CMD, softErrors: true });
}

// ---------------------------------------------------------------------------
// API: Personas
// ---------------------------------------------------------------------------

async function fetchPersonas(companyId) {
  const url = `https://www.linkedin.com/sales-api/salesApiPersonas?q=seat&targetCompanyId=${companyId}&decorationId=com.linkedin.sales.deco.desktop.common.Persona-3`;
  return apiFetch(url, {}, { authCmd: AUTH_CMD, softErrors: true });
}

// ---------------------------------------------------------------------------
// View: comprehensive profile with optional section filtering
// ---------------------------------------------------------------------------

const ALL_SECTIONS = ['basic', 'iq', 'employees', 'alerts', 'similar', 'notes', 'personas', 'relationship-map'];

// Sections are fetched sequentially; each is wrapped so a soft per-section
// failure is logged and skipped rather than aborting the whole view.
async function viewCompany(companyId, sections) {
  const result = {};

  const fetchers = {
    'basic': async () => { result.company = await fetchCompanyMain(companyId); },
    'iq': async () => { result.accountIQ = await fetchAccountIQ(companyId); },
    'employees': async () => { result.employees = await fetchEmployeeInsights(companyId); },
    'alerts': async () => { result.alerts = await fetchAlerts(companyId); },
    'similar': async () => { result.similar = await fetchSimilarCompanies(companyId); },
    'notes': async () => { result.notes = await fetchNotes(companyId); },
    'personas': async () => { result.personas = await fetchPersonas(companyId); },
    'relationship-map': async () => { result.relationshipMaps = await fetchRelationshipMaps(companyId); },
  };

  for (const s of sections) {
    const fn = fetchers[s];
    if (!fn) {
      console.warn(`Unknown section: ${s}. Valid: ${ALL_SECTIONS.join(', ')}`);
      continue;
    }
    try {
      await fn();
    } catch (err) {
      console.warn(`Failed to fetch section "${s}": ${err.message}`);
    }
  }

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
    cdpDoAuth(SESSION_FILE, saveJson);
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
    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);

    console.log(`Fetching company ${companyId} (sections: ${sections.join(', ')})...`);
    const result = await viewCompany(companyId, sections);

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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching Account IQ dossier for company ${companyId}...`);
    const data = await fetchAccountIQ(companyId);

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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching employee insights for company ${companyId}...`);
    const data = await fetchEmployeeInsights(companyId);

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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching relationship maps for company ${companyId}...`);
    const data = await fetchRelationshipMaps(companyId);

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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching alerts for company ${companyId}...`);
    const data = await fetchAlerts(companyId);

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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching similar companies for company ${companyId}...`);
    const data = await fetchSimilarCompanies(companyId);

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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching notes for company ${companyId}...`);
    const data = await fetchNotes(companyId);

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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching personas for company ${companyId}...`);
    const data = await fetchPersonas(companyId);

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
