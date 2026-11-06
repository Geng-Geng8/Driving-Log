const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
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

test('current client mileage and retry: one row, same client ID, no Maps calls',() => {
  const s=server(); const first=s.post(trip()); const retry=s.post(trip());
  assert.equal(first.success,true); assert.equal(first.tripId,trip().id); assert.equal(first.totalKm,21.4);
  assert.equal(retry.duplicate,true); assert.equal(s.rows.length,2); assert.equal(s.maps,0); assert.equal(s.locked,false);
});
test('separate deliberate trips with the same route and timestamp retain distinct IDs',() => {
  const s=server(); s.post(trip('trip-a')); s.post(trip('trip-b')); assert.equal(s.rows.length,3);
});
test('older address-only requests calculate all legs and deduplicate by timestamp',() => {
  const s=server(); const p=trip(); delete p.totalKm;delete p.id;delete p.tripId;
  assert.equal(s.post(p).totalKm,24);assert.equal(s.post(p).duplicate,true);assert.equal(s.rows.length,2);assert.equal(s.maps,2);
});
test('retry recognizes a row created by the previous hashed-ID backend',() => {
  const p=trip();const key=JSON.stringify([p.timestamp,p.stops,p.date,p.notes,p.routeSummary]);
  const oldId='TRIP-20261105-'+crypto.createHash('sha256').update(key).digest('hex');
  const s=server([[oldId,p.date,p.notes,p.routeSummary,3,21.4]]);
  const result=s.post(p);assert.equal(result.duplicate,true);assert.equal(result.tripId,oldId);assert.equal(s.rows.length,2);
});
test('zero, blank, negative, nonfinite and malformed supplied distance never append',() => {
  for(const value of [0,'',-1,'NaN','Infinity',null,false,'12km',1e308]){
    const s=server();const p=trip();p.totalKm=value;assert.equal(s.post(p).success,false,String(value));assert.equal(s.rows.length,1);
  }
});
test('failure on the second route leg does not append partial mileage',() => {
  const s=server();const p=trip();delete p.totalKm;
  s.directions=[{status:'OK',routes:[{legs:[{distance:{value:10000}}]}]},{status:'ZERO_RESULTS',routes:[]}];
  assert.equal(s.post(p).success,false);assert.equal(s.rows.length,1);assert.equal(s.locked,false);
});
test('GET returns both API field formats and numeric stop counts',() => {
  const s=server();s.post(trip());const result=s.get();assert.equal(result.totalKm,21.4);
  assert.equal(result.trips[0].id,result.trips[0].tripId);assert.equal(result.trips[0].stops,3);assert.equal(result.trips[0].km,21.4);
});
test('update validates all fields before writing and preserves unrelated formulas',() => {
  const s=server([['trip-a','2026-11-05','Note','School → Home',3,21.4,42]],[...headers,'Extra']);
  s.formulas=['','','','','','','=6*7'];
  assert.equal(s.post({action:'update',id:'trip-a',notes:'Changed',totalKm:0}).success,false);
  assert.equal(s.rows[1][2],'Note');
  const result=s.post({action:'update',id:'trip-a',notes:'Changed',totalKm:25.3,stops:4});
  assert.equal(result.success,true);assert.equal(s.rows[1][2],'Changed');assert.equal(s.rows[1][6],'=6*7');
});
test('ROW fallback cannot target an unrelated row that has a real ID',() => {
  const s=server([['trip-a','2026-11-05','Note','School',2,20]]);
  assert.equal(s.post({action:'update',id:'ROW-1',totalKm:10}).success,false);
});
test('schema mapping handles rearranged columns and rejects missing headers',() => {
  const s=server([],['Notes','Total KM','Date','Stops','Route','Trip ID']);
  assert.equal(s.post(trip()).success,true);assert.equal(s.rows[1][1],21.4);assert.equal(s.rows[1][5],trip().id);
  assert.equal(server([],['Wrong']).post(trip()).success,false);
});
test('existing secret is enforced for creates and updates',() => {
  const s=server();s.secret='test-key';assert.equal(s.post(trip()).success,false);
  const p=trip();p.secret='test-key';assert.equal(s.post(p).success,true);
  assert.equal(s.post({action:'update',id:p.id,notes:'Changed'}).success,false);
});
test('busy requests return a retryable error without writing',() => {
  const s=server();s.busy=true;assert.equal(s.post(trip()).retryable,true);assert.equal(s.rows.length,1);
});
test('invalid dates and missing submission identity are rejected',() => {
  const s=server();const p=trip();p.date='2026-02-30';assert.equal(s.post(p).success,false);
  const q=trip();delete q.id;delete q.tripId;delete q.timestamp;assert.equal(s.post(q).success,false);
});
