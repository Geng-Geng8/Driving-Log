const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { server, trip, headers } = require('./test-server.cjs');

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

const entityHeaders = ['Trip ID','Date','Entity','Notes','Route','Stops','Total KM'];
test('create, retry and GET keep Column C Entity and Column D Notes independent',() => {
  for (const entity of ['Glen Reyes (Sole Prop)','H4 Community (Unreimbursed)']) {
    const s=server([],entityHeaders);
    const p={...trip(),entity,notes:'SHSM Certifications — Workshop Delivery: 3-hr session'};
    const saved=s.post(p);
    assert.equal(saved.entity,entity);assert.equal(saved.trip.notes,p.notes);
    assert.equal(s.rows[1][2],entity);assert.equal(s.rows[1][3],p.notes);
    assert.equal(s.post(p).duplicate,true);assert.equal(s.rows.length,2);
    const fetched=s.get();assert.equal(fetched.supportsEntity,true);
    assert.equal(fetched.trips[0].entity,entity);assert.equal(fetched.trips[0].notes,p.notes);
  }
});
test('edit writes Entity and Notes separately and preserves formula columns',() => {
  const s=server([['A','2026-11-05','Glen Reyes (Sole Prop)','Old','School',3,20,42]],[...entityHeaders,'Extra']);
  s.formulas=['','','','','','','','=6*7'];
  const result=s.post({action:'update',id:'A',entity:'H4 Community (Unreimbursed)',notes:'Cypher Program — Workshop Delivery: Rehearsal'});
  assert.equal(result.success,true);assert.equal(s.rows[1][2],'H4 Community (Unreimbursed)');
  assert.equal(s.rows[1][3],'Cypher Program — Workshop Delivery: Rehearsal');assert.equal(s.rows[1][7],'=6*7');
  assert.equal(result.trip.entity,s.rows[1][2]);
});
test('legacy prefixes separate on write only when the Entity column exists',() => {
  const p={...trip(),notes:'H4 Community (Unreimbursed) — Cypher Program — Workshop Delivery: Rehearsal'};
  const modern=server([],entityHeaders);modern.post(p);
  assert.equal(modern.rows[1][2],'H4 Community (Unreimbursed)');assert.equal(modern.rows[1][3],'Cypher Program — Workshop Delivery: Rehearsal');
  const legacy=server();legacy.post(p);assert.equal(legacy.rows[1][2],p.notes);assert.equal(legacy.get().supportsEntity,false);
});
test('missing Entity column and invalid entities reject writes without changing rows',() => {
  const legacy=server();const p={...trip(),entity:'Glen Reyes (Sole Prop)'};
  assert.match(legacy.post(p).error,/Entity column/);assert.equal(legacy.rows.length,1);
  for (const entity of ['Unknown',null,false,{},12]) {
    const s=server([],entityHeaders);assert.equal(s.post({...p,entity}).success,false);assert.equal(s.rows.length,1);
  }
  const s=server([['A','2026-11-05','Glen Reyes (Sole Prop)','Original','School',3,20]],entityHeaders);
  assert.equal(s.post({action:'update',id:'A',entity:'Invalid',notes:'Changed'}).success,false);
  assert.equal(s.rows[1][3],'Original');
});
test('Entity header mapping survives reordered columns',() => {
  const s=server([],['Notes','Total KM','Entity','Date','Stops','Route','Trip ID']);
  const p={...trip(),entity:'Glen Reyes (Sole Prop)'};assert.equal(s.post(p).success,true);
  assert.equal(s.rows[1][0],p.notes);assert.equal(s.rows[1][2],p.entity);assert.equal(s.get().trips[0].entity,p.entity);
});
