
const {google} = require('googleapis');
const fs = require('fs');
const creds = JSON.parse(fs.readFileSync('service-account.json','utf8'));
const auth = new google.auth.GoogleAuth({credentials:creds, scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']});
const SHEET_ID = '1IQzdhv7FcD6XQnJJ61uWUvO_tMoaRquH5GOs7bXwTyQ';
async function run(){
  const sheets = google.sheets({version:'v4',auth});
  // Get headers
  const r = await sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID, range:'Properties!A1:Z2'});
  const rows = r.data.values || [];
  console.log('HEADERS:', JSON.stringify(rows[0]));
  console.log('ROW1:', JSON.stringify(rows[1]));
  // Count rows
  const r2 = await sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID, range:'Properties!A1:A200'});
  console.log('TOTAL_ROWS:', (r2.data.values||[]).length - 1);
  // Check Vacancy tab
  const r3 = await sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID, range:'Vacancy!A1:D5'});
  console.log('VACANCY:', JSON.stringify(r3.data.values));
}
run().catch(e=>console.error(e.message));
