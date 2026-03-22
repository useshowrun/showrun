#!/usr/bin/env node
/**
 * Rightmove Listing Scraper
 *
 * Fetch full property details from a Rightmove listing page.
 * Uses pure HTTP — extracts window.PAGE_MODEL from SSR page HTML.
 *
 * Data Sources:
 *   - Listing page: https://www.rightmove.co.uk/properties/<id>
 *     embeds window.PAGE_MODEL = {...} with all property details
 *
 * Usage:
 *   node rightmove-listing.mjs <property-url-or-id>
 *
 * Arguments:
 *   <property-url-or-id>
 *     A Rightmove property URL or numeric property ID.
 *     Accepted formats:
 *       https://www.rightmove.co.uk/properties/87729723
 *       https://www.rightmove.co.uk/properties/87729723#/?channel=RES_BUY
 *       87729723
 *
 * Examples:
 *   node rightmove-listing.mjs 87729723
 *   node rightmove-listing.mjs "https://www.rightmove.co.uk/properties/87729723"
 *   node rightmove-listing.mjs "https://www.rightmove.co.uk/properties/87729723#/?channel=RES_BUY"
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(__dirname, "../../lib/utils.mjs");
const {
  emitResult,
  emitError,
  log,
  fetchUrl,
  extractPageModel,
  stripHtml,
  buildImageUrl,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node rightmove-listing.mjs <property-url-or-id>

Arguments:
  <property-url-or-id>
    Rightmove property URL or numeric ID.

Examples:
  node rightmove-listing.mjs 87729723
  node rightmove-listing.mjs "https://www.rightmove.co.uk/properties/87729723"
`);
  process.exit(0);
}

const input = args[0].trim();

// ---------------------------------------------------------------------------
// Parse property ID from input
// ---------------------------------------------------------------------------

function extractPropertyId(input) {
  // If it's just a number
  if (/^\d+$/.test(input)) return input;

  // Extract from URL: /properties/12345 or /properties/12345#...
  const match = input.match(/\/properties\/(\d+)/);
  if (match) return match[1];

  return null;
}

const propertyId = extractPropertyId(input);
if (!propertyId) {
  emitError(
    "INVALID_INPUT",
    `Cannot extract property ID from: "${input}". Provide a numeric ID or a Rightmove property URL.`
  );
}

// ---------------------------------------------------------------------------
// Data normalisation helpers
// ---------------------------------------------------------------------------

function normaliseImages(images) {
  if (!Array.isArray(images)) return [];
  return images.map((img) => ({
    url: buildImageUrl(img.url),
    srcUrl: img.srcUrl || null,
    caption: img.caption || null,
  }));
}

function normaliseFloorplans(floorplans) {
  if (!Array.isArray(floorplans)) return [];
  return floorplans.map((fp) => ({
    url: buildImageUrl(fp.url),
    caption: fp.caption || null,
  }));
}

function normaliseStations(stations) {
  if (!Array.isArray(stations)) return [];
  return stations.map((s) => ({
    name: s.name,
    types: s.types || [],
    distance: s.distance,
    unit: s.unit || "miles",
  }));
}

function normaliseListingHistory(lh) {
  if (!lh) return null;
  // lh is an object like { listingUpdateReason: "Reduced on 02/03/2026" }
  // or may contain a history array
  if (typeof lh === "string") return { summary: lh };
  if (Array.isArray(lh)) {
    return lh.map((entry) => ({
      event: entry.listingUpdateReason || entry.event || null,
      date: entry.date || null,
      price: entry.price || null,
    }));
  }
  return {
    summary: lh.listingUpdateReason || null,
  };
}

function normaliseContactInfo(contactInfo, customer) {
  const phone =
    contactInfo?.telephoneNumbers?.localNumber ||
    customer?.contactTelephone ||
    null;
  const intlPhone = contactInfo?.telephoneNumbers?.internationalNumber || null;
  return {
    phone,
    intlPhone,
    contactMethod: contactInfo?.contactMethod || null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  const listingUrl = `https://www.rightmove.co.uk/properties/${propertyId}`;
  log(`Fetching listing: ${listingUrl}`);

  const resp = await fetchUrl(listingUrl);

  if (resp.status === 307 || resp.status === 301 || resp.status === 302) {
    emitError(
      "PROPERTY_NOT_FOUND",
      `Property ${propertyId} not found (HTTP ${resp.status})`
    );
  }

  if (resp.status !== 200) {
    emitError(
      "HTTP_ERROR",
      `Unexpected HTTP ${resp.status} for property ${propertyId}`
    );
  }

  const pageModel = extractPageModel(resp.body);
  if (!pageModel || !pageModel.propertyData) {
    emitError(
      "PARSE_ERROR",
      `Could not extract PAGE_MODEL from property ${propertyId}. The property may no longer be listed.`
    );
  }

  const pd = pageModel.propertyData;
  const prices = pd.prices || {};
  const customer = pd.customer || {};
  const contactInfo = pd.contactInfo || {};
  const location = pd.location || {};
  const tenure = pd.tenure || {};
  const livingCosts = pd.livingCosts || {};
  const broadband = pd.broadband || {};
  const text = pd.text || {};

  // Build output
  const result = {
    propertyId: pd.id || propertyId,
    url: listingUrl,

    // Basic info
    displayAddress: pd.address?.displayAddress || null,
    bedrooms: pd.bedrooms ?? null,
    bathrooms: pd.bathrooms ?? null,
    propertySubType: pd.propertySubType || null,
    transactionType: pd.transactionType || null,
    channel: pd.channel || null,

    // Description
    description: stripHtml(text.description) || null,
    summary: text.pageTitle || null,

    // Key features
    keyFeatures: pd.keyFeatures || [],

    // Price
    price: {
      primary: prices.primaryPrice || null,
      secondary: prices.secondaryPrice || null,
      qualifier: prices.displayPriceQualifier || null,
      perSqFt: prices.pricePerSqFt || null,
    },

    // Location
    location: {
      lat: location.latitude ?? null,
      lng: location.longitude ?? null,
      outcode: pd.address?.outcode || null,
      incode: pd.address?.incode || null,
      ukCountry: pd.address?.ukCountry || null,
    },

    // Images
    images: normaliseImages(pd.images),
    floorplans: normaliseFloorplans(pd.floorplans),
    virtualTourUrl:
      pd.virtualTours?.[0]?.url || pd.virtualTours?.[0]?.full || null,

    // Tenure
    tenure: {
      type: tenure.tenureType || null,
      yearsRemaining: tenure.yearsRemainingOnLease ?? null,
      message: tenure.message || null,
    },

    // Living costs
    livingCosts: {
      councilTaxBand: livingCosts.councilTaxBand || null,
      councilTaxExempt: livingCosts.councilTaxExempt || false,
      annualGroundRent: livingCosts.annualGroundRent ?? null,
      annualServiceCharge: livingCosts.annualServiceCharge ?? null,
      groundRentReviewPeriodYears:
        livingCosts.groundRentReviewPeriodInYears ?? null,
    },

    // Transport
    nearestStations: normaliseStations(pd.nearestStations),
    nearestAirports: normaliseStations(pd.nearestAirports),

    // Broadband
    broadband: broadband.broadbandCheckerUrl
      ? {
          checkerUrl: broadband.broadbandCheckerUrl,
          disclaimer: stripHtml(broadband.disclaimer) || null,
        }
      : null,

    // EPC
    epcGraphs: Array.isArray(pd.epcGraphs)
      ? pd.epcGraphs.map((g) => ({
          url: buildImageUrl(g.url) || g.url || null,
          caption: g.caption || null,
        }))
      : [],

    // Listing history
    listingHistory: normaliseListingHistory(pd.listingHistory),

    // Sizes
    sizings: Array.isArray(pd.sizings)
      ? pd.sizings.map((s) => ({
          sizeType: s.sizeType,
          minimumSize: s.minimumSize,
          maximumSize: s.maximumSize,
          unit: s.unit,
        }))
      : [],

    // Agent / Customer
    // Listing page customer object differs from search page customer object
    agent: {
      branchId: customer.branchId || null,
      name: customer.companyTradingName || customer.companyName || customer.brandTradingName || customer.branchDisplayName || null,
      branchName: customer.branchDisplayName || null,
      address: customer.displayAddress || null,
      phone: contactInfo?.telephoneNumbers?.localNumber || customer.contactTelephone || null,
      branchUrl: (customer.customerProfileUrl || customer.branchLandingPageUrl)
        ? `https://www.rightmove.co.uk${customer.customerProfileUrl || customer.branchLandingPageUrl}`
        : null,
      logoUrl: customer.logoPath || customer.brandPlusLogoUrl || null,
      primaryColour: customer.primaryBrandColour || null,
    },

    // Contact
    contact: normaliseContactInfo(contactInfo, customer),

    // Brochures
    brochures: Array.isArray(pd.brochures)
      ? pd.brochures.map((b) => ({ url: b.url, caption: b.caption || null }))
      : [],

    // Tags / Features
    tags: pd.tags || [],
    features: pd.features || [],
  };

  emitResult(result);
} catch (e) {
  if (e.code === "SCRAPE_ERROR" || e.code === "PROPERTY_NOT_FOUND") throw e;
  emitError("SCRAPE_ERROR", e.message);
}
