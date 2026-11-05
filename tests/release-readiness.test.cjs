'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'player/player.js'), 'utf8');
const firefox = !!manifest.browser_specific_settings?.gecko;

function extractFunction(beginMarker, endMarker) {
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker, begin);
  assert.ok(begin >= 0 && end > begin, 'Expected function region exists');
  return source.slice(begin, end);
}

test('history messaging uses native async API for current browser', async () => {
  const code = extractFunction(
    '  function sendHistoryMessageOnce(message, timeoutMs = 4500) {',
    '\n  async function sendHistoryMessage(message, retries = 1) {'
  );
  const calls = [];
  const api = {
    runtime: {
      sendMessage(...args) {
        calls.push(args);
        if (firefox) {
          assert.equal(args.length, 1, 'Firefox sendMessage must not receive Chrome callback');
          return Promise.resolve({ok: true, stored: true});
        }
        assert.equal(args.length, 2, 'Chrome path uses a callback');
        args[1]({ok: true, stored: true});
      },
      lastError: null
    }
  };
  const ctx = {
    chrome: firefox ? undefined : api,
    browser: firefox ? api : undefined,
    setTimeout, clearTimeout, Error, Promise
  };
  vm.runInNewContext(code + '\nglobalThis.send = sendHistoryMessageOnce;', ctx);
  const result = await ctx.send({type:'VPR_HISTORY_UPSERT'}, 100);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test('failed messaging is rejected instead of hanging', async () => {
  const code = extractFunction(
    '  function sendHistoryMessageOnce(message, timeoutMs = 4500) {',
    '\n  async function sendHistoryMessage(message, retries = 1) {'
  );
  const api = {
    runtime: {
      sendMessage(...args) {
        if (firefox) return Promise.reject(new Error('offline'));
        args[1](undefined);
      },
      lastError: null
    }
  };
  const ctx = { chrome: firefox ? undefined : api, browser: firefox ? api : undefined,
    setTimeout, clearTimeout, Error, Promise };
  vm.runInNewContext(code + '\nglobalThis.send = sendHistoryMessageOnce;', ctx);
  await assert.rejects(ctx.send({type:'VPR_HISTORY_UPSERT'}, 100), /offline|没有返回/);
});

test('history is saved even if the optional catalog lookup never responds', async () => {
  const code = extractFunction(
    '  async function setupWatchHistory(video, videoInfo) {',
    '\n  async function initializePlayer() {'
  );
  const calls = [];
  const events = new Map();
  const storage = {
    local: { async get() { return {historyEnabled:true}; } },
    onChanged: { addListener() {} }
  };
  const fakeApi = { storage };
  const ctx = {
    chrome: fakeApi, browser: fakeApi,
    canonicalizeWatchUrl: s => s,
    sourceUrl:'https://v.qq.com/x/cover/a/b.html',
    siteId:'tencent',
    showResumePrompt() {},
    fetchCatalogMetadata() { return new Promise(() => {}); },
    showStorageWarning() {},
    async sendHistoryMessage(message) {
      calls.push(message);
      return message.type === 'VPR_HISTORY_GET_FOR_URL'
        ? {ok:true, item:null}
        : {ok:true, storage:{warning:false}};
    },
    Date, Math, Promise, Number, console,
    document: {addEventListener() {}},
    window: {addEventListener() {}}
  };
  vm.runInNewContext(code + '\nglobalThis.setup = setupWatchHistory;', ctx);
  const video = {
    duration:100, currentTime:25, ended:false,
    addEventListener(name, callback) { events.set(name, callback); }
  };
  const controller = await ctx.setup(video, {pic:'https://example.com/a.jpg'});
  const race = await Promise.race([
    controller.save(true,false).then(()=> 'saved'),
    new Promise(resolve => setTimeout(()=>resolve('timed out'), 200))
  ]);
  assert.equal(race, 'saved', 'Progress must not depend on catalog metadata');
  assert.ok(calls.some(c => c.type === 'VPR_HISTORY_UPSERT'));
});

test('release has valid stable version and browser-specific entry points', () => {
  assert.equal(manifest.version, '1.0.1');
  assert.ok(!manifest.permissions.includes('declarativeNetRequestFeedback'));
  const html = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
  assert.match(html, />v1\.0\.1<\/span>/);
  if (firefox) {
    assert.ok(manifest.background.scripts.includes('background.js'));
    assert.ok(manifest.browser_specific_settings.gecko.strict_min_version);
  } else {
    assert.equal(manifest.background.service_worker, 'background.js');
  }
});
