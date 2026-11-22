import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';

// Execute the actual nested production functions, not a second implementation.
// The browser module loader is replaced only at the host boundary.
const text = readFileSync(new URL('./src/client.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('client.ts', text, ts.ScriptTarget.Latest, true);
const functions = new Map();
let serviceCleanupFactory;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isCallExpression(node) && node.arguments[1] !== undefined
      && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === 'dsh-split-panels: service cleanup') {
    serviceCleanupFactory = node.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const pause = (ms=10) => new Promise(resolve=>setTimeout(resolve,ms));
function harness(names, extra={}) {
  const errors=[];
  const context=vm.createContext({
    console, Promise, Map, WeakMap, Set, queueMicrotask,
    window:{setTimeout,clearTimeout},
    focusRequest:0,focusNavigationInProgress:false,focusDrainPending:false,
    focusActivation:{started:false,active:false,away:false},findLeafNode:()=>null,isGlobalPanelActive:()=>false,
    runtimeState:{enabled:true,safeMode:false},
    paneSessionReferences:new Map(), entryStoreCache:new Map(), entryInjectCache:new Map(),
    claimPrefetchedReference:()=>undefined,
    noteRetainFailure:(_id,message)=>errors.push(message),
    clearRetainFailure:()=>{}, retainFailureOf:()=>undefined,
    notePaneFace:()=>{}, setRuntime:()=>{},
    RETAIN_RETRY_DELAYS_MS:[5,5,5], LOG_PREFIX:'test', errors,
    ...extra,
  });
  const code=names.map(name=>{
    assert.ok(functions.has(name),`production function ${name} exists`);
    return functions.get(name);
  }).join('\n');
  vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return context;
}
const lifecycle=['referenceIsLive','ensureSessionReference','releaseSessionReference','faceFromReference','bindSessionFace','retainRetryDelay','createSessionFaceResolver','clearPaneEntryCaches'];
function publicReference(sessionId, ready=Promise.resolve(), onRelease=()=>{}) {
  let released=false;
  const session={id:sessionId};
  return {sessionId,ready,get binding(){if(released)throw Error('released'); return {session};},release(){if(!released){released=true;onRelease();}}};
}

test('accepts public-only references and owns exactly one acquisition',()=>{
  let acquired=0,released=0;
  const ref=publicReference('a',Promise.resolve(),()=>released++);
  const h=harness(lifecycle,{sessionsService:{retain(){acquired++;return ref;}}});
  assert.equal(h.referenceIsLive(ref),true);
  assert.equal(h.ensureSessionReference('a'),ref);
  assert.equal(h.ensureSessionReference('a'),ref);
  assert.equal(acquired,1);
  h.releaseSessionReference('a');h.releaseSessionReference('a');
  assert.equal(released,1);assert.equal(h.referenceIsLive(ref),false);
});

test('invalid cached reference is released before a fresh retain',()=>{
  let released=0;
  const h=harness(lifecycle,{sessionsService:{retain(){return publicReference('a');}}});
  h.paneSessionReferences.set('a',{get binding(){throw Error('generation ended');},release(){released++;}});
  assert.ok(h.ensureSessionReference('a'));assert.equal(released,1);
});

test('ready rejection releases that attempt, then a new reference resolves',async()=>{
  let acquired=0,released=0;
  const face={id:'fresh'};
  const h=harness(lifecycle,{sessionsService:{retain(){
    acquired++;
    if(acquired===1)return publicReference('a',Promise.reject(Error('first-open-failed')),()=>released++);
    return {sessionId:'a',binding:{session:face},ready:Promise.resolve(),release(){released++;}};
  }}});
  const resolver=h.createSessionFaceResolver('a',[5,5,5]);
  const unsubscribe=resolver.subscribe(()=>{});
  await pause(35);
  assert.equal(resolver.getSnapshot().face,face);
  assert.equal(acquired,2);assert.equal(released,1);
  assert.ok(h.errors.some(error=>error.includes('ready: first-open-failed')));
  resolver.dispose();unsubscribe();h.releaseSessionReference('a');assert.equal(released,2);
});

test('late ready completion cannot revive a disposed resolver',async()=>{
  let finish;const ready=new Promise(resolve=>{finish=resolve;});
  const h=harness(lifecycle,{sessionsService:{retain:()=>publicReference('a',ready)}});
  const resolver=h.createSessionFaceResolver('a',[20,20]);let notifications=0;
  resolver.subscribe(()=>notifications++);await pause(5);resolver.dispose();
  const before=notifications;h.releaseSessionReference('a');finish();await pause(5);
  assert.equal(notifications,before);assert.equal(resolver.getSnapshot().face,undefined);
});

test('a retained host cannot borrow the main-view generation for a missing pane',()=>{
  const h=harness(lifecycle,{sessionsService:{retain(){},binding:()=>({session:{id:'wrong'}})}});
  assert.equal(h.bindSessionFace('missing'),undefined);
});

test('closing one pane invalidates its stores/injections without evicting neighbours',()=>{
  const h=harness(['entryStoreInstance','cachedEntryInject','clearPaneEntryCaches']);
  let serial=0;const handle={create:scope=>({scope,serial:++serial})};const raw={store:handle};const parts={raw};
  const a=h.entryStoreInstance(parts,'a','scope');const b=h.entryStoreInstance(parts,'b','scope');
  assert.notEqual(a,b);
  const injectA=h.cachedEntryInject(parts,'a','scope',()=>({generation:1}));
  const injectB=h.cachedEntryInject(parts,'b','scope',()=>({generation:1}));
  h.clearPaneEntryCaches('a');
  assert.equal(h.entryStoreInstance(parts,'b','scope'),b);
  assert.equal(h.cachedEntryInject(parts,'b','scope',()=>({generation:2})),injectB);
  assert.notEqual(h.entryStoreInstance(parts,'a','scope'),a);
  assert.notEqual(h.cachedEntryInject(parts,'a','scope',()=>({generation:2})),injectA);
  for(let i=0;i<100;i++) {h.entryStoreInstance(parts,'temp-'+i,'scope');h.cachedEntryInject(parts,'temp-'+i,'scope',()=>({}));h.clearPaneEntryCaches('temp-'+i);}
  assert.equal(h.entryStoreCache.get(handle).size,2);assert.equal(h.entryInjectCache.size,2);
});

test('a native main-view clear is authoritative over the previous rendered sidebar row',()=>{
  const byId={a:{retainedBy:{mainView:1}}};
  const h=harness(['currentSessionId'],{sessionsListSource:{getSnapshot:()=>({phase:'ready',byId})},selectedSidebarSessionId:()=> 'stale-dom'});
  assert.equal(h.currentSessionId(),'a');byId.a.retainedBy.mainView=0;assert.equal(h.currentSessionId(),undefined);
  h.sessionsListSource=undefined;assert.equal(h.currentSessionId(),'stale-dom');
});

test('focus navigation uses the public SessionTarget string and reports sync errors',()=>{
  const targets=[], errors=[];
  const h=harness(['syncFocusedSession'],{
    dsvOperational:()=>true,isValidSessionId:id=>typeof id==='string',currentSessionId:()=> 'old',
    focusRequest:0,treeStore:{getSnapshot:()=>({focus:'a'})},setRuntime:value=>errors.push(value),
    uiWorkspaceService:{openSession:target=>targets.push(target)},
  });
  h.syncFocusedSession('a');assert.deepEqual(targets,['a']);
  h.uiWorkspaceService.openSession=()=>{throw Error('navigation unavailable');};
  assert.doesNotThrow(()=>h.syncFocusedSession('a'));
  assert.ok(errors[0].lastError.includes('navigation unavailable'));
});

test('same-stack focus re-entry retains once and drains only the latest intent',()=>{
  const targets=[],tasks=[];let native='a';const tree={focus:'b',root:{}};
  const h=harness(['syncFocusedSession'],{queueMicrotask:fn=>tasks.push(fn),dsvOperational:()=>true,
    isValidSessionId:id=>typeof id==='string',currentSessionId:()=>native,treeStore:{getSnapshot:()=>tree},
    uiWorkspaceService:{openSession(id){targets.push(id);h.syncFocusedSession(id);native=id;}}});
  h.syncFocusedSession('b');assert.deepEqual(targets,['b']);tasks.shift()();assert.equal(tasks.length,0);
  assert.equal(h.focusDrainPending,false);
  targets.length=0;native='a';tree.focus='b';
  h.uiWorkspaceService.openSession=id=>{targets.push(id);if(id==='b'){tree.focus='a';h.syncFocusedSession('a');}native=id;};
  h.syncFocusedSession('b');assert.deepEqual(targets,['b']);tasks.shift()();assert.deepEqual(targets,['b','a']);assert.equal(native,'a');
  tree.focus='b';h.findLeafNode=()=>({pending:true});h.syncFocusedSession('b');assert.deepEqual(targets,['b','a']);
});

test('same-target reentry never overwrites a newer external navigation in the same turn',()=>{
  const targets=[],tasks=[];let native='a';const tree={focus:'b',root:{}};
  const h=harness(['syncFocusedSession'],{queueMicrotask:fn=>tasks.push(fn),dsvOperational:()=>true,
    isValidSessionId:()=>true,currentSessionId:()=>native,treeStore:{getSnapshot:()=>tree},
    uiWorkspaceService:{openSession(id){targets.push(id);if(id==='b')h.syncFocusedSession(id);native=id;}}});
  h.syncFocusedSession('b');h.uiWorkspaceService.openSession('c');
  assert.equal(tasks.length,1);tasks.shift()();
  assert.deepEqual(targets,['b','c']);assert.equal(native,'c');assert.equal(tasks.length,0);
  assert.equal(h.focusDrainPending,false);
  targets.length=0;native='a';tree.focus='b';
  h.uiWorkspaceService.openSession=id=>{targets.push(id);if(id==='b'){tree.focus='a';h.syncFocusedSession('a');}native=id;};
  h.syncFocusedSession('b');h.uiWorkspaceService.openSession('c');tasks.shift()();
  assert.deepEqual(targets,['b','c']);assert.equal(native,'c');assert.equal(h.focusDrainPending,false);
  targets.length=0;native='old';tree.focus='b';
  h.uiWorkspaceService.openSession=id=>{targets.push(id);if(id==='b'){tree.focus='a';h.syncFocusedSession('a');throw Error('refused');}native=id;};
  h.syncFocusedSession('b');tasks.shift()();assert.deepEqual(targets,['b','a']);assert.equal(native,'a');
});

test('service cleanup cancels a queued different-target drain and unbinds native navigation',()=>{
  const targets=[],tasks=[];let native='a';const tree={focus:'b',root:{}};
  const emptyRegistries=Object.fromEntries(('paneChatStores paneSessionReferences paneEditorGuards paneDisposeChecks '
    +'paneLiveRefs sessionFaceResolvers paneRetainFailures paneTypingUnsubs chatScrollMemory lastSessionSummaries '
    +'entryStoreCache paneImageIntake paneKitWarned rootPendingBySession rootPendingListeners composerModeStore '
    +'composingSince pendingSessions suppressedNewSessions pendingDraftTransfers pendingListeners pendingTransferListeners')
    .split(' ').map(name=>[name,new Map()]));
  const h=harness(['syncFocusedSession'],{...emptyRegistries,queueMicrotask:fn=>tasks.push(fn),
    dsvOperational:()=>true,isValidSessionId:()=>true,currentSessionId:()=>native,treeStore:{getSnapshot:()=>tree},
    focusActivation:{started:true,active:true,away:false},
    uiWorkspaceService:{openSession(id){targets.push(id);if(id==='b'){tree.focus='a';h.syncFocusedSession('a');}native=id;}},
    flushPaneViewState:()=>{},dropPrefetchedSession:()=>{},clearEntryInjectCache:()=>{},domListSourceDispose:null,
    paneDebug:{},composerChainDebug:{},rootStandard:{listeners:new Set()},captureLog:{},
    restoreCreateObserver:null,pendingPumpTimer:0,FALLBACK_TRANSLATE:{},failureWindow:[],failureLog:new Map(),
  });
  assert.ok(serviceCleanupFactory,'actual labeled service cleanup is captured');
  const factory=vm.runInContext(ts.transpileModule(`(${serviceCleanupFactory})`,
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h);
  const dispose=factory();h.syncFocusedSession('b');
  assert.equal(tasks.length,1);assert.equal(h.focusDrainPending,true);const token=h.focusRequest;
  dispose();assert.equal(h.focusRequest,token+1);assert.equal(h.focusDrainPending,false);
  assert.equal(h.focusActivation.active,false);assert.equal(h.uiWorkspaceService,undefined);
  tasks.shift()();h.syncFocusedSession('a');
  assert.deepEqual(targets,['b']);assert.equal(native,'b');assert.equal(tasks.length,0);
});

test('failed reentrant focus is not retried and disposed drains cannot navigate',()=>{
  const tasks=[],targets=[];const h=harness(['syncFocusedSession'],{queueMicrotask:fn=>tasks.push(fn),
    dsvOperational:()=>true,isValidSessionId:()=>true,currentSessionId:()=> 'old',treeStore:{getSnapshot:()=>({focus:'a'})},
    uiWorkspaceService:{openSession(id){targets.push(id);h.syncFocusedSession(id);throw Error('refused');}}});
  h.syncFocusedSession('a');tasks.shift()();assert.deepEqual(targets,['a']);assert.equal(tasks.length,0);
  h.uiWorkspaceService.openSession=id=>{targets.push(id);h.syncFocusedSession(id);};
  h.syncFocusedSession('a');h.focusRequest++;h.focusDrainPending=false;tasks.shift()();assert.deepEqual(targets,['a','a']);
});

test('boot focus restores once; reactivation and global return adopt current native',()=>{
  const opened=[],followed=[];let native='p1';const h=harness(['updateFocusActivation'],{
    treeStore:{getSnapshot:()=>({focus:'p6'})},syncFocusedSession:id=>opened.push(id),currentSessionId:()=>native,followNativeSession:id=>followed.push(id)});
  h.updateFocusActivation(true,true,false);h.updateFocusActivation(true,true,false);assert.deepEqual(opened,['p6']);
  h.updateFocusActivation(false,true,false);native='p2';h.updateFocusActivation(true,true,false);assert.deepEqual(followed,['p2']);
  h.updateFocusActivation(true,true,true);native='p3';h.updateFocusActivation(true,true,false);assert.deepEqual(followed,['p2','p3']);assert.deepEqual(opened,['p6']);
  h.focusActivation={started:false,active:false,away:false};opened.length=0;
  h.updateFocusActivation(false,false,true);h.updateFocusActivation(true,true,false);assert.deepEqual(opened,[]);assert.equal(followed.at(-1),'p3');
  h.focusActivation={started:false,active:false,away:false};followed.length=0;
  h.updateFocusActivation(true,false,false,false);assert.equal(h.focusActivation.started,false);
  h.updateFocusActivation(true,false,false,true);assert.equal(h.focusActivation.started,true);assert.deepEqual(followed,['p3']);assert.deepEqual(opened,[]);
  h.focusActivation={started:false,active:false,away:false};followed.length=0;h.isGlobalPanelActive=()=>true;
  h.updateFocusActivation(true,true,false,true);
  assert.equal(h.focusActivation.started,true);assert.equal(h.focusActivation.away,true);
  assert.deepEqual(opened,[]);assert.deepEqual(followed,[]);
  h.isGlobalPanelActive=()=>false;native='p4';h.updateFocusActivation(true,true,false,true);
  assert.deepEqual(followed,['p4']);assert.deepEqual(opened,[]);
});

test('native navigation rejected at the pane cap returns to the retained focus',()=>{
  const opened=[],restored=[];const tree={root:{},focus:'p6'};let enabled=true;
  const h=harness(['followNativeSession'],{dsvOperational:()=>enabled,isValidSessionId:()=>true,
    treeStore:{getSnapshot:()=>tree,setFocus:id=>{tree.focus=id},openRight:id=>opened.push(id)},
    findLeafNode:(_root,id)=>id==='p6'?{}:null,paneKitTrustworthy:()=>true,consumeSuppressedNewSession:()=>false,
    oldestPendingRecord:()=>null,syncFocusedSession:id=>restored.push(id)});
  h.followNativeSession('p7');assert.deepEqual(opened,['p7']);assert.deepEqual(restored,['p6']);
  h.followNativeSession('p6');assert.deepEqual(restored,['p6']);
  enabled=false;h.followNativeSession('p7');assert.deepEqual(opened,['p7']);
  enabled=true;h.focusActivation.away=true;h.followNativeSession('p7');assert.deepEqual(opened,['p7']);assert.deepEqual(restored,['p6']);
  h.focusActivation.away=false;h.isGlobalPanelActive=()=>true;h.followNativeSession('p7');
  assert.deepEqual(opened,['p7']);assert.deepEqual(restored,['p6']);
});

test('explicit release cancels owned retry timers and leaves other owners untouched',()=>{
  const owned=new Map(),resolvers=new Map(),live=new Map(),checks=new Map();let released=0,disposed=0,prefetch=0;
  owned.set('a',publicReference('a',Promise.resolve(),()=>released++));resolvers.set('b',{});live.set('c',1);
  const h=harness(['releaseSplitResources','releaseSessionReference'],{
    focusRequest:0,paneSessionReferences:owned,sessionFaceResolvers:resolvers,paneLiveRefs:live,paneDisposeChecks:checks,
    dropPrefetchedSession:()=>prefetch++,disposePane:()=>disposed++,
  });
  const main=publicReference('main');h.releaseSplitResources();
  assert.equal(released,1);assert.equal(disposed,3);assert.equal(prefetch,1);
  assert.ok(main.binding);assert.equal(owned.size,0);
});

test('body mount survives suspended frames and cancels every scheduler handle',()=>{
  let serial=0,mounts=0;const frames=new Map(),timers=new Map();
  const h=harness(['schedulePaneBodyMount'],{window:{
    requestAnimationFrame:cb=>{frames.set(++serial,cb);return serial},cancelAnimationFrame:id=>frames.delete(id),
    setTimeout:cb=>{timers.set(++serial,cb);return serial},clearTimeout:id=>timers.delete(id),
  }});
  const dispose=h.schedulePaneBodyMount(()=>mounts++);
  const lateFrame=[...frames.values()][0],timer=[...timers.values()][0];timer();
  assert.equal(mounts,1);assert.equal(frames.size,0);assert.equal(timers.size,0);
  lateFrame();timer();dispose();assert.equal(mounts,1);assert.equal(frames.size,0);
  const cancel=h.schedulePaneBodyMount(()=>mounts++),lateTimer=[...timers.values()][0];
  cancel();lateTimer();assert.equal(mounts,1);assert.equal(timers.size,0);assert.equal(frames.size,0);
  h.schedulePaneBodyMount(()=>mounts++);
  const [id,first]=[...frames][0];frames.delete(id);first();
  const [id2,second]=[...frames][0];frames.delete(id2);second();
  assert.equal(mounts,2);assert.equal(timers.size,0);assert.equal(frames.size,0);
});

test('pane scroll overrides native memory, batches writes and isolates neighbours',()=>{
  let nativeWrites=0;const writes=[];
  const h=harness(['viewExtras','rememberChatScroll','persistPaneViewState','flushPaneViewState'],{
    paneViewState:new Map(),chatScrollMemory:new Map(),paneStatePersistTimer:0,paneStateDirty:false,
    PANE_STATE_KEY:'test-pane-state',storageSet:(key,value)=>writes.push([key,JSON.parse(value)]),
  });
  const prepared=id=>({kit:{sessionId:id},store:{},renderers:{}});
  const native={save(){nativeWrites++},read:()=>({native:true})};
  const a=h.viewExtras(prepared('a'),{},{chatScroll:native});
  const b=h.viewExtras(prepared('b'),{},{chatScroll:native});
  assert.notEqual(a.chatScroll,native);assert.equal(a.chatScroll.read(),null);
  b.chatScroll.save({anchor:'neighbour',offset:22});
  for(let i=0;i<100;i++)a.chatScroll.save({anchor:'row',offset:i});
  assert.equal(nativeWrites,0);assert.equal(writes.length,0);
  assert.equal(a.chatScroll.read().offset,99);assert.equal(b.chatScroll.read().offset,22);
  h.flushPaneViewState();assert.equal(writes.length,1);assert.equal(h.paneStatePersistTimer,0);
  assert.equal(writes[0][1].find(([id])=>id==='a')[1].scroll.offset,99);
  h.flushPaneViewState();assert.equal(writes.length,1);
  a.chatScroll.save(null);h.flushPaneViewState();assert.equal(a.chatScroll.read(),null);
  assert.equal(b.chatScroll.read().offset,22);
  for(let i=0;i<100;i++)h.rememberChatScroll('temp-'+i,{anchor:'x',offset:i});
  h.flushPaneViewState();assert.equal(h.chatScrollMemory.size,32);assert.equal(writes.at(-1)[1].length,32);
});
