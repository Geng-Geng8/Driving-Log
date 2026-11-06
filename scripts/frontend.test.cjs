const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const html = process.env.DRIVING_LOG_TEST_REF
  ? require('node:child_process').execFileSync('git', ['show', process.env.DRIVING_LOG_TEST_REF + ':index.html'], {cwd:root,encoding:'utf8'})
  : fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const reply = (data = { success:true, totalKm:21.4, tripId:'saved' }) => ({ ok:true, json:async () => data });
const trip = id => ({ id, tripId:id, date:'2026-11-05', timestamp:'2026-11-05T18:00:00Z',
  stops:['Origin','School','Origin'], routeSummary:'School → Home', notes:'Site Visit', totalKm:21.4 });

function browser(fetch, { realSync = false } = {}) {
  const storage = new Map();
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { value:'', checked:true, addEventListener() {},
        classList:{ add:(...names) => names.forEach(n => classes.add(n)), remove:(...names) => names.forEach(n => classes.delete(n)), toggle() {}, contains:n => classes.has(n) } });
    }
    return elements.get(id);
  }
  const context = vm.createContext({ crypto, fetch, setTimeout, clearTimeout, URL, AbortController,
    console:{warn() {},log() {}}, navigator:{onLine:true}, window:{addEventListener() {},scrollTo() {},scrollY:0},
    document:{ addEventListener() {}, getElementById:element, documentElement:{scrollTop:0} },
    localStorage:{ getItem:k => storage.get(k) || null, setItem:(k,v) => storage.set(k,v), removeItem:k => storage.delete(k) }
  });
  vm.runInContext(source, context);
  context.alerts=[];
  context.history=[];
  context.resets=0;
  context.realSync = context.syncWithGoogleSheet;
  context.realRender = context.renderRecentDrives;
  vm.runInContext(`
    isAuthorized = () => true;
    showAlert = (message,type) => alerts.push({message,type});
    renderRecentDrives = () => {};
    renderTaxDashboard = () => {};
    recalculateHeaderMetrics = () => {};
    updateRecentSchoolsFromTrips = () => {};
    updateConnectionStatus = () => {};
    syncWithGoogleSheet = () => {};
    saveToRecentHistory = trip => history.push(trip);
    resetTripForm = () => { resets++; currentStops = []; };
    currentStops = [{address:'School'}];
  `,context);
  if (realSync) context.syncWithGoogleSheet = context.realSync;
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

test('hard refresh replaces cached zero km with edited sheet mileage and rerenders the feed',async () => {
  const requests=[];
  const fresh={...trip('A'),route:'School → Home',totalKm:34.5,km:34.5,synced:true};
  const c=browser(async (url,options) => {requests.push({url,options});return reply({status:'success',trips:[fresh],totalKm:34.5});},{realSync:true});
  c.renderRecentDrives=c.realRender;
  c.localStorage.setItem('driving_log_script_url','https://script.google.com/macros/s/example/exec?existing=1');
  for(const key of ['cached_trips_data','driving_log_recent_trips','driving_log_history']){
    c.localStorage.setItem(key,JSON.stringify([{...fresh,totalKm:0,km:0}]));
  }
  await c.syncWithGoogleSheet(true);
  await c.syncWithGoogleSheet(true);
  for(const key of ['cached_trips_data','driving_log_recent_trips','driving_log_history']){
    assert.equal(JSON.parse(c.localStorage.getItem(key))[0].totalKm,34.5);
  }
  assert.match(c.document.getElementById('recentDrivesFeed').innerHTML,/34\.5 KM/);
  assert.notEqual(requests[0].url,requests[1].url);
  assert.ok(new URL(requests[0].url).searchParams.get('_refresh'));
  assert.equal(new URL(requests[0].url).searchParams.get('existing'),'1');
  assert.equal(requests[0].options.cache,'no-store');
});

test('older sheet responses cannot overwrite a newer manual refresh',async () => {
  const complete=[];
  const c=browser(() => new Promise(resolve => complete.push(resolve)),{realSync:true});
  const old=c.syncWithGoogleSheet(false);
  const fresh=c.syncWithGoogleSheet(true);
  complete[1](reply({status:'success',trips:[{...trip('A'),totalKm:44}],totalKm:44}));
  await fresh;
  complete[0](reply({status:'success',trips:[{...trip('A'),totalKm:0}],totalKm:0}));
  await old;
  assert.equal(JSON.parse(c.localStorage.getItem('cached_trips_data'))[0].totalKm,44);
});

test('refresh reconciles a repaired sheet row by stable ID and hides its pending badge',async () => {
  const c=browser(async () => reply({status:'success',trips:[{...trip('A'),totalKm:28.6}],totalKm:28.6}),{realSync:true});
  c.enqueueOfflineTrip({...trip('A'),totalKm:0});
  assert.equal(c.document.getElementById('offlineQueueBadge').classList.contains('hidden'),false);
  await c.syncWithGoogleSheet(true);
  assert.equal(c.pending().length,0);
  assert.equal(c.document.getElementById('queueCount').innerText,'0');
  assert.equal(c.document.getElementById('offlineQueueBadge').classList.contains('hidden'),true);
});

test('confirmed save removes the persisted queue entry and explicitly hides the empty badge',async () => {
  const c=browser(async () => reply());c.enqueueOfflineTrip(trip('A'));
  await c.processPendingQueue();
  assert.equal(c.localStorage.getItem('pending_trips_queue'),'[]');
  assert.equal(c.document.getElementById('offlineQueueBadge').classList.contains('hidden'),true);
});

test('a refresh failure preserves previous cache and reports the Apps Script error',async () => {
  const c=browser(async () => reply({status:'error',message:'Wrong deployment'}),{realSync:true});
  c.localStorage.setItem('cached_trips_data',JSON.stringify([trip('A')]));
  assert.equal(await c.syncWithGoogleSheet(true),false);
  assert.equal(JSON.parse(c.localStorage.getItem('cached_trips_data')).length,1);
  assert.match(c.alerts.at(-1).message,/Wrong deployment/);
});

test('an empty sheet refresh clears stale cached trips',async () => {
  const c=browser(async () => reply({status:'success',trips:[],totalKm:0}),{realSync:true});
  c.localStorage.setItem('cached_trips_data',JSON.stringify([trip('A')]));
  await c.syncWithGoogleSheet(true);
  assert.equal(c.localStorage.getItem('cached_trips_data'),'[]');
});

test('pending clear requires confirmation and preserves saved records and newly added queue entries',async () => {
  const c=browser(async () => reply({success:false,error:'Invalid legacy distance'}));
  c.enqueueOfflineTrip(trip('A'));
  const saved={...trip('saved'),synced:true};
  for(const key of ['cached_trips_data','driving_log_recent_trips','driving_log_history']){
    c.localStorage.setItem(key,JSON.stringify([{...trip('A'),synced:false},saved]));
  }
  c.window.confirm=message => {
    assert.match(message,/discards their unsaved submissions/);
    c.enqueueOfflineTrip(trip('B'));return true;
  };
  await c.handlePendingClick();
  assert.deepEqual(c.pending().map(t => t.id),['B']);
  assert.equal(JSON.parse(c.localStorage.getItem('cached_trips_data'))[0].id,'saved');
});

test('cancelling pending clear keeps every unconfirmed submission',async () => {
  const c=browser(async () => reply({success:false,error:'Not saved'}));
  c.enqueueOfflineTrip(trip('A'));c.window.confirm=() => false;
  await c.handlePendingClick();assert.equal(c.pending().length,1);
});

test('hung response-body reads time out and release the pending drain lock',async () => {
  let hung=true;
  const c=browser(async () => hung ? {ok:true,json:() => new Promise(() => {})} : reply());
  const read=c.fetchJsonWithTimeout;
  c.fetchJsonWithTimeout=(url,options) => read(url,options,5);
  c.enqueueOfflineTrip(trip('A'));await c.processPendingQueue();
  assert.equal(c.pending().length,1);
  assert.equal(vm.runInContext('isProcessingPendingQueue',c),false);
  hung=false;await c.processPendingQueue();assert.equal(c.pending().length,0);
});

test('contradictory HTTP 200 success/error flags never discard a queued submission',async () => {
  const c=browser(async () => reply({success:false,status:'success',error:'Rejected'}));
  c.enqueueOfflineTrip(trip('A'));await c.processPendingQueue();assert.equal(c.pending().length,1);
});

function prepareRecord(c) {
  c.document.getElementById('tripDateInput').value='2026-11-05';
  c.document.getElementById('tripNoteInput').value='School Visit';
  vm.runInContext(`getActiveOriginAddress = () => 'Origin'; buildRouteSummary = () => 'School → Home';`,c);
}

test('record disables immediately and double taps cannot dispatch a second trip during routing',async () => {
  const c=browser();prepareRecord(c);let finish;let saved=0;
  c.calculateRouteKm=() => new Promise(resolve => {finish=resolve;});
  c.saveTripToSheet=async () => {saved++;};
  const first=c.recordCircuit();
  assert.equal(c.document.getElementById('submitDriveBtn').disabled,true);
  assert.match(c.document.getElementById('btnText').innerText,/Calculating KM/);
  assert.match(c.document.getElementById('btnIcon').innerHTML,/animate-spin/);
  c.applyAuthorizationState();
  assert.equal(c.document.getElementById('submitDriveBtn').disabled,true);
  await c.recordCircuit();assert.equal(saved,0);
  finish(18.7);await first;
  assert.equal(saved,1);assert.equal(c.document.getElementById('submitDriveBtn').disabled,false);
});

test('zero or invalid routing requires valid manual km, and cancelling cannot save',async () => {
  for(const manual of [null,'','0','NaN','Infinity','12km','-1','0.001']){
    const c=browser();prepareRecord(c);let saved=0;
    c.calculateRouteKm=async () => NaN;c.window.prompt=() => manual;
    c.saveTripToSheet=async () => {saved++;};
    await c.recordCircuit();assert.equal(saved,0,String(manual));
    assert.equal(c.document.getElementById('submitDriveBtn').disabled,false);
  }
  const c=browser();prepareRecord(c);let saved;
  c.calculateRouteKm=async () => 0;c.window.prompt=() => '22.4';
  c.saveTripToSheet=async p => {saved=p;};await c.recordCircuit();assert.equal(saved.totalKm,22.4);
});

test('all new school coordinates resolve before OSRM routing starts',async () => {
  let resolveSchool;let routed=false;
  const c=browser(async url => {
    assert.match(url,/router\.project-osrm\.org/);routed=true;
    return reply({code:'Ok',routes:[{distance:18700}]});
  });
  c.geocodeAddress=address => address==='New Elementary School'
    ? new Promise(resolve => {resolveSchool=resolve;}) : Promise.resolve([-79.4,43.7]);
  const work=c.calculateRouteKm(['Origin','New Elementary School']);
  await Promise.resolve();assert.equal(routed,false);
  resolveSchool([-79.5,43.8]);assert.equal(await work,18.7);assert.equal(routed,true);
});

test('invalid school coordinates prevent routing instead of producing zero distance',async () => {
  for(const coordinates of [null,[NaN,43],[-79,Infinity],[190,43],[-79,95]]){
    let routed=false;const c=browser(async () => {routed=true;return reply();});
    c.geocodeAddress=async () => coordinates;
    assert.equal(await c.calculateRouteKm(['Origin','School']),null);
    assert.equal(routed,false);
  }
});

test('direct save callbacks cannot enqueue or send invalid mileage',async () => {
  for(const value of [0,NaN,Infinity,null,false,'0','12km',0.001]){
    let calls=0;const c=browser(async () => {calls++;return reply();});
    await c.saveTripToSheet({...trip('A'),totalKm:value});
    assert.equal(calls,0);assert.equal(c.pending().length,0);
  }
});

test('zero, tiny and nonfinite OSRM distances require manual mileage instead of returning 0 km',async () => {
  for(const meters of [0,1,NaN,Infinity,-20]){
    const c=browser(async () => reply({code:'Ok',routes:[{distance:meters}]}));
    c.geocodeAddress=async () => [-79.4,43.7];
    assert.equal(await c.calculateRouteKm(['Origin','Elementary School']),null);
  }
});

test('service worker never falls back to a cached Apps Script response',async () => {
  const handlers={};let matches=0;
  const context=vm.createContext({URL,self:{addEventListener:(name,fn) => {handlers[name]=fn;}},
    fetch:async () => {throw new Error('offline');},caches:{match:async () => {matches++;return 'old 0 km';}}});
  vm.runInContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'),context);
  let response;handlers.fetch({request:{url:'https://script.google.com/macros/s/test/exec?_refresh=1'},respondWith:p => {response=p;}});
  await assert.rejects(response,/offline/);assert.equal(matches,0);
});
