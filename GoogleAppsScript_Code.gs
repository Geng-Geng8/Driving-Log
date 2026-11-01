/**
 * DRIVING LOG - GOOGLE APPS SCRIPT (Code.gs)
 * ==============================================================================
 * This script powers the Driving Log web app. It handles:
 * 1. GET requests: Reads recorded trips from the "Trips" sheet and returns them as
 *    JSON so your phone, laptop, and tablet always mirror the exact sheet data.
 * 2. POST requests: Calculates road mileage via Google Maps Directions API, generates
 *    a unique Trip ID, and appends the trip to the "Trips" sheet.
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
 * ==============================================================================
 */

const SHEET_NAME = "Trips";

/**
 * Handle GET requests: Return all logged trips from the Google Sheet
 */
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    
    // Auto-create "Trips" sheet with headers if not present
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(["Timestamp", "Date", "Total KM", "Route / Stops", "Notes", "Trip ID"]);
      sheet.setFrozenRows(1);
    }

    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return createJsonResponse({
        status: "success",
        totalKm: 0,
        count: 0,
        trips: []
      });
    }

    // Header mapping (case-insensitive)
    const headers = data[0].map(h => String(h || "").trim().toLowerCase());
    
    let timeIdx = headers.findIndex(h => h.includes("timestamp") || h.includes("time"));
    let dateIdx = headers.findIndex(h => h === "date" || h.includes("trip date"));
    let kmIdx = headers.findIndex(h => h.includes("km") || h.includes("distance") || h.includes("mileage"));
    let stopsIdx = headers.findIndex(h => h.includes("stop") || h.includes("route") || h.includes("waypoint"));
    let notesIdx = headers.findIndex(h => h.includes("note") || h.includes("purpose"));
    let idIdx = headers.findIndex(h => h.includes("id"));

    // Fallbacks if headers are generic
    if (timeIdx === -1) timeIdx = 0;
    if (dateIdx === -1) dateIdx = 1;
    if (kmIdx === -1) kmIdx = 2;
    if (stopsIdx === -1) stopsIdx = 3;
    if (notesIdx === -1) notesIdx = 4;
    if (idIdx === -1) idIdx = 5;

    const trips = [];
    let totalKm = 0;

    // Iterate backwards so most recent drives appear first
    for (let i = data.length - 1; i >= 1; i--) {
      const row = data[i];
      if (!row || row.length === 0) continue;
      
      // Skip empty rows
      const hasContent = row.some(cell => cell !== "" && cell !== null && cell !== undefined);
      if (!hasContent) continue;

      const kmVal = Number(row[kmIdx]) || 0;
      totalKm += kmVal;

      let rawDate = row[dateIdx] || row[timeIdx];
      let formattedDate = "";
      if (rawDate instanceof Date) {
        const y = rawDate.getFullYear();
        const m = String(rawDate.getMonth() + 1).padStart(2, "0");
        const d = String(rawDate.getDate()).padStart(2, "0");
        formattedDate = `${y}-${m}-${d}`;
      } else if (rawDate) {
        formattedDate = String(rawDate).slice(0, 10);
      }

      trips.push({
        tripId: String(row[idIdx] || `ROW-${i}`),
        date: formattedDate,
        km: Number(kmVal.toFixed(1)),
        stops: String(row[stopsIdx] || ""),
        notes: String(row[notesIdx] || ""),
        timestamp: row[timeIdx] ? String(row[timeIdx]) : formattedDate,
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
 * Handle POST requests: Calculate mileage and log a new trip
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
        // Fallback warning if specific leg couldn't be resolved
        console.warn("Could not route between: " + origin + " and " + destination);
      }
    }

    const totalKm = Number((totalMeters / 1000).toFixed(1));
    const tripId = "TRIP-" + Utilities.formatDate(new Date(), "America/Toronto", "yyyyMMdd-HHmmss");

    // Clean stops summary
    const cleanStopsSummary = stops.map(s => {
      const parts = s.split(",");
      return parts[0].trim();
    }).join(" → ");

    // Append to sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(["Timestamp", "Date", "Total KM", "Route / Stops", "Notes", "Trip ID"]);
      sheet.setFrozenRows(1);
    }

    sheet.appendRow([timestamp, chosenDate, totalKm, cleanStopsSummary, notes, tripId]);

    return createJsonResponse({
      success: true,
      tripId: tripId,
      totalKm: totalKm,
      date: chosenDate,
      stops: cleanStopsSummary
    });

  } catch (err) {
    return createJsonResponse({
      success: false,
      error: err.toString()
    });
  }
}

/**
 * Helper to build JSON output with CORS headers
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
