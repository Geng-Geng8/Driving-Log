# Driving-Log
Track work mileage, school visit circuits, and trip reports in Google Sheets.

## Apps Script deployment

Open your spreadsheet's **Extensions > Apps Script** and replace `Code.gs` with
[`GoogleAppsScript_Code.gs`](GoogleAppsScript_Code.gs). Save, then update the existing
web app deployment to a **New version** using **Deploy > Manage deployments > Edit**.
Keep its existing access settings and URL. A GitHub update does not deploy Apps Script.

The sheet must have these headers: `Trip ID`, `Date`, `Entity`, `Notes`, `Route`, `Stops`, `Total KM`.
For an existing sheet, **insert a new Column C** named `Entity`; the existing Notes
column moves to D. Do not rename or overwrite existing Notes cells. Other columns
are mapped by header, including when reordered. Old rows need no bulk rewrite.
The new app checks backend support before sending separated Entity/Notes writes;
until the new Code.gs is deployed and the Entity header exists, new trips stay pending.
Read-only history continues to work with the previous backend and old schema.
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

Choose one tax entity, program, and activity. Entity is a separate top-level payload
field saved to Column C. Notes in Column D are `Program — Activity: Detail`.
The live preview shows `Entity: [Entity] | Notes: [Notes]`. Empty details use
the selected activity's description. Category selections persist across trips and
reloads; specific details clear after a completed or queued submission.

The edit modal keeps direct Notes editing and offers category controls for structured
notes, with a dedicated Entity toggle always visible at the top. Legacy prefixes
are removed in the edit field; saving writes Entity and clean Notes independently.
Unassigned legacy trips require an explicit entity selection before editing is saved.
Entity reports use the active date filter and group by the dedicated field first,
falling back to old note prefixes or unambiguous legacy names when it is blank.
Entity names inside a structured detail never override the selected entity.

The portfolio contains SHSM Certifications, Dance Workshops, Leadership Workshops,
Presentations & Keynotes, Cypher Program, Competitive Arts / BotB, B Thee Rise,
Filipino Projects, Breaking Canada Events, Community & Misc Events, Sales & Outreach,
and Admin & Governance. Switching to H4 defaults the program to Cypher Program.
Switching to Sole Prop preserves a selected contract service (the first four programs)
or defaults to SHSM Certifications. This applies to new trips and modal category edits;
reloads preserve explicit selections. Older `SHSM` and `Admin / Governance` notes
remain readable. Expand an entity's Program breakdown to see its program mileage
and trip counts for the selected period.

These labels support recordkeeping, not a determination of deductible expenses.
[CRA vehicle records](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/sole-proprietorships-partnerships/business-expenses/motor-vehicle-expenses/motor-vehicle-records.html)
and receipts are still required. T2125 line 9281 covers eligible motor-vehicle expenses
excluding CCA; unreimbursed H4 activity is tracked separately and is not automatically
a sole-proprietor deduction or a charitable gift.

Costco Wholesale Scarborough, Long & McQuade Scarborough, and Dollarama (Brimley &
Eglinton) are protected landmarks in the school-data generator and included in offline
fallback search. `node scripts/fetch_schools.js` regenerates the dataset while retaining them.
