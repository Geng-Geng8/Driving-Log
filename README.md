# Driving-Log
Track work mileage, school visit circuits, and trip reports in Google Sheets.

## Apps Script deployment

Open your spreadsheet's **Extensions > Apps Script** and replace `Code.gs` with
[`GoogleAppsScript_Code.gs`](GoogleAppsScript_Code.gs). Save, then update the existing
web app deployment to a **New version** using **Deploy > Manage deployments > Edit**.
Keep its existing access settings and URL. A GitHub update does not deploy Apps Script.

The sheet must have these headers: `Trip ID`, `Date`, `Notes`, `Route`, `Stops`, `Total KM`.
The backend accepts calculated/manual mileage, validates edits, and acknowledges retries
of the same submission without adding another row. Existing duplicates are not deleted.

The app's **Copy Code.gs** button embeds this same backend. After changing the backend, run:

```sh
node scripts/update-guide.cjs
node --test scripts/*.test.cjs
```

Tests use simulated browser storage and Google services; they do not write to your sheet.
After deploying Apps Script, verify one trip save, a Pending retry, and one edit in the app.
