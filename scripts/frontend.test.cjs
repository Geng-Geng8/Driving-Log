const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const reply = (data = { success:true, totalKm:21.4, tripId:'saved' }) => ({ ok:true, json:async () => data });
const trip = id => ({ id, tripId:id, date:'2026-11-05', timestamp:'2026-11-05T18:00:00Z',
  stops:['Origin','School','Origin'], routeSummary:'School → Home', notes:'Site Visit', totalKm:21.4 });

function browser(fetch) {
  const storage = new Map();
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value:'', checked:true, addEventListener() {},
      classList:{ add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  }
  const context = vm.createContext({ crypto, fetch, setTimeout, clearTimeout,
    console:{warn() {},log() {}}, navigator:{}, window:{addEventListener() {}},
    document:{ addEventListener() {}, getElementById:element },
    localStorage:{ getItem:k => storage.get(k) || null, setItem:(k,v) => storage.set(k,v), removeItem:k => storage.delete(k) }
  });
  vm.runInContext(source, context);
  context.alerts=[];
  context.history=[];
  context.resets=0;
  vm.runInContext(`
    isAuthorized = () => true;
    showAlert = (message,type) => alerts.push({message,type});
    renderRecentDrives = () => {};
    renderTaxDashboard = () => {};
    recalculateHeaderMetrics = () => {};
    syncWithGoogleSheet = () => {};
    saveToRecentHistory = trip => history.push(trip);
    resetTripForm = () => { resets++; currentStops = []; };
    currentStops = [{address:'School'}];
  `,context);
  context.pending = () => JSON.parse(storage.get('pending_trips_queue') || storage.get('driving_log_queue') || '[]');
  return context;
}

test('a trip added during queue sync survives removal of the confirmed trip',async () => {
  let complete;
  const c=browser(() => new Promise(resolve => {complete=resolve;}));
  c.enqueueOfflineTrip(trip('A'));
  const work=c.processPendingQueue();
  c.enqueueOfflineTrip(trip('B'));
  complete(reply());
  await work;
  assert.deepEqual(c.pending().map(t => t.id),['B']);
});

test('overlapping queue drains dispatch each item only once',async () => {
  let complete;let calls=0;
  const c=browser(() => {calls++;return new Promise(resolve => {complete=resolve;});});
  c.enqueueOfflineTrip(trip('A'));
  const work=c.processPendingQueue();
  await c.processPendingQueue();
  assert.equal(calls,1);
  complete(reply());await work;
  assert.equal(c.pending().length,0);
});

test('failed requests stay pending and can retry after the drain lock releases',async () => {
  let fail=true;
  const c=browser(async () => {if(fail)throw new Error('lost');return reply();});
  c.enqueueOfflineTrip(trip('A'));await c.processPendingQueue();
  assert.equal(c.pending().length,1);
  fail=false;await c.processPendingQueue();assert.equal(c.pending().length,0);
});

test('HTTP 200 with an application error does not remove a queued trip',async () => {
  const c=browser(async () => reply({ success:false, error:'Invalid distance' }));
  c.enqueueOfflineTrip(trip('A'));await c.processPendingQueue();
  assert.equal(c.pending().length,1);assert.match(c.alerts[0].message,/Invalid distance/);
});

test('new submissions are persisted before sending and removed only after confirmation',async () => {
  let c;let sent;
  c=browser(async (_,options) => {
    sent=JSON.parse(options.body);
    assert.equal(c.pending()[0].id,sent.id);
    return reply({status:'success',trip:{id:sent.id,totalKm:21.4}});
  });
  await c.saveTripToSheet(trip('unused'));
  assert.equal(c.pending().length,0);
  assert.equal(c.history[0].tripId,sent.id);
  assert.equal(c.history[0].synced,true);
});

test('a lost response retries with exactly the original ID',async () => {
  const ids=[];let lost=true;
  const c=browser(async (_,options) => {
    const sent=JSON.parse(options.body);ids.push(sent.id);
    if(lost){lost=false;throw new Error('Response lost after server saved');}
    return reply({success:true,tripId:sent.id,totalKm:21.4});
  });
  await c.saveTripToSheet(trip('unused'));
  assert.equal(c.pending().length,1);
  await c.processPendingQueue();
  assert.equal(ids[0],ids[1]);assert.equal(c.pending().length,0);
});

test('confirmed rejection preserves the form instead of automatically retrying',async () => {
  const c=browser(async () => reply({success:false,error:'Bad route'}));
  await c.saveTripToSheet(trip('unused'));
  assert.equal(c.pending().length,0);assert.equal(c.resets,0);assert.match(c.alerts[0].message,/Bad route/);
});

test('a server acknowledgement of zero km warns rather than claiming the supplied mileage was saved',async () => {
  const c=browser(async () => reply({status:'success',trip:{id:'saved',totalKm:0}}));
  await c.saveTripToSheet(trip('unused'));
  assert.equal(c.pending().length,0);assert.equal(c.history.length,0);
  assert.match(c.alerts[0].message,/mileage is missing or 0/);
});

test('legacy ID-less queue entries get distinct IDs before any requests start',async () => {
  let calls=0;const sentIds=[];let c;
  c=browser(async (_,options) => {
    calls++;sentIds.push(JSON.parse(options.body).id);
    assert.ok(c.pending().every(t => t.id));
    return calls===1 ? reply() : reply({success:false,error:'Retry later'});
  });
  const a=trip();const b=trip();b.routeSummary='Other School → Home';
  c.localStorage.setItem('driving_log_queue',JSON.stringify([a,b]));
  await c.processPendingQueue();
  assert.notEqual(sentIds[0],sentIds[1]);assert.equal(c.pending().length,1);assert.equal(c.pending()[0].id,sentIds[1]);
});

test('queue retries use the current owner key',async () => {
  let sent;
  const c=browser(async (_,options) => {sent=JSON.parse(options.body);return reply();});
  const p=trip('A');p.secret='old';c.enqueueOfflineTrip(p);
  c.localStorage.setItem('driving_log_secret','current');await c.processPendingQueue();
  assert.equal(sent.secret,'current');
});

test('unauthorized devices do not dispatch queued writes',async () => {
  let calls=0;const c=browser(async () => {calls++;return reply();});
  vm.runInContext('isAuthorized = () => false',c);
  c.enqueueOfflineTrip(trip('A'));await c.processPendingQueue();assert.equal(calls,0);assert.equal(c.pending().length,1);
});

test('the copy button supplies exactly the checked backend',() => {
  const c=browser();c.populateAppsScriptCodeBlock();
  const copied=c.document.getElementById('appsScriptCodeBlock').value;
  assert.equal(copied,fs.readFileSync(path.join(root,'GoogleAppsScript_Code.gs'),'utf8').replace(/\r\n/g,'\n'));
});
