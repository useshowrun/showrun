#!/usr/bin/env node
// yahoofinance-financials.mjs — Fetch income statement, balance sheet, and cash flow data from Yahoo Finance
//
// Setup (one-time, requires Chrome with Yahoo Finance open):
//   node yahoofinance-financials.mjs auth
//
// Usage:
//   node yahoofinance-financials.mjs income AAPL
//   node yahoofinance-financials.mjs income AAPL --period=quarterly
//   node yahoofinance-financials.mjs balance MSFT --period=annual
//   node yahoofinance-financials.mjs cashflow GOOG --period=trailing
//
// Requires Chrome with Yahoo Finance open (uses CDP for all API requests).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-financials');
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
// Full field lists from yfinance const.py fundamentals_keys
// ---------------------------------------------------------------------------

const FINANCIALS_KEYS = [
  "TaxEffectOfUnusualItems", "TaxRateForCalcs", "NormalizedEBITDA", "NormalizedDilutedEPS",
  "NormalizedBasicEPS", "TotalUnusualItems", "TotalUnusualItemsExcludingGoodwill",
  "NetIncomeFromContinuingOperationNetMinorityInterest", "ReconciledDepreciation",
  "ReconciledCostOfRevenue", "EBITDA", "EBIT", "NetInterestIncome", "InterestExpense",
  "InterestIncome", "ContinuingAndDiscontinuedDilutedEPS", "ContinuingAndDiscontinuedBasicEPS",
  "NormalizedIncome", "NetIncomeFromContinuingAndDiscontinuedOperation", "TotalExpenses",
  "RentExpenseSupplemental", "ReportedNormalizedDilutedEPS", "ReportedNormalizedBasicEPS",
  "TotalOperatingIncomeAsReported", "DividendPerShare", "DilutedAverageShares", "BasicAverageShares",
  "DilutedEPS", "DilutedEPSOtherGainsLosses", "TaxLossCarryforwardDilutedEPS",
  "DilutedAccountingChange", "DilutedExtraordinary", "DilutedDiscontinuousOperations",
  "DilutedContinuousOperations", "BasicEPS", "BasicEPSOtherGainsLosses", "TaxLossCarryforwardBasicEPS",
  "BasicAccountingChange", "BasicExtraordinary", "BasicDiscontinuousOperations",
  "BasicContinuousOperations", "DilutedNIAvailtoComStockholders", "AverageDilutionEarnings",
  "NetIncomeCommonStockholders", "OtherunderPreferredStockDividend", "PreferredStockDividends",
  "NetIncome", "MinorityInterests", "NetIncomeIncludingNoncontrollingInterests",
  "NetIncomeFromTaxLossCarryforward", "NetIncomeExtraordinary", "NetIncomeDiscontinuousOperations",
  "NetIncomeContinuousOperations", "EarningsFromEquityInterestNetOfTax", "TaxProvision",
  "PretaxIncome", "OtherIncomeExpense", "OtherNonOperatingIncomeExpenses", "SpecialIncomeCharges",
  "GainOnSaleOfPPE", "GainOnSaleOfBusiness", "OtherSpecialCharges", "WriteOff",
  "ImpairmentOfCapitalAssets", "RestructuringAndMergernAcquisition", "SecuritiesAmortization",
  "EarningsFromEquityInterest", "GainOnSaleOfSecurity", "NetNonOperatingInterestIncomeExpense",
  "TotalOtherFinanceCost", "InterestExpenseNonOperating", "InterestIncomeNonOperating",
  "OperatingIncome", "OperatingExpense", "OtherOperatingExpenses", "OtherTaxes",
  "ProvisionForDoubtfulAccounts", "DepreciationAmortizationDepletionIncomeStatement",
  "DepletionIncomeStatement", "DepreciationAndAmortizationInIncomeStatement", "Amortization",
  "AmortizationOfIntangiblesIncomeStatement", "DepreciationIncomeStatement", "ResearchAndDevelopment",
  "SellingGeneralAndAdministration", "SellingAndMarketingExpense", "GeneralAndAdministrativeExpense",
  "OtherGandA", "InsuranceAndClaims", "RentAndLandingFees", "SalariesAndWages", "GrossProfit",
  "CostOfRevenue", "TotalRevenue", "ExciseTaxes", "OperatingRevenue", "LossAdjustmentExpense",
  "NetPolicyholderBenefitsAndClaims", "PolicyholderBenefitsGross", "PolicyholderBenefitsCeded",
  "OccupancyAndEquipment", "ProfessionalExpenseAndContractServicesExpense", "OtherNonInterestExpense"
];

const BALANCE_SHEET_KEYS = [
  "TreasurySharesNumber", "PreferredSharesNumber", "OrdinarySharesNumber", "ShareIssued", "NetDebt",
  "TotalDebt", "TangibleBookValue", "InvestedCapital", "WorkingCapital", "NetTangibleAssets",
  "CapitalLeaseObligations", "CommonStockEquity", "PreferredStockEquity", "TotalCapitalization",
  "TotalEquityGrossMinorityInterest", "MinorityInterest", "StockholdersEquity",
  "OtherEquityInterest", "GainsLossesNotAffectingRetainedEarnings", "OtherEquityAdjustments",
  "FixedAssetsRevaluationReserve", "ForeignCurrencyTranslationAdjustments",
  "MinimumPensionLiabilities", "UnrealizedGainLoss", "TreasuryStock", "RetainedEarnings",
  "AdditionalPaidInCapital", "CapitalStock", "OtherCapitalStock", "CommonStock", "PreferredStock",
  "TotalPartnershipCapital", "GeneralPartnershipCapital", "LimitedPartnershipCapital",
  "TotalLiabilitiesNetMinorityInterest", "TotalNonCurrentLiabilitiesNetMinorityInterest",
  "OtherNonCurrentLiabilities", "LiabilitiesHeldforSaleNonCurrent", "RestrictedCommonStock",
  "PreferredSecuritiesOutsideStockEquity", "DerivativeProductLiabilities", "EmployeeBenefits",
  "NonCurrentPensionAndOtherPostretirementBenefitPlans", "NonCurrentAccruedExpenses",
  "DuetoRelatedPartiesNonCurrent", "TradeandOtherPayablesNonCurrent",
  "NonCurrentDeferredLiabilities", "NonCurrentDeferredRevenue",
  "NonCurrentDeferredTaxesLiabilities", "LongTermDebtAndCapitalLeaseObligation",
  "LongTermCapitalLeaseObligation", "LongTermDebt", "LongTermProvisions", "CurrentLiabilities",
  "OtherCurrentLiabilities", "CurrentDeferredLiabilities", "CurrentDeferredRevenue",
  "CurrentDeferredTaxesLiabilities", "CurrentDebtAndCapitalLeaseObligation",
  "CurrentCapitalLeaseObligation", "CurrentDebt", "OtherCurrentBorrowings", "LineOfCredit",
  "CommercialPaper", "CurrentNotesPayable", "PensionandOtherPostRetirementBenefitPlansCurrent",
  "CurrentProvisions", "PayablesAndAccruedExpenses", "CurrentAccruedExpenses", "InterestPayable",
  "Payables", "OtherPayable", "DuetoRelatedPartiesCurrent", "DividendsPayable", "TotalTaxPayable",
  "IncomeTaxPayable", "AccountsPayable", "TotalAssets", "TotalNonCurrentAssets",
  "OtherNonCurrentAssets", "DefinedPensionBenefit", "NonCurrentPrepaidAssets",
  "NonCurrentDeferredAssets", "NonCurrentDeferredTaxesAssets", "DuefromRelatedPartiesNonCurrent",
  "NonCurrentNoteReceivables", "NonCurrentAccountsReceivable", "FinancialAssets",
  "InvestmentsAndAdvances", "OtherInvestments", "InvestmentinFinancialAssets",
  "HeldToMaturitySecurities", "AvailableForSaleSecurities",
  "FinancialAssetsDesignatedasFairValueThroughProfitorLossTotal", "TradingSecurities",
  "LongTermEquityInvestment", "InvestmentsinJointVenturesatCost",
  "InvestmentsInOtherVenturesUnderEquityMethod", "InvestmentsinAssociatesatCost",
  "InvestmentsinSubsidiariesatCost", "InvestmentProperties", "GoodwillAndOtherIntangibleAssets",
  "OtherIntangibleAssets", "Goodwill", "NetPPE", "AccumulatedDepreciation", "GrossPPE", "Leases",
  "ConstructionInProgress", "OtherProperties", "MachineryFurnitureEquipment",
  "BuildingsAndImprovements", "LandAndImprovements", "Properties", "CurrentAssets",
  "OtherCurrentAssets", "HedgingAssetsCurrent", "AssetsHeldForSaleCurrent", "CurrentDeferredAssets",
  "CurrentDeferredTaxesAssets", "RestrictedCash", "PrepaidAssets", "Inventory",
  "InventoriesAdjustmentsAllowances", "OtherInventories", "FinishedGoods", "WorkInProcess",
  "RawMaterials", "Receivables", "ReceivablesAdjustmentsAllowances", "OtherReceivables",
  "DuefromRelatedPartiesCurrent", "TaxesReceivable", "AccruedInterestReceivable", "NotesReceivable",
  "LoansReceivable", "AccountsReceivable", "AllowanceForDoubtfulAccountsReceivable",
  "GrossAccountsReceivable", "CashCashEquivalentsAndShortTermInvestments",
  "OtherShortTermInvestments", "CashAndCashEquivalents", "CashEquivalents", "CashFinancial",
  "CashCashEquivalentsAndFederalFundsSold"
];

const CASH_FLOW_KEYS = [
  "ForeignSales", "DomesticSales", "AdjustedGeographySegmentData", "FreeCashFlow",
  "RepurchaseOfCapitalStock", "RepaymentOfDebt", "IssuanceOfDebt", "IssuanceOfCapitalStock",
  "CapitalExpenditure", "InterestPaidSupplementalData", "IncomeTaxPaidSupplementalData",
  "EndCashPosition", "OtherCashAdjustmentOutsideChangeinCash", "BeginningCashPosition",
  "EffectOfExchangeRateChanges", "ChangesInCash", "OtherCashAdjustmentInsideChangeinCash",
  "CashFlowFromDiscontinuedOperation", "FinancingCashFlow", "CashFromDiscontinuedFinancingActivities",
  "CashFlowFromContinuingFinancingActivities", "NetOtherFinancingCharges", "InterestPaidCFF",
  "ProceedsFromStockOptionExercised", "CashDividendsPaid", "PreferredStockDividendPaid",
  "CommonStockDividendPaid", "NetPreferredStockIssuance", "PreferredStockPayments",
  "PreferredStockIssuance", "NetCommonStockIssuance", "CommonStockPayments", "CommonStockIssuance",
  "NetIssuancePaymentsOfDebt", "NetShortTermDebtIssuance", "ShortTermDebtPayments",
  "ShortTermDebtIssuance", "NetLongTermDebtIssuance", "LongTermDebtPayments", "LongTermDebtIssuance",
  "InvestingCashFlow", "CashFromDiscontinuedInvestingActivities",
  "CashFlowFromContinuingInvestingActivities", "NetOtherInvestingChanges", "InterestReceivedCFI",
  "DividendsReceivedCFI", "NetInvestmentPurchaseAndSale", "SaleOfInvestment", "PurchaseOfInvestment",
  "NetInvestmentPropertiesPurchaseAndSale", "SaleOfInvestmentProperties",
  "PurchaseOfInvestmentProperties", "NetBusinessPurchaseAndSale", "SaleOfBusiness",
  "PurchaseOfBusiness", "NetIntangiblesPurchaseAndSale", "SaleOfIntangibles", "PurchaseOfIntangibles",
  "NetPPEPurchaseAndSale", "SaleOfPPE", "PurchaseOfPPE", "CapitalExpenditureReported",
  "OperatingCashFlow", "CashFromDiscontinuedOperatingActivities",
  "CashFlowFromContinuingOperatingActivities", "TaxesRefundPaid", "InterestReceivedCFO",
  "InterestPaidCFO", "DividendReceivedCFO", "DividendPaidCFO", "ChangeInWorkingCapital",
  "ChangeInOtherWorkingCapital", "ChangeInOtherCurrentLiabilities", "ChangeInOtherCurrentAssets",
  "ChangeInPayablesAndAccruedExpense", "ChangeInAccruedExpense", "ChangeInInterestPayable",
  "ChangeInPayable", "ChangeInDividendPayable", "ChangeInAccountPayable", "ChangeInTaxPayable",
  "ChangeInIncomeTaxPayable", "ChangeInPrepaidAssets", "ChangeInInventory", "ChangeInReceivables",
  "ChangesInAccountReceivables", "OtherNonCashItems", "ExcessTaxBenefitFromStockBasedCompensation",
  "StockBasedCompensation", "UnrealizedGainLossOnInvestmentSecurities", "ProvisionandWriteOffofAssets",
  "AssetImpairmentCharge", "AmortizationOfSecurities", "DeferredTax", "DeferredIncomeTax",
  "DepreciationAmortizationDepletion", "Depletion", "DepreciationAndAmortization",
  "AmortizationCashFlow", "AmortizationOfIntangibles", "Depreciation", "OperatingGainsLosses",
  "PensionAndEmployeeBenefitExpense", "EarningsLossesFromEquityInvestments",
  "GainLossOnInvestmentSecurities", "NetForeignCurrencyExchangeGainLoss", "GainLossOnSaleOfPPE",
  "GainLossOnSaleOfBusiness", "NetIncomeFromContinuingOperations",
  "CashFlowsfromusedinOperatingActivitiesDirect", "TaxesRefundPaidDirect", "InterestReceivedDirect",
  "InterestPaidDirect", "DividendsReceivedDirect", "DividendsPaidDirect", "ClassesofCashPayments",
  "OtherCashPaymentsfromOperatingActivities", "PaymentsonBehalfofEmployees",
  "PaymentstoSuppliersforGoodsandServices", "ClassesofCashReceiptsfromOperatingActivities",
  "OtherCashReceiptsfromOperatingActivities", "ReceiptsfromGovernmentGrants", "ReceiptsfromCustomers"
];

// ---------------------------------------------------------------------------
// Curated display subsets — shown in output (all fields are still cached)
// ---------------------------------------------------------------------------

const INCOME_DISPLAY_FIELDS = [
  "TotalRevenue", "CostOfRevenue", "GrossProfit", "OperatingExpense", "OperatingIncome",
  "EBITDA", "EBIT", "PretaxIncome", "TaxProvision", "NetIncome",
  "DilutedEPS", "BasicEPS", "TotalExpenses", "InterestExpense",
  "ResearchAndDevelopment", "SellingGeneralAndAdministration",
  "NetIncomeCommonStockholders", "DilutedAverageShares"
];

const BALANCE_DISPLAY_FIELDS = [
  "TotalAssets", "TotalLiabilitiesNetMinorityInterest", "TotalEquityGrossMinorityInterest",
  "CashAndCashEquivalents", "TotalDebt", "LongTermDebt",
  "CurrentAssets", "CurrentLiabilities", "WorkingCapital", "NetDebt",
  "CommonStockEquity", "RetainedEarnings", "Goodwill", "NetPPE",
  "Inventory", "AccountsReceivable", "AccountsPayable"
];

const CASHFLOW_DISPLAY_FIELDS = [
  "OperatingCashFlow", "CapitalExpenditure", "FreeCashFlow",
  "FinancingCashFlow", "InvestingCashFlow",
  "RepurchaseOfCapitalStock", "IssuanceOfDebt", "RepaymentOfDebt",
  "CashDividendsPaid", "DepreciationAmortizationDepletion",
  "StockBasedCompensation", "ChangeInWorkingCapital"
];

// ---------------------------------------------------------------------------
// CDP integration
// ---------------------------------------------------------------------------

function findCdpScript() {
  const here = dirname(new URL(import.meta.url).pathname);
  const ancestorCandidates = [];
  let dir = here;
  for (let i = 0; i < 8; i++) {
    ancestorCandidates.push(resolve(dir, 'skills/chrome-cdp/scripts/cdp.mjs'));
    ancestorCandidates.push(resolve(dir, 'chrome-cdp/scripts/cdp.mjs'));
    dir = resolve(dir, '..');
  }
  const candidates = [
    process.env.SHOWRUN_ROOT ? resolve(process.env.SHOWRUN_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs') : null,
    ...ancestorCandidates,
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
  ].filter(Boolean);
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found. Install it or set CDP_SCRIPT env var.'); })();
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

function findYahooTab() {
  const list = cdp('list');
  for (const pref of ['finance.yahoo.com', 'yahoo.com/quote', 'yahoo.com']) {
    for (const line of list.split('\n')) {
      if (line.includes(pref)) return line.trim().split(/\s+/)[0];
    }
  }
  return null;
}

function cdpFetch(tabId, url, options = {}) {
  const method = options.method || 'GET';
  const hdrs = options.headers ? `,headers:${JSON.stringify(options.headers)}` : '';
  const bodyPart = options.body ? `,body:${JSON.stringify(String(options.body))}` : '';
  const result = cdp('eval', tabId,
    `(async()=>{const r=await fetch('${url}',{method:'${method}',credentials:'include'${hdrs}${bodyPart}});return r.status+'|||'+(await r.text())})()`);
  const sepIdx = result.indexOf('|||');
  const status = parseInt(result.substring(0, sepIdx), 10);
  const body = result.substring(sepIdx + 3);
  return { status, body };
}

// ---------------------------------------------------------------------------
// Auth: fetch crumb via Chrome CDP
// ---------------------------------------------------------------------------

function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const tabId = findYahooTab();
  if (!tabId) throw new Error('No Yahoo Finance tab found. Open https://finance.yahoo.com in Chrome first.');
  console.log(`Using tab: ${tabId}`);

  console.log('Fetching crumb...');
  const resp = cdpFetch(tabId, 'https://query1.finance.yahoo.com/v1/test/getcrumb');
  if (resp.status !== 200 || !resp.body || resp.body.includes('<html>') || resp.body.length >= 80) {
    throw new Error(`Failed to fetch crumb (HTTP ${resp.status}). Try refreshing Yahoo Finance in Chrome.`);
  }
  const crumb = resp.body.trim();

  saveJson(SESSION_FILE, {
    crumb,
    capturedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
  console.log(`Crumb: ${crumb}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session.crumb) {
    console.error('No auth found. Run: node yahoofinance-financials.mjs auth');
    process.exit(1);
  }
  return session;
}

function yahooFetch(session, url) {
  const tabId = findYahooTab();
  if (!tabId) throw new Error('No Yahoo Finance tab found. Open https://finance.yahoo.com in Chrome first.');

  const separator = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${separator}crumb=${encodeURIComponent(session.crumb)}`;

  const resp = cdpFetch(tabId, fullUrl);
  let data;
  try { data = JSON.parse(resp.body); } catch { data = resp.body; }
  return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, data };
}

// ---------------------------------------------------------------------------
// Core: fetch fundamentals timeseries
// ---------------------------------------------------------------------------

function fetchTimeseries(session, symbol, statementType, period) {
  // Map statement type to field keys
  const keyMap = {
    'income': FINANCIALS_KEYS,
    'balance': BALANCE_SHEET_KEYS,
    'cashflow': CASH_FLOW_KEYS,
  };
  const keys = keyMap[statementType];
  if (!keys) throw new Error(`Unknown statement type: ${statementType}`);

  // Map period to prefix
  const prefixMap = { 'annual': 'annual', 'quarterly': 'quarterly', 'trailing': 'trailing' };
  const prefix = prefixMap[period];
  if (!prefix) throw new Error(`Unknown period: ${period}`);

  // Trailing only valid for income and cashflow
  if (period === 'trailing' && statementType === 'balance') {
    throw new Error("Trailing period is not available for balance sheet data. Use 'annual' or 'quarterly'.");
  }

  // Build the type= param: prefix + each field name
  const typeParam = keys.map(k => prefix + k).join(',');

  // Yahoo's timeseries endpoint returns empty meta when period1=0; it requires
  // a reasonable epoch. Use ~20 years ago to cover annual history for most tickers.
  const now = Math.floor(Date.now() / 1000);
  const period1 = now - (20 * 365 * 86400);
  const period2 = now;
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${typeParam}&period1=${period1}&period2=${period2}`;

  console.log(`Fetching ${period} ${statementType} data for ${symbol}...`);
  const result = yahooFetch(session, url);

  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      console.error('Session expired. Run: node yahoofinance-financials.mjs auth');
    }
    throw new Error(`Failed to fetch data for ${symbol} (HTTP ${result.status})`);
  }

  // Parse response: timeseries.result[]
  const tsResult = result.data?.timeseries?.result;
  if (!tsResult) {
    throw new Error(`No timeseries data in response for ${symbol}. Response: ${JSON.stringify(result.data).substring(0, 500)}`);
  }

  // Collect all unique dates and build rows
  const dateSet = new Set();
  const allRows = {};

  for (const entry of tsResult) {
    // Each entry has a key matching the prefixed field name (e.g., "annualTotalRevenue")
    // and optionally a "timestamp" array
    if (entry.timestamp) {
      for (const ts of entry.timestamp) {
        dateSet.add(ts);
      }
    }
    // Find the data key (not "meta" or "timestamp")
    for (const key of Object.keys(entry)) {
      if (key === 'meta' || key === 'timestamp') continue;
      // Strip the prefix to get the clean field name
      const fieldName = key.replace(new RegExp('^' + prefix), '');
      const values = entry[key];
      if (Array.isArray(values)) {
        allRows[fieldName] = {};
        for (const v of values) {
          if (v && v.asOfDate && v.reportedValue) {
            allRows[fieldName][v.asOfDate] = v.reportedValue.raw;
          }
        }
      }
    }
  }

  // Sort dates descending (most recent first)
  const dates = Array.from(dateSet)
    .map(ts => {
      const d = new Date(ts * 1000);
      return d.toISOString().split('T')[0];
    })
    .sort()
    .reverse();

  // Also collect dates from asOfDate fields (more reliable)
  const asOfDates = new Set();
  for (const fieldData of Object.values(allRows)) {
    for (const d of Object.keys(fieldData)) {
      asOfDates.add(d);
    }
  }
  const sortedDates = Array.from(asOfDates).sort().reverse();

  // For trailing, only show the most recent column
  const displayDates = period === 'trailing' ? sortedDates.slice(0, 1) : sortedDates;

  // Build output table
  const rows = {};
  for (const [fieldName, dateValues] of Object.entries(allRows)) {
    const rowValues = displayDates.map(d => dateValues[d] !== undefined ? dateValues[d] : null);
    // Only include rows that have at least one non-null value
    if (rowValues.some(v => v !== null)) {
      rows[fieldName] = rowValues;
    }
  }

  return { dates: displayDates, rows, _allRows: allRows, _allDates: sortedDates };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatNumber(val) {
  if (val === null || val === undefined) return '-';
  if (typeof val !== 'number') return String(val);
  const absVal = Math.abs(val);
  if (absVal >= 1e12) return (val / 1e12).toFixed(2) + 'T';
  if (absVal >= 1e9) return (val / 1e9).toFixed(2) + 'B';
  if (absVal >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (absVal >= 1e3) return (val / 1e3).toFixed(2) + 'K';
  if (Number.isInteger(val)) return val.toString();
  return val.toFixed(2);
}

function printTable(data, displayFields) {
  const { dates, rows } = data;
  if (dates.length === 0) {
    console.log('No data available.');
    return;
  }

  // Filter to display fields that exist in data
  const fieldsToShow = displayFields.filter(f => rows[f]);

  // Calculate column widths
  const fieldWidth = Math.max(40, ...fieldsToShow.map(f => f.length + 2));
  const colWidth = 14;

  // Header
  const header = ''.padEnd(fieldWidth) + dates.map(d => d.padStart(colWidth)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));

  // Rows
  for (const field of fieldsToShow) {
    const vals = rows[field] || [];
    const line = field.padEnd(fieldWidth) + vals.map(v => formatNumber(v).padStart(colWidth)).join('');
    console.log(line);
  }

  // Summary
  console.log(`\n${fieldsToShow.length} fields displayed, ${Object.keys(rows).length} total fields available in cache.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) flags[m[1]] = m[2]; else positional.push(arg);
  }
  return { flags, positional };
}

switch (command) {
  case 'auth': {
    doAuth();
    break;
  }

  case 'income': {
    const { flags, positional } = parseFlags(args);
    const symbol = positional[0];
    if (!symbol) {
      console.error('Usage: node yahoofinance-financials.mjs income <SYMBOL> [--period=annual|quarterly|trailing]');
      process.exit(1);
    }
    const period = flags.period || 'annual';
    if (!['annual', 'quarterly', 'trailing'].includes(period)) {
      console.error(`Invalid period: ${period}. Must be annual, quarterly, or trailing.`);
      process.exit(1);
    }

    const session = getSession();
    const data = fetchTimeseries(session, symbol.toUpperCase(), 'income', period);

    // Cache full result
    ensureDir(CACHE_DIR);
    const cacheFile = resolve(CACHE_DIR, `${symbol.toUpperCase()}-income-${period}.json`);
    saveJson(cacheFile, { symbol: symbol.toUpperCase(), statement: 'income', period, dates: data._allDates, rows: data._allRows, fetchedAt: new Date().toISOString() });

    // Display curated subset
    console.log(`\n${symbol.toUpperCase()} — Income Statement (${period})\n`);
    printTable(data, INCOME_DISPLAY_FIELDS);

    // JSON output for piping
    const output = { dates: data.dates, rows: {} };
    for (const f of INCOME_DISPLAY_FIELDS) {
      if (data.rows[f]) output.rows[f] = data.rows[f];
    }
    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  case 'balance': {
    const { flags, positional } = parseFlags(args);
    const symbol = positional[0];
    if (!symbol) {
      console.error('Usage: node yahoofinance-financials.mjs balance <SYMBOL> [--period=annual|quarterly]');
      process.exit(1);
    }
    const period = flags.period || 'annual';
    if (!['annual', 'quarterly'].includes(period)) {
      console.error(`Invalid period: ${period}. Balance sheet supports annual or quarterly only.`);
      process.exit(1);
    }

    const session = getSession();
    const data = fetchTimeseries(session, symbol.toUpperCase(), 'balance', period);

    ensureDir(CACHE_DIR);
    const cacheFile = resolve(CACHE_DIR, `${symbol.toUpperCase()}-balance-${period}.json`);
    saveJson(cacheFile, { symbol: symbol.toUpperCase(), statement: 'balance-sheet', period, dates: data._allDates, rows: data._allRows, fetchedAt: new Date().toISOString() });

    console.log(`\n${symbol.toUpperCase()} — Balance Sheet (${period})\n`);
    printTable(data, BALANCE_DISPLAY_FIELDS);

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  case 'cashflow': {
    const { flags, positional } = parseFlags(args);
    const symbol = positional[0];
    if (!symbol) {
      console.error('Usage: node yahoofinance-financials.mjs cashflow <SYMBOL> [--period=annual|quarterly|trailing]');
      process.exit(1);
    }
    const period = flags.period || 'annual';
    if (!['annual', 'quarterly', 'trailing'].includes(period)) {
      console.error(`Invalid period: ${period}. Must be annual, quarterly, or trailing.`);
      process.exit(1);
    }

    const session = getSession();
    const data = fetchTimeseries(session, symbol.toUpperCase(), 'cashflow', period);

    ensureDir(CACHE_DIR);
    const cacheFile = resolve(CACHE_DIR, `${symbol.toUpperCase()}-cashflow-${period}.json`);
    saveJson(cacheFile, { symbol: symbol.toUpperCase(), statement: 'cash-flow', period, dates: data._allDates, rows: data._allRows, fetchedAt: new Date().toISOString() });

    console.log(`\n${symbol.toUpperCase()} — Cash Flow Statement (${period})\n`);
    printTable(data, CASHFLOW_DISPLAY_FIELDS);

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  default:
    console.log(`yahoofinance-financials — Fetch financial statements from Yahoo Finance

Commands:
  auth                                       Authenticate via Chrome (one-time)
  income <SYMBOL> [--period=annual|quarterly|trailing]
                                             Fetch income statement
  balance <SYMBOL> [--period=annual|quarterly]
                                             Fetch balance sheet
  cashflow <SYMBOL> [--period=annual|quarterly|trailing]
                                             Fetch cash flow statement

Period options:
  annual      Annual data (default)
  quarterly   Quarterly data
  trailing    Trailing twelve months (income & cashflow only)

Examples:
  node yahoofinance-financials.mjs auth
  node yahoofinance-financials.mjs income AAPL
  node yahoofinance-financials.mjs income AAPL --period=quarterly
  node yahoofinance-financials.mjs balance MSFT --period=annual
  node yahoofinance-financials.mjs cashflow GOOG --period=trailing

Data: ${DATA_DIR}/
  session.json     Auth crumb
  cache/           Financial statement JSON files`);
}
