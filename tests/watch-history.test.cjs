'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const begin = source.indexOf('const WATCH_HISTORY_KEY =');
const end = source.indexOf('/* =========================================================\n * DNR', begin);
assert.ok(begin >= 0 && end > begin, 'History implementation is present');
const historySource = source.slice(begin, end);

function setup(initial = {}, options = {}) {
  const data = structuredClone(initial);
  let failWrite = false;
  const storage = {
    QUOTA_BYTES: 10 * 1024 * 1024,
    async get(keys) {
      if (keys === null) return structuredClone(data);
      if (typeof keys === 'object' && !Array.isArray(keys)) {
        return Object.fromEntries(Object.entries(keys).map(([k, fallback]) =>
          [k, Object.hasOwn(data, k) ? structuredClone(data[k]) : fallback]));
      }
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
      }
      return result;
    },
    async set(update) {
      if (failWrite) { failWrite = false; throw new Error('Simulated storage failure'); }
      Object.assign(data, structuredClone(update));
    },
    async getBytesInUse() {
      return new TextEncoder().encode(JSON.stringify(data)).length;
    }
  };
  if (options.noGetBytesInUse) delete storage.getBytesInUse;
  const namespace = { storage: { local: storage } };
  const context = { URL, TextEncoder, chrome: namespace, browser: namespace };
  vm.runInNewContext(historySource + '\nglobalThis.api = {normalizeHistoryUrl, normalizeWatchHistoryItem, importWatchHistory, upsertWatchHistory, getWatchHistory, clearWatchHistory, getStorageStatus};', context);
  return { api: context.api, data, failNextWrite() { failWrite = true; } };
}
const record = (suffix, updatedAt = 1000, progress = 20) => ({
  url: 'https://example.com/video/' + suffix,
  duration: 100, progress, updatedAt, title: 'Video ' + suffix
});

test('empty backup imports successfully without erasing data', async () => {
  const env = setup({watchHistory: [record('original')]});
  const result = await env.api.importWatchHistory([]);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.equal(env.data.watchHistory.length, 1);
});

test('validates every record before any storage modification', async () => {
  const env = setup({watchHistory: [record('original')]});
  await assert.rejects(env.api.importWatchHistory([record('good'), {url: 'javascript:alert(1)', updatedAt: 1}]), /invalid history record/i);
  assert.equal(env.data.watchHistory.length, 1);
  await assert.rejects(env.api.importWatchHistory([record('good'), {...record('bad'), updatedAt: 'oops'}]), /invalid history record/i);
  assert.equal(env.data.watchHistory.length, 1);
});

test('deduplicates backup and preserves newer local progress', async () => {
  const env = setup({watchHistory: [record('keep', 5000, 70), record('update', 1000, 10)]});
  const result = await env.api.importWatchHistory([
    record('keep', 3000, 1), record('update', 2000, 80),
    record('added', 1100, 15), record('added', 1200, 20)
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 2);
  const items = await env.api.getWatchHistory();
  assert.equal(items.find(x => x.url.endsWith('/keep')).progress, 70);
  assert.equal(items.find(x => x.url.endsWith('/update')).progress, 80);
  assert.equal(items.find(x => x.url.endsWith('/added')).updatedAt, 1200);
});

test('manual import works with automatic history recording disabled', async () => {
  const env = setup({historyEnabled: false});
  const result = await env.api.importWatchHistory([record('backup')]);
  assert.equal(result.added, 1);
  const save = await env.api.upsertWatchHistory(record('live'));
  assert.equal(save.saved, false);
  assert.equal(env.data.watchHistory.length, 1);
});

test('failed storage write does not partially import records', async () => {
  const env = setup({watchHistory: [record('existing')]});
  env.failNextWrite();
  await assert.rejects(env.api.importWatchHistory([record('a'), record('b')]), /Simulated storage failure/);
  assert.equal(env.data.watchHistory.length, 1);
});

test('clear is serialized after an already requested upsert', async () => {
  const env = setup();
  await Promise.all([env.api.upsertWatchHistory(record('to-clear')), env.api.clearWatchHistory()]);
  assert.equal(env.data.watchHistory.length, 0);
});

test('nullable episodeIndex stays null; unsupported protocols are rejected', () => {
  const env = setup();
  assert.equal(env.api.normalizeWatchHistoryItem({...record('a'), episodeIndex: null}).episodeIndex, null);
  assert.equal(env.api.normalizeHistoryUrl('javascript:alert(1)'), '');
});

test('storage usage fallback works without getBytesInUse on old Firefox', async () => {
  const env = setup({watchHistory: [record('fallback')]}, {noGetBytesInUse: true});
  const status = await env.api.getStorageStatus();
  assert.ok(status.bytesInUse > 0);
  assert.ok(Number.isFinite(status.percent));
});

test('version label is allowed to be beta while manifest version is numeric', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.1');
  const languages = ['en.json', 'zh-CN.json'];
  for (const file of languages) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../language', file), 'utf8'));
    assert.equal(data['app.version'], file === 'en.json' ? 'v1.0.1-beta' : 'v1.0.1-beta');
  }
});
