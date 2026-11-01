/**
 * DRIVING LOG - GOOGLE APPS SCRIPT (Code.gs)
 * ==============================================================================
 * This script connects directly to your Google Sheet "Trips".
 *
 * GOOGLE SHEET COLUMNS (Row 1 headers):
 * A: Trip ID   | B: Date   | C: Notes   | D: Route   | E: Stops   | F: Total KM
 *
 * HOW TO DEPLOY / UPDATE IN GOOGLE SHEETS:
 * 1. In your Google Sheet, click "Extensions" > "Apps Script".
 * 2. Select all text in "Code.gs" and replace it with this entire file.
 * 3. Click "Save" (floppy disk icon).
 * 4. Click "Deploy" > "Manage deployments".
 * 5. Click the pencil icon (Edit) on your Active deployment.
 * 6. Under "Version", select "New version".
 * 7. Ensure "Execute as": "Me" and "Who has access": "Anyone".
 * 8. Click "Deploy".
 *
 * ONE-CLICK RETROACTIVE ROUTE CLEANUP:
 * To clean up Column D in all existing rows (e.g. converting addresses like
 * "80 Sheppard Ave E" into "CEC Board Office -> Home"):
 * 1. Select "cleanExistingRoutesInSheet" from the Apps Script toolbar dropdown.
 * 2. Click "Run" (▶).
 * ==============================================================================
 */

const SHEET_NAME = "Trips";

// Mapping of known GTA school / building addresses to clean friendly names
const KNOWN_LOCATIONS = [
  { name: "CEC Board Office", patterns: ["80 Sheppard", "CEC Board", "Sheppard Ave E"] },
  { name: "Chaminade College", patterns: ["490 Queen", "Chaminade"] },
  { name: "St. John Paul II", patterns: ["685 Military", "John Paul"] },
  { name: "St. Columba", patterns: ["1054 Military", "Columba"] },
  { name: "St. Mother Teresa", patterns: ["440 Sewell", "Mother Teresa"] },
  { name: "Madonna CSS", patterns: ["20 Cresswell", "Madonna"] },
  { name: "St. Basil-the-Great", patterns: ["20 Weston", "Basil"] },
  { name: "Maria Goretti", patterns: ["21 Tabor", "Goretti"] },
  { name: "St. Agatha", patterns: ["Agatha"] },
  { name: "St. Nicholas", patterns: ["Nicholas"] },
  { name: "Downtown Office", patterns: ["100 Queen", "City Hall"] }
];

/**
 * Handle GET requests: Return all logged trips from the Google Sheet
 */
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];

    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return createJsonResponse({
        status: "success",
        totalKm: 0,
        count: 0,
        trips: []
      });
    }

    // Inspect headers (row 0)
    const headers = data[0].map(h => String(h || "").trim().toLowerCase());
    
    let idIdx = headers.findIndex(h => h.includes("trip id") || h === "id");
    let dateIdx = headers.findIndex(h => h === "date" || h.includes("trip date"));
    let notesIdx = headers.findIndex(h => h.includes("note") || h.includes("purpose"));
    let routeIdx = headers.findIndex(h => h.includes("route") || (h.includes("stop") && !h.includes("count")));
    let stopsCountIdx = headers.findIndex(h => h === "stops" || h.includes("count"));
    let kmIdx = headers.findIndex(h => h.includes("km") || h.includes("distance") || h.includes("mileage"));

    // Fallbacks matching your exact sheet: A: Trip ID, B: Date, C: Notes, D: Route, E: Stops, F: Total KM
    if (idIdx === -1) idIdx = 0;
    if (dateIdx === -1) dateIdx = 1;
    if (notesIdx === -1) notesIdx = 2;
    if (routeIdx === -1) routeIdx = 3;
    if (stopsCountIdx === -1) stopsCountIdx = 4;
    if (kmIdx === -1) kmIdx = 5;

    const trips = [];
    let totalKm = 0;

    // Read rows from bottom to top (most recent first)
    for (let i = data.length - 1; i >= 1; i--) {
      const row = data[i];
      if (!row || row.length === 0) continue;

      const hasContent = row.some(cell => cell !== "" && cell !== null && cell !== undefined);
      if (!hasContent) continue;

      const kmVal = Number(row[kmIdx]) || 0;
      totalKm += kmVal;

      let rawDate = row[dateIdx];
      let formattedDate = "";
      if (rawDate instanceof Date) {
        formattedDate = Utilities.formatDate(rawDate, "America/Toronto", "yyyy-MM-dd");
      } else if (rawDate) {
        formattedDate = String(rawDate).slice(0, 10);
      }

      const rawRoute = String(row[routeIdx] || "");
      const cleanedRoute = cleanRouteString(rawRoute);

      trips.push({
        tripId: String(row[idIdx] || `ROW-${i}`),
        date: formattedDate,
        notes: String(row[notesIdx] || ""),
        route: cleanedRoute,
        stops: cleanedRoute,
        stopsCount: Number(row[stopsCountIdx]) || 0,
        km: Number(kmVal.toFixed(1)),
        synced: true
      });
    }

    return createJsonResponse({
      status: "success",
      totalKm: Number(totalKm.toFixed(1)),
      count: trips.length,
      trips: trips
    });

  } catch (err) {
    return createJsonResponse({
      status: "error",
      message: err.toString()
    });
  }
}

/**
 * Handle POST requests: Calculate mileage and log a new trip to the sheet
 */
function doPost(e) {
  try {
    const rawContent = e.postData ? e.postData.contents : null;
    if (!rawContent) {
      throw new Error("Missing POST request body.");
    }

    const payload = JSON.parse(rawContent);
    const stops = payload.stops;

    if (!stops || !Array.isArray(stops) || stops.length < 2) {
      throw new Error("A valid drive requires at least 2 distinct stops (Start and Destination).");
    }

    const notes = payload.notes || "Trip";
    const chosenDate = payload.date || new Date().toISOString().slice(0, 10);
    const timestamp = payload.timestamp || new Date().toISOString();

    // Use human-readable route summary with clean names starting with first destination
    const routeSummary = cleanRouteString(payload.routeSummary || buildRouteSummaryFromStops(stops));
    const stopsCount = stops.length;

    // Calculate driving distance using Google Maps Directions API
    let totalMeters = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const origin = stops[i];
      const destination = stops[i + 1];

      const directions = Maps.newDirectionFinder()
        .setOrigin(origin)
        .setDestination(destination)
        .setMode(Maps.DirectionFinder.Mode.DRIVING)
        .getDirections();

      if (directions.status === "OK" && directions.routes.length > 0) {
        const route = directions.routes[0];
        for (let j = 0; j < route.legs.length; j++) {
          totalMeters += route.legs[j].distance.value;
        }
      } else {
        console.warn("Could not route between: " + origin + " and " + destination);
      }
    }

    const totalKm = Number((totalMeters / 1000).toFixed(1));
    const randomSuffix = Math.random().toString(36).substr(2, 4).toUpperCase();
    const tripDatePart = chosenDate.replace(/-/g, "");
    const tripId = `TRIP-${tripDatePart}-${randomSuffix}`;

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];

    // Append matching your exact sheet columns:
    // A: Trip ID | B: Date | C: Notes | D: Route | E: Stops | F: Total KM
    sheet.appendRow([tripId, chosenDate, notes, routeSummary, stopsCount, totalKm]);

    return createJsonResponse({
      success: true,
      tripId: tripId,
      totalKm: totalKm,
      date: chosenDate,
      route: routeSummary,
      stops: routeSummary
    });

  } catch (err) {
    return createJsonResponse({
      success: false,
      error: err.toString()
    });
  }
}

/**
 * Checks if a segment represents the home address
 */
function isHomeSegment(segment) {
  if (!segment) return false;
  const s = String(segment).toLowerCase().trim();
  return (
    s.includes("dalmatian") ||
    s.includes("m1c 4w7") ||
    s.includes("m1c4w7") ||
    s === "home" ||
    s.startsWith("home ") ||
    s.startsWith("home,") ||
    s.startsWith("home -") ||
    s.startsWith("home —") ||
    (s.includes("scarborough") && !s.includes("military") && !s.includes("sewells") && !s.includes("tabor"))
  );
}

/**
 * Resolves an address or text to its friendly destination name (e.g. "CEC Board Office")
 */
function resolveFriendlyName(segment) {
  if (!segment) return "";
  const trimmed = String(segment).trim();

  // 1. Check known locations map
  for (let i = 0; i < KNOWN_LOCATIONS.length; i++) {
    const loc = KNOWN_LOCATIONS[i];
    for (let j = 0; j < loc.patterns.length; j++) {
      if (trimmed.toLowerCase().includes(loc.patterns[j].toLowerCase())) {
        return loc.name;
      }
    }
  }

  // 2. Clean address: remove postal codes, province, country
  let clean = trimmed.split(",")[0].trim();
  clean = clean.replace(/,.*$/, "");
  clean = clean.replace(/\b(ON|Ontario|Canada|M\d[A-Z]\s*\d[A-Z]\d)\b/gi, "").trim();

  return clean || trimmed;
}

/**
 * Robust route parser:
 * 1. Splits route into waypoints.
 * 2. Omits the redundant home address from the start so the route starts with the first trip of the day!
 * 3. Resolves raw street addresses (like "80 Sheppard Ave E...") into friendly school names ("CEC Board Office").
 * 4. Ends cleanly with "Home" if it was a roundtrip.
 */
function cleanRouteString(rawRoute) {
  if (!rawRoute) return "Trip";

  const rawSegments = String(rawRoute)
    .split(/\s*[-—→>]+\s*|\s+to\s+/i)
    .map(s => s.trim())
    .filter(Boolean);

  if (rawSegments.length === 0) return "Trip";

  const destinationSegments = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const isFirst = (i === 0);
    const isLast = (i === rawSegments.length - 1);

    if (isHomeSegment(seg)) {
      if (isLast && destinationSegments.length > 0) {
        destinationSegments.push("Home");
      }
      // If it's a leading home address or intermediate home, omit it!
      continue;
    }

    destinationSegments.push(resolveFriendlyName(seg));
  }

  if (destinationSegments.length === 0) {
    return "Home Circuit";
  }

  return destinationSegments.join(" → ");
}

/**
 * Builds clean route summary from stop addresses
 */
function buildRouteSummaryFromStops(stops) {
  if (!stops || stops.length === 0) return "Trip";
  return cleanRouteString(stops.join(" → "));
}

/**
 * ONE-CLICK UTILITY TO CLEAN EXISTING GOOGLE SHEET ROWS:
 * Select "cleanExistingRoutesInSheet" in Apps Script and click "Run".
 * It will update Column D in all past rows in your Google Sheet to the clean format!
 */
function cleanExistingRoutesInSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return;

  const headers = data[0].map(h => String(h || "").trim().toLowerCase());
  let routeIdx = headers.findIndex(h => h.includes("route") || (h.includes("stop") && !h.includes("count")));
  if (routeIdx === -1) routeIdx = 3; // Column D

  let updatedCount = 0;
  for (let i = 1; i < data.length; i++) {
    const rawRoute = String(data[i][routeIdx] || "");
    if (!rawRoute) continue;

    const cleaned = cleanRouteString(rawRoute);
    if (cleaned !== rawRoute) {
      sheet.getRange(i + 1, routeIdx + 1).setValue(cleaned);
      updatedCount++;
    }
  }

  Logger.log("Successfully cleaned " + updatedCount + " existing routes in Column D.");
}

/**
 * Helper to build JSON output with CORS headers
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
