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

## Trip categories and audit notes

Choose one tax entity, program, and activity. The live preview is the exact Notes
value saved to Column C: `Entity — Program — Activity: Detail`. Empty details use
the selected activity's description. Category selections persist across trips and
reloads; specific details clear after a completed or queued submission.

The edit modal keeps direct Notes editing and offers category controls for structured
notes. Legacy notes stay unchanged until edited. Entity reports use the active date
filter and show unclassified legacy notes separately; structured entity tags take
precedence over names mentioned in the detail to avoid counting a trip twice.

These labels support recordkeeping, not a determination of deductible expenses.
[CRA vehicle records](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/sole-proprietorships-partnerships/business-expenses/motor-vehicle-expenses/motor-vehicle-records.html)
and receipts are still required. T2125 line 9281 covers eligible motor-vehicle expenses
excluding CCA; unreimbursed H4 activity is tracked separately and is not automatically
a sole-proprietor deduction or a charitable gift.

Costco Wholesale Scarborough, Long & McQuade Scarborough, and Dollarama (Brimley &
Eglinton) are protected landmarks in the school-data generator and included in offline
fallback search. `node scripts/fetch_schools.js` regenerates the dataset while retaining them.
