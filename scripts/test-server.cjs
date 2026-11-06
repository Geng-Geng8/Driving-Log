const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const code = fs.readFileSync(require('node:path').join(__dirname, '..', 'GoogleAppsScript_Code.gs'), 'utf8');
const headers = ['Trip ID', 'Date', 'Notes', 'Route', 'Stops', 'Total KM'];
const trip = (id = 'TRIP-20261105-ABCD') => ({ id, tripId:id, date:'2026-11-05',
  stops:['Origin', 'St. Barnabas', 'Origin'], notes:'Site Visit', routeSummary:'St. Barnabas → Home',
  timestamp:'2026-11-05T18:00:00Z', totalKm:21.4 });
function server(initial = [], headerRow = headers) {
  const state = { rows:[headerRow, ...initial], maps:0, locked:false, secret:null, formulas:[] };
  const sheet = {
    getDataRange:() => ({getValues:() => state.rows.map(row => [...row])}),
    appendRow:row => { assert.equal(state.locked,true); state.rows.push(row); },
    getRange:(row, _, __, width) => ({ getFormulas:() => [state.formulas.length ? state.formulas : new Array(width).fill('')],
      setValues:values => { assert.equal(state.locked,true); state.rows[row-1] = values[0]; } })
  };
  const context = vm.createContext({console,
    LockService:{getScriptLock:() => ({tryLock:() => {if(state.busy)return false; assert.equal(state.locked,false);state.locked=true;return true;}, releaseLock:() => {state.locked=false;}})},
    SpreadsheetApp:{getActiveSpreadsheet:() => ({getSheetByName:() => sheet,getUrl:() => 'test-sheet'}),flush:() => assert.equal(state.locked,true)},
    PropertiesService:{getScriptProperties:() => ({getProperty:() => state.secret})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s) => [...crypto.createHash('sha256').update(s).digest()],formatDate:() => '2026-11-05'},
    Maps:{DirectionFinder:{Mode:{DRIVING:'driving'}},newDirectionFinder:() => {const f={setOrigin:() => f,setDestination:() => f,setMode:() => f,
      getDirections:() => {state.maps++;return (state.directions || []).shift() || {status:'OK',routes:[{legs:[{distance:{value:12000}}]}]};}};return f;}},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:s => ({setMimeType:() => JSON.parse(s)})}
  });
  vm.runInContext(code,context);
  state.post = p => context.doPost({postData:{contents:JSON.stringify(p)}});
  state.get = () => context.doGet();
  return state;
}


module.exports = { server, trip, headers };
