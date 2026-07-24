// Mirrors form submissions (sell leads, buy orders) into a Google Sheet, using a
// service account rather than per-user OAuth - no login flow, just a shared sheet.
//
// The database (data.db) is always the source of truth; this is a best-effort
// copy for easy browsing/sorting/exporting. If it's not configured, or a call
// to Google fails, the site keeps working exactly as before - nothing here can
// block or fail a form submission.
//
// Setup (see README.md for the full walkthrough):
//   1. Create a Google Cloud service account, enable the Sheets API for it,
//      and generate a JSON key.
//   2. Share the target spreadsheet with the service account's email as Editor.
//   3. Set env vars: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID.
//   4. Create two tabs in the spreadsheet named exactly "Sell Leads" and "Buy Orders".

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
// Railway/most hosts store multi-line env vars with literal "\n" - convert back to real newlines.
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const sheetsEnabled = Boolean(SHEET_ID && SERVICE_ACCOUNT_EMAIL && PRIVATE_KEY);

if (!sheetsEnabled) {
  console.warn('Google Sheets mirror is not configured (missing GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY) - form submissions will only be stored in the database.');
}

let cachedSheetsClient = null;
function getClient() {
  if (!cachedSheetsClient) {
    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      null,
      PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    cachedSheetsClient = google.sheets({ version: 'v4', auth });
  }
  return cachedSheetsClient;
}

// tabName must already exist in the spreadsheet - append() doesn't create tabs.
// values is a flat array in column order; each call adds one row to the bottom.
async function appendRow(tabName, values) {
  if (!sheetsEnabled) return;
  try {
    const sheets = getClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] }
    });
  } catch (err) {
    // Swallow errors on purpose - a missing tab, a revoked share, a network blip
    // should never take down the sell/buy-order endpoint that called this.
    console.error(`Google Sheets append to "${tabName}" failed:`, err.message);
  }
}

module.exports = { appendRow, sheetsEnabled };
