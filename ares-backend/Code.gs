/**
 * ARES Property Database — Google Apps Script Backend
 * =====================================================
 * Deploy as a Web App (Execute as: Me, Access: Anyone).
 * This script:
 *   1. Serves the property JSON feed to the website (doGet)
 *   2. Runs AI vetting on unvetted rows (runVetting)
 *   3. Caches the feed for performance
 *
 * Sheet name: "Properties"
 * Column order defined in COLUMNS below — do not reorder without updating.
 */

// ── CONFIGURATION ──────────────────────────────────────────────────────────
const CONFIG = {
  SHEET_NAME: 'Properties',
  // Set ANTHROPIC_API_KEY via: Extensions → Apps Script → Project Settings → Script Properties
  EPA_ECHO_BASE: 'https://echodata.epa.gov/echo/echo_rest_services.get_facilities',
  EPA_RADIUS_MILES: 2,
  CACHE_KEY: 'ares_property_feed',
  CACHE_TTL_SECONDS: 3600,
};

// ── COLUMN MAP (1-indexed, matches sheet header row) ───────────────────────
const COL = {
  ID: 1, STATUS: 2, ADDRESS: 3, CITY: 4, STATE: 5, COUNTY: 6, ZIP: 7,
  LAT: 8, LNG: 9, PRICE: 10, LOT_SQFT: 11, BLDG_SQFT: 12,
  ZONING: 13, ZONING_LABEL: 14, PROPERTY_TYPE: 15, CURRENT_USE: 16,
  YEAR_BUILT: 17, IS_VACANT: 18, VACANT_SINCE: 19, IS_GRANDFATHERED: 20,
  EPA_STATUS: 21, FLEET_SUITABLE: 22, FLEET_FEATURES: 23,
  TITLE_FLAGS: 24, DEED_RESTRICTIONS: 25, HAS_TITLE_DATA: 26,
  GF_RISK_FACTORS: 27, DESCRIPTION: 28, LISTING_SOURCE: 29,
  AI_SCORE: 30, AI_FLAGS: 31, AI_SUMMARY: 32,
  EPA_FACILITY_COUNT: 33, LAST_VETTED: 34, NOTES: 35,
};

// ── doGet: SERVE JSON FEED TO WEBSITE ─────────────────────────────────────
function doGet(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(CONFIG.CACHE_KEY);
    if (cached) { output.setContent(cached); return output; }
    const feed = buildFeed();
    const json = JSON.stringify(feed);
    cache.put(CONFIG.CACHE_KEY, json, CONFIG.CACHE_TTL_SECONDS);
    output.setContent(json);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message, properties: [] }));
  }
  return output;
}

// ── BUILD FEED ─────────────────────────────────────────────────────────────
function buildFeed() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + CONFIG.SHEET_NAME + '" not found.');
  const data = sheet.getDataRange().getValues();
  const properties = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[COL.ID - 1]) continue;
    if (row[COL.STATUS - 1] !== 'Approved') continue;
    properties.push(rowToProperty(row));
  }
  return { generated: new Date().toISOString(), count: properties.length, properties };
}

// ── ROW → PROPERTY OBJECT ──────────────────────────────────────────────────
function rowToProperty(row) {
  const cell = n => row[n - 1];
  const splitList = v => v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : [];
  const toBool = v => typeof v === 'boolean' ? v :
    ['true','1','yes'].includes(String(v).toLowerCase());

  return {
    id: String(cell(COL.ID)),
    address: String(cell(COL.ADDRESS) || ''),
    city: String(cell(COL.CITY) || ''),
    state: String(cell(COL.STATE) || ''),
    county: String(cell(COL.COUNTY) || ''),
    zip: String(cell(COL.ZIP) || ''),
    lat: parseFloat(cell(COL.LAT)) || 0,
    lng: parseFloat(cell(COL.LNG)) || 0,
    price: parseFloat(cell(COL.PRICE)) || 0,
    lotSqFt: parseFloat(cell(COL.LOT_SQFT)) || 0,
    bldgSqFt: parseFloat(cell(COL.BLDG_SQFT)) || 0,
    zoning: String(cell(COL.ZONING) || ''),
    zoningLabel: String(cell(COL.ZONING_LABEL) || ''),
    propertyType: String(cell(COL.PROPERTY_TYPE) || ''),
    currentUse: String(cell(COL.CURRENT_USE) || ''),
    yearBuilt: parseInt(cell(COL.YEAR_BUILT)) || 0,
    isVacant: toBool(cell(COL.IS_VACANT)),
    vacantSince: cell(COL.VACANT_SINCE)
      ? new Date(cell(COL.VACANT_SINCE)).toISOString().split('T')[0] : null,
    isGrandfathered: toBool(cell(COL.IS_GRANDFATHERED)),
    epaStatus: String(cell(COL.EPA_STATUS) || 'clean'),
    fleetSuitable: toBool(cell(COL.FLEET_SUITABLE)),
    fleetFeatures: splitList(cell(COL.FLEET_FEATURES)),
    titleFlags: splitList(cell(COL.TITLE_FLAGS)),
    deedRestrictions: splitList(cell(COL.DEED_RESTRICTIONS)),
    hasTitleData: toBool(cell(COL.HAS_TITLE_DATA)),
    grandfatherRiskFactors: splitList(cell(COL.GF_RISK_FACTORS)),
    description: String(cell(COL.DESCRIPTION) || ''),
    listingSource: String(cell(COL.LISTING_SOURCE) || ''),
    aiScore: parseFloat(cell(COL.AI_SCORE)) || null,
    aiFlags: String(cell(COL.AI_FLAGS) || ''),
    aiSummary: String(cell(COL.AI_SUMMARY) || ''),
    epaFacilityCount: parseInt(cell(COL.EPA_FACILITY_COUNT)) || 0,
    lastVetted: cell(COL.LAST_VETTED)
      ? new Date(cell(COL.LAST_VETTED)).toISOString() : null,
  };
}

// ── RUN VETTING: Process all Pending rows ─────────────────────────────────
// Call this manually or set a time-based trigger (e.g. every 30 minutes).
function runVetting() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[COL.ID - 1]) continue;
    if (row[COL.STATUS - 1] !== 'Pending') continue;

    const rowNum = i + 1;
    try {
      vetRow(sheet, row, rowNum, apiKey);
      Utilities.sleep(2000); // avoid rate limits
    } catch (err) {
      sheet.getRange(rowNum, COL.AI_FLAGS).setValue('Vetting error: ' + err.message);
    }
  }

  // Bust the cache so the website picks up changes immediately
  CacheService.getScriptCache().remove(CONFIG.CACHE_KEY);
}

// ── VET ALL DRAFT ROWS — RESUMABLE ACROSS MULTIPLE RUNS ───────────────────
// Apps Script has a 6-minute execution limit. This function saves its place
// in Script Properties when time is running low.
//
// HOW TO USE:
//   1. Run vetAllDraft() — it processes rows until ~5 min then stops
//   2. The log will say "▶ Run vetAllDraft() again to continue from row X"
//   3. Click Run again — it picks up exactly where it left off
//   4. Repeat until the log says "═══ Vetting Complete ═══"
//
// Progress key: 'VET_RESUME_ROW' in Script Properties.
// Use resetVetProgress() to start over from the beginning.
function vetAllDraft() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) { Logger.log('ERROR: Sheet not found.'); return; }

  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    Logger.log('ERROR: ANTHROPIC_API_KEY not set. Go to Apps Script → Project Settings → Script Properties and add it.');
    return;
  }

  const props      = PropertiesService.getScriptProperties();
  const START_TIME = Date.now();
  const MAX_MS     = 5 * 60 * 1000; // stop at 5 min to stay well inside the 6-min hard limit

  // Resume from last saved position, or start at data row index 1 (row 0 = header)
  const resumeFrom = parseInt(props.getProperty('VET_RESUME_ROW') || '1');
  const data = sheet.getDataRange().getValues();
  const total = data.length - 1; // subtract header row

  Logger.log('▶ Resuming from row ' + resumeFrom + ' of ' + total + ' total data rows…');

  let promoted = 0;
  let vetted   = 0;
  let errors   = 0;

  for (let i = resumeFrom; i < data.length; i++) {
    // ── Time-limit check — save progress and exit cleanly ─────────────────
    if (Date.now() - START_TIME > MAX_MS) {
      props.setProperty('VET_RESUME_ROW', String(i));
      Logger.log('\n⏱ Approaching time limit. Stopped at row ' + i + ' of ' + total + '.');
      Logger.log('Vetted this run: ' + vetted + ' | Errors: ' + errors);
      Logger.log('▶ Run vetAllDraft() again to continue from row ' + i + '.');
      return;
    }

    const row = data[i];
    if (!row[COL.ID - 1]) continue;
    const status = String(row[COL.STATUS - 1] || '').trim();

    // Promote Draft → Pending
    if (status === 'Draft') {
      sheet.getRange(i + 1, COL.STATUS).setValue('Pending');
      row[COL.STATUS - 1] = 'Pending';
      promoted++;
    }

    // Vet anything that is now Pending
    if (row[COL.STATUS - 1] === 'Pending') {
      try {
        Logger.log('[VET] Row ' + i + '/' + total + ': ' + row[COL.ADDRESS - 1]);
        vetRow(sheet, row, i + 1, apiKey);
        vetted++;
        Utilities.sleep(1200); // stay within Anthropic rate limits
      } catch(err) {
        Logger.log('  ✗ Error on row ' + i + ': ' + err.message);
        sheet.getRange(i + 1, COL.AI_FLAGS).setValue('Vetting error: ' + err.message);
        errors++;
      }
    }
  }

  // ── All rows done ─────────────────────────────────────────────────────────
  props.deleteProperty('VET_RESUME_ROW');
  CacheService.getScriptCache().remove(CONFIG.CACHE_KEY);
  Logger.log('\n═══ Vetting Complete — all rows processed ═══');
  Logger.log('Promoted Draft → Pending: ' + promoted);
  Logger.log('Vetted this run:          ' + vetted);
  Logger.log('Errors:                   ' + errors);
  Logger.log('Rows scoring ≥ 35 → Pending (review manually). Rows < 35 → auto-Rejected.');
  Logger.log('Removing rejected rows…');
  removeRejected();
}

// ── RESET VET PROGRESS ────────────────────────────────────────────────────
// Run this to start over from row 1, or if a previous run left a stale pointer.
function resetVetProgress() {
  PropertiesService.getScriptProperties().deleteProperty('VET_RESUME_ROW');
  Logger.log('Progress reset. Run vetAllDraft() to start from the beginning.');
}


// ── VET A SINGLE ROW ──────────────────────────────────────────────────────
function vetRow(sheet, row, rowNum, apiKey) {
  const cell = n => row[n - 1];
  const lat = parseFloat(cell(COL.LAT));
  const lng = parseFloat(cell(COL.LNG));
  const address = cell(COL.ADDRESS) + ', ' + cell(COL.CITY) + ', ' + cell(COL.STATE);

  // 1. Listing status check — reject immediately if not found on any listing site
  const listingResult = checkListingStatus(cell(COL.ADDRESS), cell(COL.CITY), cell(COL.STATE));
  if (listingResult.listed === false) {
    // Not found on LoopNet/Crexi/CoStar — not actively for sale, skip remaining checks
    sheet.getRange(rowNum, COL.STATUS).setValue('Rejected');
    sheet.getRange(rowNum, COL.AI_FLAGS).setValue('Not listed for sale: ' + listingResult.source);
    sheet.getRange(rowNum, COL.LISTING_SOURCE).setValue(listingResult.source);
    sheet.getRange(rowNum, COL.LAST_VETTED).setValue(new Date().toISOString());
    Logger.log('  ✗ Not listed — rejected: ' + cell(COL.ADDRESS));
    return; // skip EPA + AI to save quota
  }

  // 2. EPA ECHO check
  let epaCount = 0;
  let epaFlag = 'clean';
  try {
    const epaResult = checkEpa(lat, lng);
    epaCount = epaResult.count;
    epaFlag = epaResult.flag;
  } catch(e) { /* EPA check failed, leave existing value */ }

  // 3. Build property context for AI scoring
  const propContext = {
    id: cell(COL.ID), address, price: cell(COL.PRICE),
    lotSqFt: cell(COL.LOT_SQFT), bldgSqFt: cell(COL.BLDG_SQFT),
    zoning: cell(COL.ZONING), zoningLabel: cell(COL.ZONING_LABEL),
    propertyType: cell(COL.PROPERTY_TYPE), currentUse: cell(COL.CURRENT_USE),
    isVacant: cell(COL.IS_VACANT), vacantSince: cell(COL.VACANT_SINCE),
    isGrandfathered: cell(COL.IS_GRANDFATHERED),
    epaStatus: epaFlag, epaFacilitiesNearby: epaCount,
    titleFlags: cell(COL.TITLE_FLAGS), deedRestrictions: cell(COL.DEED_RESTRICTIONS),
    fleetSuitable: cell(COL.FLEET_SUITABLE), description: cell(COL.DESCRIPTION),
    state: cell(COL.STATE), county: cell(COL.COUNTY),
    // Listing info — confirmed listed properties score higher
    listingConfirmed: listingResult.listed === true,
    listingSource: listingResult.source || '',
  };

  // 4. AI score + flags + summary
  let aiScore = '', aiFlags = '', aiSummary = '';
  if (apiKey) {
    const aiResult = callClaude(propContext, apiKey);
    aiScore = aiResult.score;
    aiFlags = aiResult.flags;
    aiSummary = aiResult.summary;
  }

  // 5. Write results back to sheet
  sheet.getRange(rowNum, COL.EPA_STATUS).setValue(epaFlag);
  sheet.getRange(rowNum, COL.EPA_FACILITY_COUNT).setValue(epaCount);
  sheet.getRange(rowNum, COL.LISTING_SOURCE).setValue(listingResult.source || '');
  sheet.getRange(rowNum, COL.AI_SCORE).setValue(aiScore);
  sheet.getRange(rowNum, COL.AI_FLAGS).setValue(aiFlags);
  sheet.getRange(rowNum, COL.AI_SUMMARY).setValue(aiSummary);
  sheet.getRange(rowNum, COL.LAST_VETTED).setValue(new Date().toISOString());

  // Auto-reject if AI score is very low — clearly not an automotive property.
  // Anything ≥ 35 stays Pending for your manual review; you then Approve or Reject.
  const AUTO_REJECT_THRESHOLD = 35;
  if (aiScore !== '' && parseInt(aiScore) < AUTO_REJECT_THRESHOLD) {
    sheet.getRange(rowNum, COL.STATUS).setValue('Rejected');
    Logger.log('  ✗ Auto-rejected (score ' + aiScore + '): ' + cell(COL.ADDRESS));
  }
}

// ── EPA ECHO API CHECK ────────────────────────────────────────────────────
function checkEpa(lat, lng) {
  const url = CONFIG.EPA_ECHO_BASE +
    '?output=JSON&p_st=WA,OR,CA' +
    '&p_lat=' + lat + '&p_long=' + lng +
    '&p_radius=' + CONFIG.EPA_RADIUS_MILES;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(response.getContentText());
  const facilities = (data.Results && data.Results.Facilities) || [];
  const count = facilities.length;

  // Heuristic flag: if any nearby facility has RCRA violations, flag as brownfield risk
  const hasViolations = facilities.some(f =>
    f.RCRACompStatus === 'V' || f.CWACompStatus === 'V' || f.CAACompStatus === 'V'
  );
  const flag = count === 0 ? 'clean' : hasViolations ? 'flagged' : 'clean';
  return { count, flag };
}

// ── LISTING STATUS CHECK ──────────────────────────────────────────────────
// Searches LoopNet, Crexi, and CoStar for the property address using the
// Google Custom Search API (free — 100 queries/day on the free tier).
//
// SETUP (one-time):
//   1. Go to https://console.cloud.google.com → Enable "Custom Search API"
//   2. Create an API key → copy it
//   3. Go to https://programmablesearchengine.google.com → New search engine
//      → Search the entire web → copy the Search engine ID (cx)
//   4. In Apps Script → Project Settings → Script Properties, add:
//        GOOGLE_SEARCH_API_KEY  →  your API key
//        GOOGLE_SEARCH_CX       →  your Search engine ID
//
// Returns: { listed: true/false/null, source: 'url or reason' }
// null means the API keys aren't configured — property is left as-is.
function checkListingStatus(address, city, state) {
  const props  = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GOOGLE_SEARCH_API_KEY');
  const cx     = props.getProperty('GOOGLE_SEARCH_CX');

  if (!apiKey || !cx) {
    return { listed: null, source: 'Google Search API not configured' };
  }

  // Search for the address on the major commercial listing platforms
  const query = '"' + address + '" "' + city + '" "' + state + '" ' +
    '(site:loopnet.com OR site:crexi.com OR site:costar.com OR ' +
    'site:commercialcafe.com OR site:cityfeet.com)';

  const url = 'https://www.googleapis.com/customsearch/v1' +
    '?key=' + encodeURIComponent(apiKey) +
    '&cx='  + encodeURIComponent(cx) +
    '&num=3' +
    '&q='   + encodeURIComponent(query);

  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(response.getContentText());

    if (data.error) {
      Logger.log('  ⚠ Listing API error: ' + data.error.message);
      return { listed: null, source: 'Search API error: ' + data.error.message };
    }

    if (data.items && data.items.length > 0) {
      const topResult = data.items[0];
      Logger.log('  ✔ Listed: ' + topResult.link);
      return { listed: true, source: topResult.link };
    }

    Logger.log('  ✘ Not found on listing sites');
    return { listed: false, source: 'Not found on LoopNet/Crexi/CoStar' };

  } catch(e) {
    Logger.log('  ⚠ Listing check failed: ' + e.message);
    return { listed: null, source: 'Check failed: ' + e.message };
  }
}


// ── REMOVE REJECTED ROWS ──────────────────────────────────────────────────
// Deletes every row in the sheet where STATUS = 'Rejected'.
// Iterates bottom-up so row index shifting doesn't skip rows.
// Run this manually after a vetting pass, or call it at the end of vetAllDraft().
function removeRejected() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) { Logger.log('ERROR: Sheet not found.'); return; }

  const data = sheet.getDataRange().getValues();
  let removed = 0;

  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][COL.STATUS - 1]).trim() === 'Rejected') {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }

  CacheService.getScriptCache().remove(CONFIG.CACHE_KEY);
  Logger.log('Removed ' + removed + ' rejected row(s). Sheet now has ' + (sheet.getLastRow() - 1) + ' properties.');
}


// ── CLAUDE AI SCORING ─────────────────────────────────────────────────────
function callClaude(prop, apiKey) {
  const prompt = `You are an automotive commercial real estate analyst for ARES (Automotive Real Estate Solutions).

Evaluate this property for automotive use along the I-5 corridor. Return ONLY valid JSON — no markdown, no preamble.

Property data: ${JSON.stringify(prop)}

Return this exact JSON structure:
{
  "score": <integer 0-100, where 100 = ideal automotive CRE property>,
  "flags": "<2-4 sentence plain-language summary of risks and red flags. Lead with the most important issue. If none, say 'No major flags identified.'>",
  "summary": "<3-5 sentence plain-language property intelligence summary suitable for an operator evaluating this site. Cover EPA status, zoning, grandfathered risk, and any title issues. Write for a business owner, not a lawyer.>"
}

Scoring guidance:
- Score 0–20: Property is clearly NOT automotive — office building, medical/retail/restaurant use, wrong zoning entirely
- Score 20–35: Generic commercial zoning with no automotive indicators — probably not useful
- Score 35–60: Commercial/industrial zoning plausibly compatible with automotive use; needs inspection
- Score 60–80: Good automotive signals — industrial zoning, prior auto use, or fleet-suitable features
- Score 80–100: Ideal — auto-specific zoning (M1/M2/CG), EPA clean, active automotive use, I-5 access
- Penalize heavily: brownfield status, critical grandfathered vacancy risk, deed restrictions blocking automotive use, clearly non-automotive current use (office, medical, etc.)
- Penalize moderately: EPA flagged, grandfathered high/moderate risk, title flags, no title data, generic C1 zoning
- Reward: confirmed listing on LoopNet/Crexi/CoStar (listingConfirmed=true), auto-specific zoning, EPA clean, fleet-suitable, active automotive use, M1/M2/CG/IL zoning, I-5 corridor access
- Note: if listingConfirmed is true, mention the listing source in your summary so the buyer knows where to find it`;

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(response.getContentText());
  if (!data.content || !data.content[0]) return { score: '', flags: 'AI unavailable', summary: '' };

  try {
    const parsed = JSON.parse(data.content[0].text);
    return { score: parsed.score || '', flags: parsed.flags || '', summary: parsed.summary || '' };
  } catch(e) {
    return { score: '', flags: 'AI parse error: ' + e.message, summary: '' };
  }
}

// ── UTILITY: Manually bust the cache (run from Apps Script editor) ─────────
function bustCache() {
  CacheService.getScriptCache().remove(CONFIG.CACHE_KEY);
  Logger.log('Cache cleared.');
}

// ── UTILITY: Test the feed output (run from Apps Script editor) ────────────
function testFeed() {
  const feed = buildFeed();
  Logger.log('Properties in feed: ' + feed.count);
  Logger.log(JSON.stringify(feed).substring(0, 500));
}

// ═══════════════════════════════════════════════════════════════════════════
// ── COUNTY GIS AUTO-IMPORTER ───────────────────────────────────────────────
// Fetches commercial/industrial parcels from each county's public ArcGIS
// REST service, deduplicates against the sheet, and writes new rows as
// Status='Draft' so you can review them before triggering AI vetting.
//
// HOW TO RUN:
//   • Manual:  open Apps Script editor → select importFromCountyGIS → Run
//   • Trigger: Apps Script → Triggers → Add Trigger
//              Function: importFromCountyGIS
//              Time-driven: Day timer, e.g. 3am daily
//
// HOW TO ADD A MISSING ENDPOINT:
//   Find the county in COUNTY_SOURCES below (search "TODO"),
//   paste the FeatureServer/0/query URL, and update the 'where' clause.
//   To find an endpoint: go to the county's ArcGIS open data portal,
//   click on the Parcels dataset, then click "I want to use this" → API.
// ═══════════════════════════════════════════════════════════════════════════

// ── COUNTY SOURCES ────────────────────────────────────────────────────────
// Each entry = one county's public ArcGIS parcel layer.
//
// url:         Full /query endpoint (null = not yet configured, will skip)
// state:       'WA', 'OR', or 'CA'
// county:      Must exactly match the county values in property-search.html
// where:       ArcGIS SQL WHERE clause to filter commercial/industrial parcels
//              Tune this if you get too many or too few results.
// maxFeatures: Max records pulled per run (keeps runs fast; increase as needed)
// idPrefix:    Used to auto-generate property IDs (e.g. 'WA', 'OR', 'CA')
// acresField:  If lot size is stored in acres, name it here (× 43560 → sqft)
//
const COUNTY_SOURCES = [

  // ── WASHINGTON ────────────────────────────────────────────────────────

  {
    county: 'Thurston', state: 'WA', idPrefix: 'WA',
    // Thurston has no ZONING column; PROP_TYPE codes: C=Commercial, I=Industrial,
    // 4=Manufacturing.  CURR_USE mirrors these values.
    url: 'https://map.co.thurston.wa.us/arcgis/rest/services/Thurston/Thurston_Parcels/FeatureServer/0/query',
    where: "PROP_TYPE IN ('COM','IND','MNF','COMM') OR USE_CODE LIKE '2%' OR USE_CODE LIKE '3%'",
    maxFeatures: 200,
    acresField: 'TOTAL_ACRES',
  },

  {
    county: 'King', state: 'WA', idPrefix: 'WA',
    // King County parcel area layer — includes zoning and use classification.
    // PRESENTUSE codes: 23=Park/Rec, 300-399=Commercial, 400-499=Industrial.
    // Filter on 300-499 to catch retail-auto, service, light industrial.
    url: 'https://gisdata.kingcounty.gov/arcgis/rest/services/OpenDataPortal/property__parcel_address_area/MapServer/1722/query',
    where: "PROPTYPE IN ('C','I')",
    maxFeatures: 200,
  },

  {
    county: 'Pierce', state: 'WA', idPrefix: 'WA',
    // TODO: Paste the Pierce County Tax Parcels FeatureServer URL here.
    // Find it at: https://gisdata-piercecowa.opendata.arcgis.com/
    //   → Parcels dataset → I want to use this → ArcGIS GeoServices REST API
    url: null,
    where: "ZONE_TYPE LIKE 'M%' OR ZONE_TYPE LIKE 'C%' OR LANDUSE LIKE '%INDUSTRIAL%' OR LANDUSE LIKE '%COMMERCIAL%'",
    maxFeatures: 200,
  },

  {
    county: 'Snohomish', state: 'WA', idPrefix: 'WA',
    // TODO: Paste the Snohomish County Parcels FeatureServer URL here.
    // Find it at: https://snohomish-county-open-data-portal-snoco-gis.hub.arcgis.com/
    //   → All Parcels dataset → I want to use this → ArcGIS GeoServices REST API
    url: null,
    where: "ZONING LIKE 'M%' OR ZONING LIKE 'LI%' OR ZONING LIKE 'I%' OR ZONING LIKE 'B%' OR ZONING LIKE 'C%'",
    maxFeatures: 200,
  },

  {
    county: 'Clark', state: 'WA', idPrefix: 'WA',
    // Clark County public taxlots. ArcGIS LIKE filtering is unreliable here —
    // all server-side WHERE attempts returned 0 results even for broad patterns.
    // Solution: fetch all (WHERE=1=1, capped at maxFeatures) then filter client-side
    // in importFromCountyGIS using rejectUsePatterns against the raw propertyuseclass value.
    url: 'https://gis.clark.wa.gov/arcgisfed/rest/services/Hosted/TaxlotsPublic_Singlepart/FeatureServer/0/query',
    where: '1=1',
    maxFeatures: 400,
    rejectUsePatterns: ['RESIDENTIAL', 'RURAL', 'AGRICULT', 'FARM', 'TIMBER', 'FOREST', 'VACANT LAND', 'OPEN SPACE'],
  },

  {
    county: 'Kitsap', state: 'WA', idPrefix: 'WA',
    // TODO: Paste the Kitsap County Parcel FeatureServer URL here.
    // Find it at: https://kitsap-od-kitcowa.hub.arcgis.com/
    //   → search "parcel" → dataset → I want to use this → ArcGIS GeoServices REST API
    url: null,
    where: "ZONING LIKE 'M%' OR ZONING LIKE 'I%' OR ZONING LIKE 'C%'",
    maxFeatures: 200,
  },

  {
    county: 'Whatcom', state: 'WA', idPrefix: 'WA',
    // TODO: Paste the Whatcom County Parcel FeatureServer URL here.
    // Find it at: https://www.whatcomcounty.us/716/Data
    url: null,
    where: "ZONING LIKE 'M%' OR ZONING LIKE 'I%' OR ZONING LIKE 'BP%'",
    maxFeatures: 200,
  },

  // ── OREGON ────────────────────────────────────────────────────────────

  {
    county: 'Multnomah', state: 'OR', idPrefix: 'OR',
    // Multnomah County DART taxlots (WebMercator).  IG=General Industrial,
    // IH=Heavy Industrial, CG=General Commercial (allows auto dealers + service).
    url: 'https://www3.multco.us/gisagspublic/rest/services/DART/Taxlots_WebMerc/MapServer/0/query',
    where: "ZONING IN ('IG','IH','EX','CG','CI') OR ZONING LIKE 'I%' OR ZONING LIKE 'CG%'",
    maxFeatures: 200,
  },

  {
    county: 'Washington', state: 'OR', idPrefix: 'OR',
    // TODO: Paste the Washington County OR Parcel FeatureServer URL here.
    // Find it at: https://www.co.washington.or.us/AssessmentTaxation/PropertySearch/
    // or search: https://hub.arcgis.com/search?q=Washington%20County%20Oregon%20parcels
    url: null,
    where: "ZONING LIKE 'IND%' OR ZONING LIKE 'COM%' OR ZONING LIKE 'I%' OR ZONING LIKE 'GI%'",
    maxFeatures: 200,
  },

  {
    county: 'Clackamas', state: 'OR', idPrefix: 'OR',
    // TODO: Paste the Clackamas County Parcel FeatureServer URL here.
    // Find it at: https://www.clackamas.us/gis/data-portal
    url: null,
    where: "ZONE_CODE LIKE 'IND%' OR ZONE_CODE LIKE 'EFU%' OR ZONE_CODE LIKE 'I%'",
    maxFeatures: 200,
  },

  {
    county: 'Marion', state: 'OR', idPrefix: 'OR',
    // TODO: Paste the Marion County Parcel FeatureServer URL here.
    // Find it at: https://gis.co.marion.or.us or search ArcGIS Hub for Marion County OR parcels
    url: null,
    where: "PROP_CLASS LIKE 'COM%' OR PROP_CLASS LIKE 'IND%' OR PROP_CLASS LIKE 'MAN%'",
    maxFeatures: 200,
  },

  {
    county: 'Lane', state: 'OR', idPrefix: 'OR',
    // TODO: Paste the Lane County Parcel FeatureServer URL here.
    // Find it at: https://www.lanecounty.org/government/county_departments/assessment_taxation
    url: null,
    where: "ZONE LIKE 'I%' OR ZONE LIKE 'CI%' OR ZONE LIKE 'GO%'",
    maxFeatures: 200,
  },

  {
    county: 'Jackson', state: 'OR', idPrefix: 'OR',
    // TODO: Paste the Jackson County Parcel FeatureServer URL here.
    // Find it at: https://gis.jacksoncountyor.gov/ → open data / layers
    url: null,
    where: "ZONE_CODE LIKE 'I%' OR ZONE_CODE LIKE 'C%' OR ZONE_CODE LIKE 'M%'",
    maxFeatures: 200,
  },

  // ── CALIFORNIA ────────────────────────────────────────────────────────

  {
    county: 'Siskiyou', state: 'CA', idPrefix: 'CA',
    // TODO: Paste the Siskiyou County Parcel FeatureServer URL here.
    // Find it at: https://www.co.siskiyou.ca.us/gis
    url: null,
    where: "ZONE_CODE LIKE 'M%' OR ZONE_CODE LIKE 'I%' OR ZONE_CODE LIKE 'C%'",
    maxFeatures: 200,
  },

  {
    county: 'Shasta', state: 'CA', idPrefix: 'CA',
    // Shasta County public parcel lookup — includes APN, address, use code.
    // Prop class codes: 300s = commercial, 400s = industrial.
    // maps.co.shasta.ca.us blocks requests from Google servers.
    // TODO: find hosted FeatureServer at https://data-shasta.opendata.arcgis.com/
    url: null,
    where: "(PROPCLASS >= 300 AND PROPCLASS < 500) OR ZONING LIKE 'M%' OR ZONING LIKE 'I%'",
    maxFeatures: 200,
  },

  {
    county: 'Sacramento', state: 'CA', idPrefix: 'CA',
    // TODO: Paste the Sacramento County Parcel FeatureServer URL here.
    // Find it at: https://data-sacramentocounty.opendata.arcgis.com/
    //   → search "parcels" → Parcels dataset → API → ArcGIS GeoServices REST API
    url: null,
    where: "ZONING LIKE 'M%' OR ZONING LIKE 'I%' OR ZONING LIKE 'C2%' OR ZONING LIKE 'C3%'",
    maxFeatures: 200,
  },

  {
    county: 'San Joaquin', state: 'CA', idPrefix: 'CA',
    // TODO: Paste the San Joaquin County Parcel FeatureServer URL here.
    // Find it at: https://opendata.sjgov.org/ or https://san-joaquin-county-public-works-sjc-gis.hub.arcgis.com/
    url: null,
    where: "ZONE_CODE LIKE 'M%' OR ZONE_CODE LIKE 'I%' OR ZONE_CODE LIKE 'C%'",
    maxFeatures: 200,
  },

  {
    county: 'Fresno', state: 'CA', idPrefix: 'CA',
    // Fresno City/County GIS — AddrParcelStreet FeatureServer layer 0 = Parcels.
    // No ZONING field in this layer; filter by LANDUSE (numeric DOR codes).
    // 3000-3999 = commercial, 4000-4999 = industrial/manufacturing.
    url: 'https://gis4u.fresno.gov/arcgis/rest/services/PublicInfoServices/AddrParcelStreet/FeatureServer/0/query',
    where: "EXISTING_LAND_USE_TEXT LIKE '%industrial%' OR EXISTING_LAND_USE_TEXT LIKE '%commercial%' OR EXISTING_LAND_USE_TEXT LIKE '%warehouse%' OR EXISTING_LAND_USE_TEXT LIKE '%manufacturing%' OR ZONING_STRING LIKE 'M%' OR ZONING_STRING LIKE 'I%'",
    maxFeatures: 200,
  },

  {
    county: 'Los Angeles', state: 'CA', idPrefix: 'CA',
    // TODO: Paste the LA County Parcel FeatureServer URL here.
    // The official source is egis-lacounty.hub.arcgis.com
    //   → search "parcel" → Parcels dataset → View API resources → FeatureServer
    url: null,
    where: "UseType IN ('Industrial','Light Manufacturing','Heavy Manufacturing','Commercial') OR ZoneCode LIKE 'M%' OR ZoneCode LIKE 'C2%' OR ZoneCode LIKE 'C3%'",
    maxFeatures: 200,
  },

  {
    county: 'San Diego', state: 'CA', idPrefix: 'CA',
    // San Diego County all-parcels MapServer.  Filters on PROPTYPE for
    // commercial (C) and industrial (I) land use classifications.
    // San Diego PARCELS_ALL requires auth token — not publicly accessible.
    // TODO: find a token-free endpoint at https://www.sangis.org/ or https://sdgis-sandag.opendata.arcgis.com/
    url: null,
    where: "LAND_USE LIKE '%COMMERCIAL%' OR LAND_USE LIKE '%INDUSTRIAL%' OR LAND_USE LIKE '%MANUFACTURING%' OR PROPTYPE IN ('COMMERCIAL','INDUSTRIAL')",
    maxFeatures: 200,
  },

];


// ── MAIN IMPORT FUNCTION ──────────────────────────────────────────────────
/**
 * Iterates COUNTY_SOURCES, fetches commercial/industrial parcels from each
 * county's public ArcGIS service, deduplicates, and appends new rows to the
 * Properties sheet with Status='Draft'.
 *
 * Run manually or via a daily time-based Apps Script trigger.
 * After running, review Draft rows in the sheet, promote to Pending to trigger
 * AI vetting, then Approve to publish to the website.
 */

// ── AUTOMOTIVE QUALITY FILTERS ────────────────────────────────────────────
// Applied globally to every county during import.
//
// GLOBAL_REJECT_USES: If the parcel's currentUse contains any of these strings,
// skip it immediately — it's clearly not an automotive property.
const GLOBAL_REJECT_USES = [
  'OFFICE', 'OFFICES', 'MEDICAL', 'CLINIC', 'HOSPITAL', 'DENTAL',
  'RESTAURANT', 'FOOD', 'BAKERY', 'CAFE', 'BAR ', 'TAVERN',
  'HOTEL', 'MOTEL', 'LODGING', 'APARTMENT', 'CONDO', 'MULTIFAMILY',
  'CHURCH', 'RELIGIOUS', 'SCHOOL', 'UNIVERSITY', 'DAYCARE', 'LIBRARY',
  'BANK', 'FINANCIAL', 'INSURANCE',
  'GROCERY', 'SUPERMARKET', 'PHARMACY',
  'GOLF', 'MARINA', 'PARK ', 'CEMETERY',
];

// AUTOMOTIVE_HINTS: At least ONE of these must appear in the parcel's zoning
// OR currentUse — otherwise the parcel is too generic to be worth importing.
// This catches plain "C" commercial zoning with an office use description.
const AUTOMOTIVE_HINTS = [
  // Zoning codes that explicitly allow automotive / heavy commercial
  'M1', 'M-1', 'M2', 'M-2', 'M3', 'M-3',
  'IL', 'IH', 'LI', 'HI', 'IND', 'INDUSTRIAL', 'MANUFACTUR',
  'CG', 'GC', 'C2', 'C-2', 'C3', 'C-3', 'CB', 'CS', 'CH',
  'AUTO', 'VEHICLE', 'DEALER', 'SERVICE', 'REPAIR', 'GARAGE',
  'FLEET', 'TRANSPORT', 'TRUCK', 'TOWING', 'SALVAGE', 'BODY SHOP',
  'TIRE', 'LUBE', 'CARWASH', 'CAR WASH', 'FUELING', 'GAS STAT',
  'COMMERCIAL VEHICLE', 'HEAVY COMMERCIAL',
];

function importFromCountyGIS() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) { Logger.log('ERROR: Sheet "' + CONFIG.SHEET_NAME + '" not found.'); return; }

  const existingAddresses = getExistingAddresses(sheet);
  let totalAdded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  COUNTY_SOURCES.forEach(function(source) {
    if (!source.url) {
      Logger.log('[SKIP] ' + source.county + ' ' + source.state + ': no URL configured (see TODO in COUNTY_SOURCES).');
      return;
    }

    Logger.log('[FETCH] ' + source.county + ', ' + source.state + ' → ' + source.url);

    try {
      const features = fetchCountyParcels(source);
      Logger.log('  → ' + features.length + ' features returned from GIS');

      features.forEach(function(feature) {
        try {
          const row = parseGisFeature(feature, source);
          if (!row) return; // unparseable — skip

          // Per-source use-class filter (e.g. Clark WA where server-side WHERE is unreliable).
          if (source.rejectUsePatterns && source.rejectUsePatterns.length) {
            const useUpper = (row.currentUse || '').toUpperCase();
            const rejected = source.rejectUsePatterns.some(function(p) { return useUpper.indexOf(p) !== -1; });
            if (rejected) { totalSkipped++; return; }
          }

          // Global non-automotive reject filter — skip obvious office/retail/medical/etc.
          const useCheck = (row.currentUse || '').toUpperCase();
          const globalRejected = GLOBAL_REJECT_USES.some(function(p) { return useCheck.indexOf(p) !== -1; });
          if (globalRejected) {
            Logger.log('  [SKIP non-auto] ' + row.address + ' (' + row.currentUse + ')');
            totalSkipped++;
            return;
          }

          // Automotive signal check — at least one automotive/industrial hint must appear
          // in zoning or currentUse, otherwise the parcel is too generic (e.g. plain "C" + "Office").
          const zoningCheck = (row.zoning || '').toUpperCase();
          const hasAutoHint = AUTOMOTIVE_HINTS.some(function(h) {
            return zoningCheck.indexOf(h) !== -1 || useCheck.indexOf(h) !== -1;
          });
          if (!hasAutoHint) {
            Logger.log('  [SKIP no-hint] ' + row.address + ' (zoning: ' + row.zoning + ', use: ' + row.currentUse + ')');
            totalSkipped++;
            return;
          }

          // Skip if address is blank or already in sheet
          if (!row.address || row.address.length < 5) return;
          const dedupKey = (row.address + ',' + row.county + ',' + row.state).toUpperCase().trim();
          if (existingAddresses.has(dedupKey)) {
            totalSkipped++;
            return;
          }

          // Generate a unique ID for this property
          row.id = generatePropertyId(source.idPrefix, sheet);

          appendRow(sheet, row);
          existingAddresses.add(dedupKey);
          totalAdded++;
          Logger.log('  ✓ Added: ' + row.id + ' — ' + row.address + ', ' + row.city);

        } catch (featureErr) {
          Logger.log('  ✗ Feature parse error: ' + featureErr.message);
          totalErrors++;
        }
      });

    } catch (fetchErr) {
      Logger.log('[ERROR] ' + source.county + ': ' + fetchErr.message);
      totalErrors++;
    }

    Utilities.sleep(500); // be polite to county servers
  });

  // Bust the cache so any newly-approved properties appear immediately
  CacheService.getScriptCache().remove(CONFIG.CACHE_KEY);

  Logger.log('\n═══ Import Complete ═══');
  Logger.log('Added:   ' + totalAdded);
  Logger.log('Skipped: ' + totalSkipped + ' (already in sheet)');
  Logger.log('Errors:  ' + totalErrors);
}


// ── FETCH PARCELS FROM ONE COUNTY ─────────────────────────────────────────
function fetchCountyParcels(source) {
  const params = {
    where:           source.where || '1=1',
    outFields:       '*',
    returnGeometry:  'true',
    geometryType:    'esriGeometryEnvelope',
    spatialRel:      'esriSpatialRelIntersects',
    outSR:           '4326',   // WGS84 — gives us lat/lng directly
    f:               'json',
    resultRecordCount: String(source.maxFeatures || 200),
  };

  // Build query string
  const qs = Object.keys(params).map(function(k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');

  const response = UrlFetchApp.fetch(source.url + '?' + qs, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'ARES-GIS-Importer/1.0' },
  });

  const http = response.getResponseCode();
  if (http !== 200) {
    throw new Error('HTTP ' + http + ' from ' + source.url);
  }

  const data = JSON.parse(response.getContentText());
  if (data.error) {
    throw new Error('ArcGIS error: ' + JSON.stringify(data.error));
  }

  return data.features || [];
}


// ── PARSE ONE GIS FEATURE → ARES SHEET ROW ────────────────────────────────
function parseGisFeature(feature, source) {
  if (!feature || !feature.attributes) return null;
  const a = feature.attributes;

  // ── Coordinates — try geometry first, then attribute fields
  let lat = 0, lng = 0;
  const coords = getLatLng(feature);
  lat = coords.lat;
  lng = coords.lng;

  // If geometry came back empty, try Census geocoder (costs a fetch — skip if no address)
  const rawAddress = pickField(a,
    'SITE_ADDR','SITE_ADD','SITUS_ADDR','SITUS','ADDRESS1','ADDRESS','PROP_ADDR',
    'SITUS_STRE','FULL_ADDR','STR_ADDR','MAIL_ADDR','LOCATION','ADDR',
    'ADDR_FULL','situsaddrsfull','situsaddrs','SITUSADDR',
    // Clark WA / common WA variants
    'siteaddress','SITEADDRESS','site_address','SITE_ADDRESS',
    'parcel_addr','PARCEL_ADDR','propertyaddress','PROPERTYADDRESS',
    'TAXLOT_ADDR','taxlot_addr','OWNER_ADDR','PHYSICAL_ADDR',
    // Oregon variants
    'PROP_STREET','SITUS_STREET','situs_street','STREETADDRESS',
    // California variants
    'SITE_STNAME','AIN','SITUS1','situs1','LOCATION_1'
  ) || '';

  if ((!lat || !lng) && rawAddress) {
    try {
      const gc = geocodeAddress(rawAddress + ', ' + source.county + ', ' + source.state);
      lat = gc.lat;
      lng = gc.lng;
    } catch(e) { /* geocoding failed — lat/lng stays 0 */ }
  }

  // ── Lot size — may be acres or sqft depending on county
  let lotSqFt = parseFloat(pickField(a,
    'LOT_SIZE','LOT_SQFT','LOTSIZE','SHAPE_AREA','CALC_AREA','GIS_AREA','AREA_SQ_FT',
    'SHAPESTAREA','SHAPE__AREA','LOTSQFT','gissqft','assrsqft','SIZESQFT'
  )) || 0;

  // If county stores acres, convert
  if (source.acresField) {
    const acresVal = parseFloat(a[source.acresField]);
    if (!isNaN(acresVal) && acresVal > 0) lotSqFt = Math.round(acresVal * 43560);
  }

  // Small sanity check: if it looks like the raw value was already in acres
  // (common — e.g., 0.42 when we expected sqft), convert.
  if (lotSqFt > 0 && lotSqFt < 5) lotSqFt = Math.round(lotSqFt * 43560);

  // ── Other fields
  const city = String(pickField(a,
    'CITY','SITUS_CITY','SITE_CITY','PROP_CITY','MAIL_CITY','CITYNAME','CITY_NAME',
    'CTYNAME','KCTP_CITY','situscity','SITUSCITY',
    // Clark WA / common WA variants
    'sitecity','SITECITY','JURISDICTION','jurisdiction',
    'INCORPORATED','CITY_UNINCORPORATED','MAIL_CITY_NAME',
    // Oregon / California
    'PROP_CITY_NAME','SITUS_CITY_NAME','CITY_OR_UNINC'
  ) || '').trim();

  const zip = String(pickField(a,
    'ZIP','ZIPCODE','ZIP_CODE','SITUS_ZIP','PROP_ZIP','MAIL_ZIP','POSTAL_CODE',
    'ZIP5','situszip1','SITUSZIP',
    // Clark WA / common variants
    'sitezip','SITEZIP','SITE_ZIP','ZIPCODE5','zip5','ZIP_5',
    'PROP_ZIP_CODE','SITUS_ZIPCODE','MAIL_ZIPCODE'
  ) || '').replace(/\D/g, '').substring(0, 5);

  const parcelId = String(pickField(a,
    'APN','PARCEL_NO','PARCELID','PARCELNUMBER','PARCEL_NUM','PIN',
    'TAXPARCELID','PARCEL_ID','APNNODASH','ACCOUNT_NO','ACCT_NUM',
    // Clark WA
    'parcel_id','taxparcel','TAXPARCEL','parcelno','PARCELNO',
    'assessorparcelno','ASSESSORPARCELNO','TaxlotID','TAXLOTID',
    // Oregon / California
    'MAPREF','mapref','MAP_TAXLOT','MAPTAXLOT','SITUS_APN','GIS_ACRES'
  ) || '');

  const zoning = String(pickField(a,
    'ZONING','ZONE','ZONE_CODE','ZONE_TYPE','ZONING_CODE','CURRENT_ZONING',
    'ZONING_CLASS','ZONE_CLASS','ZONING_DESIGNATION','PROP_TYPE','USE_TYPE',
    'LAND_USE_CODE','LANDUSE_CODE','KCA_ZONING','zonedesc','ZONING_STRING',
    // Clark WA / common WA variants
    'ZONECODE','zonecode','ZONE_ABBR','zone_abbr','ZONING_ABBR',
    'CompZone','COMPZONE','comp_zone','CURRENT_ZONE',
    // Oregon variants
    'COMP_PLAN','comp_plan','PLAN_DESIG','PLAN_DESIGNATION',
    // California variants
    'GeneralPlanDesignation','GENERAL_PLAN','GEN_PLAN','ZONE_DESC'
  ) || '').toUpperCase().trim();

  const zoningLabel = String(pickField(a,
    'ZONING_LABEL','ZONE_DESC','ZONE_NAME','ZONING_DESCRIPTION','LANDUSE_DESC',
    'LAND_USE_DESC','PROPTYPE_DESC','USE_DESC','DESCRIPTION'
  ) || '');

  const currentUse = String(pickField(a,
    'CURRENT_USE','CURR_USE','USE_CODE','LAND_USE','LANDUSE','PROP_USE',
    'PROPERTY_USE','USECLASS','USE_TYPE','PROPTYPE',
    'EXISTING_LAND_USE_TEXT','pt1desc','complandesc','PREUSE_DESC',
    // Clark WA — primary use class field
    'propertyuseclass','PROPERTYUSECLASS','PropertyUseClass',
    // Other common WA / OR / CA variants
    'PROP_USE_CODE','LAND_USE_DESC','LANDUSEDESC','USEDESC',
    'USECODEDESC','USE_DESCRIPTION','PROPERTY_CLASS',
    'PROP_CLASS','CLASS_DESC','CLASSIFICATIONDESC',
    'land_use_category','LAND_USE_CATEGORY','USE_CATEGORY'
  ) || '');

  const yearBuilt = parseInt(pickField(a,
    'YEAR_BUILT','YR_BLT','YRBUILT','YEAR_BLT','EFFECTIVE_YEAR','YR_BUILT',
    'EFF_YR_BUI','BUILT_YEAR','BLDGYEAR','bldgyrblt','ACTYEARBUILT'
  )) || 0;

  const bldgSqFt = parseFloat(pickField(a,
    'BLDG_SQFT','BLDGSQFT','LIVING_AREA','FLOOR_AREA','BLDG_AREA',
    'SQ_FT_TOT','TOTAL_BLDG_SQFT','BLDG_SF','GRSSQFT','bldgsqft','MAIN_SQFT','MAINAREA'
  )) || 0;

  // Assessed value as price proxy (free; real asking price requires paid data)
  const assessedValue = parseFloat(pickField(a,
    'ASSESSED_VALUE','TOTAL_VALUE','TOTVALUE','AV_TOTAL','TAXABLE_VALUE',
    'APRSDVALUE','TOTAL_AV','ASDVALUE','NET_VALUE','LAND_VALUE',
    'APPRLNDVAL','mkttotval','taxtotval','ROLLLAND'
  )) || 0;

  // ── Infer property type from zoning code
  const propType = inferPropertyType(zoning, currentUse);

  // ── Build description stub — AI vetting will fill in the real summary
  const addressLine = rawAddress + (city ? ', ' + city : '') + ', ' + source.state + ' ' + zip;
  const description = 'Imported from ' + source.county + ' County ' + source.state + ' Assessor. ' +
    'Parcel: ' + (parcelId || 'N/A') + '. ' +
    'Zoning: ' + (zoning || 'Unknown') + '. ' +
    'Lot: ' + (lotSqFt ? Math.round(lotSqFt).toLocaleString() + ' sqft' : 'N/A') + '. ' +
    'Assessed value: ' + (assessedValue ? '$' + Math.round(assessedValue).toLocaleString() : 'N/A') + '.';

  return {
    // id is set by importFromCountyGIS() after dedup check
    status:         'Draft',
    address:        rawAddress.trim(),
    city:           city,
    state:          source.state,
    county:         source.county,
    zip:            zip,
    lat:            lat,
    lng:            lng,
    price:          assessedValue,
    lotSqFt:        lotSqFt,
    bldgSqFt:       bldgSqFt,
    zoning:         zoning,
    zoningLabel:    zoningLabel,
    propertyType:   propType,
    currentUse:     currentUse,
    yearBuilt:      yearBuilt || '',
    isVacant:       '',   // unknown from GIS data
    vacantSince:    '',
    isGrandfathered:'',
    epaStatus:      '',   // filled by vetting
    fleetSuitable:  '',
    fleetFeatures:  '',
    titleFlags:     '',
    deedRestrictions:'',
    hasTitleData:   'FALSE',
    gfRiskFactors:  '',
    description:    description,
    listingSource:  source.county + ' County ' + source.state + ' Assessor (GIS)',
    aiScore:        '',
    aiFlags:        '',
    aiSummary:      '',
    epaFacilityCount: '',
    lastVetted:     '',
    notes:          'Auto-imported ' + new Date().toISOString().split('T')[0] +
                    '. APN: ' + (parcelId || 'N/A'),
  };
}


// ── GET LAT/LNG FROM FEATURE ──────────────────────────────────────────────
// ArcGIS returns outSR=4326 so x=lng, y=lat for point geometry.
// For polygon geometry, compute the centroid of the first ring.
function getLatLng(feature) {
  const g = feature.geometry;
  if (!g) return { lat: 0, lng: 0 };

  // Point geometry
  if (g.x !== undefined && g.y !== undefined) {
    return { lat: parseFloat(g.y) || 0, lng: parseFloat(g.x) || 0 };
  }

  // Polygon geometry — compute centroid of outer ring
  if (g.rings && g.rings.length > 0) {
    return computePolygonCentroid(g.rings[0]);
  }

  // Attribute fallbacks (some services embed centroid as attributes)
  const a = feature.attributes;
  const lat = parseFloat(pickField(a, 'LAT','LATITUDE','Y','POINT_Y','CENTER_LAT','CENTROID_Y')) || 0;
  const lng = parseFloat(pickField(a, 'LNG','LON','LONG','LONGITUDE','X','POINT_X','CENTER_LNG','CENTROID_X')) || 0;
  return { lat, lng };
}


// ── POLYGON CENTROID (arithmetic mean of ring vertices) ───────────────────
function computePolygonCentroid(ring) {
  if (!ring || ring.length === 0) return { lat: 0, lng: 0 };
  let sumX = 0, sumY = 0;
  ring.forEach(function(pt) { sumX += pt[0]; sumY += pt[1]; });
  return {
    lat: sumY / ring.length,
    lng: sumX / ring.length,
  };
}


// ── CENSUS GEOCODER (free, no API key) ────────────────────────────────────
// Used only as a fallback when the ArcGIS layer returns no geometry.
function geocodeAddress(address) {
  const base = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
  const qs = 'address=' + encodeURIComponent(address) + '&benchmark=2020&format=json';
  const res = UrlFetchApp.fetch(base + '?' + qs, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  const matches = (data.result && data.result.addressMatches) || [];
  if (matches.length === 0) throw new Error('No geocode match for: ' + address);
  const coords = matches[0].coordinates;
  return { lat: parseFloat(coords.y), lng: parseFloat(coords.x) };
}


// ── PICK FIRST NON-EMPTY FIELD FROM ATTRIBUTES ───────────────────────────
// Tries each candidate field name (case-insensitive against known variants).
function pickField(attrs) {
  var candidates = Array.prototype.slice.call(arguments, 1);
  for (var i = 0; i < candidates.length; i++) {
    var key = candidates[i];
    if (attrs[key] !== undefined && attrs[key] !== null && String(attrs[key]).trim() !== '') {
      return attrs[key];
    }
    // Try uppercase variant (some counties store field names in all caps)
    var keyUp = key.toUpperCase();
    if (keyUp !== key && attrs[keyUp] !== undefined && attrs[keyUp] !== null && String(attrs[keyUp]).trim() !== '') {
      return attrs[keyUp];
    }
  }
  return null;
}


// ── INFER PROPERTY TYPE FROM ZONING / USE CODE ───────────────────────────
// Maps raw zoning codes to ARES property type vocabulary.
function inferPropertyType(zoning, currentUse) {
  const z = (zoning || '').toUpperCase();
  const u = (currentUse || '').toUpperCase();

  if (z.match(/M-?2|HI|IH|HEAVY.IND/)) return 'industrial';
  if (z.match(/M-?1|LI|IL|LIGHT.IND/)) return 'industrial';
  if (z.match(/^I/))                    return 'industrial';
  if (z.match(/AUTO|VEHICLE|DEALER/))   return 'retail-auto';
  if (z.match(/C-?[23]|GC|CC|CG/))     return 'retail-auto';
  if (z.match(/^C/))                    return 'retail-auto';
  if (z.match(/BP|BUSINESS.PARK/))      return 'fleet';
  if (u.match(/FLEET|TRANSPORT|TRUCK/)) return 'fleet';
  if (u.match(/SERVICE.STATION|GAS/))   return 'retail-auto';
  if (u.match(/COMMERCIAL/))            return 'retail-auto';
  if (u.match(/INDUSTRIAL|MANUFACTUR/)) return 'industrial';
  return 'commercial-vehicle'; // broad fallback
}


// ── GET EXISTING ADDRESSES FROM SHEET (for deduplication) ─────────────────
function getExistingAddresses(sheet) {
  const data = sheet.getDataRange().getValues();
  const addresses = new Set();
  for (var i = 1; i < data.length; i++) {
    const row = data[i];
    const addr = row[COL.ADDRESS - 1];
    const county = row[COL.COUNTY - 1];
    const state  = row[COL.STATE  - 1];
    if (addr) {
      addresses.add((String(addr) + ',' + String(county) + ',' + String(state)).toUpperCase().trim());
    }
  }
  return addresses;
}


// ── GENERATE NEXT SEQUENTIAL PROPERTY ID ─────────────────────────────────
// Format: WA-001, OR-042, CA-007 …
// Scans existing IDs with the same prefix and returns next available number.
function generatePropertyId(prefix, sheet) {
  const data = sheet.getDataRange().getValues();
  let maxNum = 0;
  for (var i = 1; i < data.length; i++) {
    const id = String(data[i][COL.ID - 1] || '');
    const match = id.match(new RegExp('^' + prefix + '-(\\d+)$'));
    if (match) {
      const n = parseInt(match[1]);
      if (n > maxNum) maxNum = n;
    }
  }
  return prefix + '-' + String(maxNum + 1).padStart(3, '0');
}


// ── APPEND ROW TO SHEET ───────────────────────────────────────────────────
function appendRow(sheet, r) {
  sheet.appendRow([
    r.id,               // A  ID
    r.status,           // B  Status
    r.address,          // C  Address
    r.city,             // D  City
    r.state,            // E  State
    r.county,           // F  County
    r.zip,              // G  ZIP
    r.lat,              // H  Lat
    r.lng,              // I  Lng
    r.price,            // J  Price
    r.lotSqFt,          // K  Lot SqFt
    r.bldgSqFt,         // L  Bldg SqFt
    r.zoning,           // M  Zoning
    r.zoningLabel,      // N  Zoning Label
    r.propertyType,     // O  Property Type
    r.currentUse,       // P  Current Use
    r.yearBuilt,        // Q  Year Built
    r.isVacant,         // R  Is Vacant
    r.vacantSince,      // S  Vacant Since
    r.isGrandfathered,  // T  Is Grandfathered
    r.epaStatus,        // U  EPA Status
    r.fleetSuitable,    // V  Fleet Suitable
    r.fleetFeatures,    // W  Fleet Features
    r.titleFlags,       // X  Title Flags
    r.deedRestrictions, // Y  Deed Restrictions
    r.hasTitleData,     // Z  Has Title Data
    r.gfRiskFactors,    // AA GF Risk Factors
    r.description,      // AB Description
    r.listingSource,    // AC Listing Source
    r.aiScore,          // AD AI Score
    r.aiFlags,          // AE AI Flags
    r.aiSummary,        // AF AI Summary
    r.epaFacilityCount, // AG EPA Facility Count
    r.lastVetted,       // AH Last Vetted
    r.notes,            // AI Notes
  ]);
}


// ── DIAGNOSTIC: show exactly what fields are populated for each county ─────
// Run this when rows in the sheet are missing address / zoning / city etc.
// It fetches the first 3 features from each county, parses them through
// parseGisFeature, and logs which ARES fields are filled vs blank.
// This tells you exactly which field names need to be added to the pickField lists.
function diagnoseRow() {
  const configured = COUNTY_SOURCES.filter(function(s) { return s.url !== null; });
  configured.forEach(function(source) {
    Logger.log('\n══ ' + source.county + ', ' + source.state + ' ══');
    try {
      const features = fetchCountyParcels(source);
      Logger.log('Features from GIS: ' + features.length);
      if (!features.length) { Logger.log('  ⚠ 0 features — check WHERE clause'); return; }

      // Log raw attribute field names from the first feature
      const rawAttrs = features[0].attributes;
      Logger.log('RAW FIELDS AVAILABLE: ' + Object.keys(rawAttrs).join(', '));

      // Parse first 3 features and show which ARES fields are filled / blank
      features.slice(0, 3).forEach(function(f, idx) {
        const row = parseGisFeature(f, source);
        if (!row) { Logger.log('  Row ' + idx + ': unparseable'); return; }
        Logger.log('  Row ' + idx + ':');
        Logger.log('    address    : ' + (row.address    || '⚠ BLANK'));
        Logger.log('    city       : ' + (row.city       || '⚠ BLANK'));
        Logger.log('    zip        : ' + (row.zip        || '⚠ BLANK'));
        Logger.log('    lat/lng    : ' + row.lat + ' / ' + row.lng + ((!row.lat || !row.lng) ? '  ⚠ MISSING COORDS' : ''));
        Logger.log('    zoning     : ' + (row.zoning     || '⚠ BLANK'));
        Logger.log('    currentUse : ' + (row.currentUse || '⚠ BLANK'));
        Logger.log('    lotSqFt    : ' + (row.lotSqFt    || '⚠ BLANK'));
        Logger.log('    bldgSqFt   : ' + (row.bldgSqFt   || '⚠ BLANK'));
        Logger.log('    price      : ' + (row.price      || '⚠ BLANK'));
        Logger.log('    yearBuilt  : ' + (row.yearBuilt  || '⚠ BLANK'));
      });
    } catch(e) {
      Logger.log('  ERROR: ' + e.message);
    }
  });
}


// ── UTILITY: test GIS import without touching the real sheet ──────────────
// Run this from the Apps Script editor to preview what would be imported.
function testImport() {
  // Only test the first two configured (non-null) sources
  const testSources = COUNTY_SOURCES.filter(function(s) { return s.url !== null; }).slice(0, 2);
  testSources.forEach(function(source) {
    Logger.log('\n── Testing ' + source.county + ', ' + source.state + ' ──');
    try {
      const features = fetchCountyParcels(source);
      Logger.log('Features returned: ' + features.length);
      if (features.length > 0) {
        const row = parseGisFeature(features[0], source);
        Logger.log('First parsed row: ' + JSON.stringify(row, null, 2));
      }
    } catch(e) {
      Logger.log('Error: ' + e.message);
    }
  });
}


// ── DIAGNOSTIC: test every configured endpoint and report field names ──────
// Run this FIRST if importFromCountyGIS() adds nothing to the sheet.
// It tests each non-null county source and logs:
//   • HTTP status from the ArcGIS server
//   • How many features the WHERE clause returned
//   • All field names available in the first feature (so you can fix the WHERE)
//   • The raw attribute values of the first feature
// Read the output in: Apps Script editor → Executions (left sidebar) → click the run
function diagnoseCountySources() {
  const configured = COUNTY_SOURCES.filter(function(s) { return s.url !== null; });
  Logger.log('Diagnosing ' + configured.length + ' configured county sources...\n');

  configured.forEach(function(source) {
    Logger.log('══════════════════════════════════════');
    Logger.log('COUNTY: ' + source.county + ', ' + source.state);
    Logger.log('URL:    ' + source.url);
    Logger.log('WHERE:  ' + source.where);

    try {
      // 1 — test raw fetch with only 1 record and the real WHERE clause
      var qs1 = [
        'where=' + encodeURIComponent(source.where || '1=1'),
        'outFields=*',
        'returnGeometry=false',
        'resultRecordCount=1',
        'f=json',
      ].join('&');
      var r1 = UrlFetchApp.fetch(source.url + '?' + qs1, { muteHttpExceptions: true });
      var d1 = JSON.parse(r1.getContentText());

      if (d1.error) {
        Logger.log('❌ ArcGIS ERROR: ' + JSON.stringify(d1.error));
        Logger.log('   → WHERE clause likely references a field that does not exist.');

        // 2 — fallback: fetch 1 record with no filter to reveal available fields
        Logger.log('   → Fetching 1 record with WHERE=1=1 to show available fields...');
        var qs2 = 'where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=1&f=json';
        var r2 = UrlFetchApp.fetch(source.url + '?' + qs2, { muteHttpExceptions: true });
        var d2 = JSON.parse(r2.getContentText());

        if (d2.features && d2.features.length > 0) {
          var fields = Object.keys(d2.features[0].attributes);
          Logger.log('   AVAILABLE FIELDS (' + fields.length + '): ' + fields.join(', '));
          Logger.log('   SAMPLE VALUES: ' + JSON.stringify(d2.features[0].attributes));
        } else if (d2.error) {
          Logger.log('   ❌ Fallback also failed: ' + JSON.stringify(d2.error));
          Logger.log('   → The URL itself may be wrong or the service is offline.');
        }

      } else if (!d1.features || d1.features.length === 0) {
        Logger.log('⚠️  WHERE clause returned 0 results.');
        Logger.log('   → The endpoint is reachable but the filter matches nothing.');

        // Fetch 1 record with no filter to show available fields
        var qs3 = 'where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=1&f=json';
        var r3 = UrlFetchApp.fetch(source.url + '?' + qs3, { muteHttpExceptions: true });
        var d3 = JSON.parse(r3.getContentText());

        if (d3.features && d3.features.length > 0) {
          var flds = Object.keys(d3.features[0].attributes);
          Logger.log('   AVAILABLE FIELDS (' + flds.length + '): ' + flds.join(', '));
          Logger.log('   SAMPLE VALUES: ' + JSON.stringify(d3.features[0].attributes));
          Logger.log('   → Use the field names above to rewrite the WHERE clause.');
        }

      } else {
        Logger.log('✅ WHERE clause works — ' + (d1.features.length) + ' feature(s) matched.');
        var attrs = d1.features[0].attributes;
        Logger.log('   AVAILABLE FIELDS (' + Object.keys(attrs).length + '): ' + Object.keys(attrs).join(', '));
        Logger.log('   SAMPLE VALUES: ' + JSON.stringify(attrs));
      }

    } catch(e) {
      Logger.log('❌ EXCEPTION: ' + e.message);
    }

    Logger.log(''); // blank line between counties
    Utilities.sleep(300);
  });

  Logger.log('══════════════════════════════════════');
  Logger.log('Diagnosis complete. Read the output above to fix WHERE clauses.');
  Logger.log('Once WHERE clauses are fixed, run importFromCountyGIS() again.');
}
