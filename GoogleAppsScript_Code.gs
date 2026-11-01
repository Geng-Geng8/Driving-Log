/**
 * DRIVING LOG - GOOGLE APPS SCRIPT (Code.gs)
 * ==============================================================================
 * This script powers the Driving Log web app and connects directly to your "Trips" sheet.
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
 * OPTIONAL ONE-TIME CLEANUP:
 * To clean up past rows in Column D so they don't start with "74 Dalmatian Cres",
 * select "cleanExistingRoutesInSheet" from the toolbar dropdown and click "Run".
 * ==============================================================================
 */

const SHEET_NAME = "Trips";
const DEFAULT_HOME_LABEL = "74 Dalmatian";

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
    let routeIdx = headers.findIndex(h => h.includes("route") || h.includes("stop") && !h.includes("count"));
    let stopsCountIdx = headers.findIndex(h => h === "stops" || h.includes("count"));
    let kmIdx = headers.findIndex(h => h.includes("km") || h.includes("distance") || h.includes("mileage"));

    // Fallbacks matching your exact sheet structure (A: Trip ID, B: Date, C: Notes, D: Route, E: Stops, F: Total KM)
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

    // Use human-readable route summary starting with first destination
    const routeSummary = payload.routeSummary || buildRouteSummaryFromStops(stops);
    const stopsCount = stops.length;

    // Calculate total driving distance using Google Maps Directions API
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
 * Builds clean route summary (e.g. "Madonna CSS → St. Agatha → Home")
 * omitting redundant starting home address so it starts with the first trip!
 */
function buildRouteSummaryFromStops(stops) {
  if (!stops || stops.length === 0) return "Trip";

  const cleanStops = stops.map(s => {
    const firstPart = String(s).split(",")[0].trim();
    return firstPart.replace(/^Home\s*[-—:]*\s*/i, "").trim();
  });

  const isFirstHome = cleanStops[0].toLowerCase().includes("dalmatian") || cleanStops[0].toLowerCase() === "home";
  const isLastHome = cleanStops[cleanStops.length - 1].toLowerCase().includes("dalmatian") || cleanStops[cleanStops.length - 1].toLowerCase() === "home";

  const destinations = [];

  // If started from Home, omit home at the start so route begins with the first destination!
  const startIndex = isFirstHome ? 1 : 0;

  for (let i = startIndex; i < cleanStops.length - (isLastHome ? 1 : 0); i++) {
    destinations.push(cleanStops[i]);
  }

  if (isLastHome) {
    destinations.push("Home");
  }

  return destinations.length > 0 ? destinations.join(" → ") : "Home Circuit";
}

/**
 * Helper to clean existing route strings in Column D:
 * Strips "74 Dalmatian Cres" from start, replaces trailing home with "Home"
 */
function cleanRouteString(rawRoute) {
  if (!rawRoute) return "";
  let route = String(rawRoute).trim();

  // Strip leading Home / 74 Dalmatian
  route = route.replace(/^Home\s*[-—:]*\s*/i, "");
  route = route.replace(/^74\s*Dalmatian\s*(Cres|Crescent)?[^→\->,]*/i, "").trim();
  route = route.replace(/^(\s*[-—→>]+\s*|\s*to\s*)/i, "").trim();

  // Replace trailing 74 Dalmatian with "Home"
  route = route.replace(/74\s*Dalmatian\s*(Cres|Crescent)?[^→\->,]*/i, "Home").trim();
  route = route.replace(/Home\s*[-—:]*\s*74\s*Dalmatian[^→\->,]*/i, "Home").trim();

  // Clean double arrows
  route = route.replace(/\s*[-—→>]+\s*[-—→>]+\s*/g, " → ");
  route = route.replace(/^[-—→>\s]+|[-—→>\s]+$/g, "").trim();

  return route || "Home Circuit";
}

/**
 * ONE-CLICK UTILITY TO CLEAN EXISTING GOOGLE SHEET ROWS:
 * Run this function in Apps Script to instantly update Column D in all existing rows
 * so they don't start with "74 Dalmatian Cres" and instead show where you went!
 */
function cleanExistingRoutesInSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return;

  const headers = data[0].map(h => String(h || "").trim().toLowerCase());
  let routeIdx = headers.findIndex(h => h.includes("route"));
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

  Logger.log("Cleaned " + updatedCount + " existing routes in Column D.");
}

/**
 * Helper to build JSON output with CORS headers
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
