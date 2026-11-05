'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'shared/console-clear-debug.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function harness(browserName, initialEnabled = false, initialRegistered = []) {
  const data = { debugConsoleClear: initialEnabled };
  const scripts = new Map(initialRegistered.map(script => [script.id, script]));
  const callbacks = { changed: [], installed: [], startup: [] };
  const calls = { register: 0, unregister: 0 };
  const api = {
    storage: {
      local: { async get(defaults) { return { ...defaults, ...data }; } },
      onChanged: { addListener(fn) { callbacks.changed.push(fn); } }
    },
    runtime: {
      onInstalled: { addListener(fn) { callbacks.installed.push(fn); } },
      onStartup: { addListener(fn) { callbacks.startup.push(fn); } }
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) {
        return ids.map(id => scripts.get(id)).filter(Boolean);
      },
      async registerContentScripts(list) {
        calls.register++;
        for (const item of list) {
          if (scripts.has(item.id)) throw Error('duplicate content script');
          scripts.set(item.id, item);
        }
      },
      async unregisterContentScripts({ ids }) {
        calls.unregister++;
        for (const id of ids) scripts.delete(id);
      }
    }
  };
  const context = { console: { warn() {} }, browser: browserName === 'firefox' ? api : undefined, chrome: api };
  vm.runInNewContext(source, context);
  return {
    data, scripts, callbacks, calls,
    async flush() {
      for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
    },
    change(enabled) {
      const before = data.debugConsoleClear;
      data.debugConsoleClear = enabled;
      for (const fn of callbacks.changed) {
        fn({ debugConsoleClear: { oldValue: before, newValue: enabled } }, 'local');
      }
    }
  };
}

for (const browserName of ['chrome', 'firefox']) {
  test(browserName + ': disabled by default (no interception registered)', async () => {
    const env = harness(browserName);
    await env.flush();
    assert.equal(env.scripts.size, 0);
    assert.equal(env.calls.register, 0);
  });

  test(browserName + ': enabled registers top-frame MAIN document_start script once', async () => {
    const env = harness(browserName, true);
    await env.flush();
    assert.equal(env.scripts.size, 1);
    const item = env.scripts.get('vpr-console-clear-debug');
    assert.equal(item.world, 'MAIN');
    assert.deepEqual([...item.matches], ['https://*/*']);
    assert.equal(item.runAt, 'document_start');
    assert.equal(item.allFrames, false);
    assert.deepEqual([...item.js], ['intercept-console-clear.js']);
    assert.equal(item.persistAcrossSessions, true);
    for (const fn of env.callbacks.startup) fn();
    for (const fn of env.callbacks.installed) fn();
    await env.flush();
    assert.equal(env.calls.register, 1);
  });

  test(browserName + ': toggling off unregisters and toggling on re-registers', async () => {
    const env = harness(browserName, true);
    await env.flush();
    env.change(false);
    await env.flush();
    assert.equal(env.scripts.size, 0);
    assert.equal(env.calls.unregister, 1);
    env.change(true);
    await env.flush();
    assert.equal(env.scripts.size, 1);
    assert.equal(env.calls.register, 2);
  });

  test(browserName + ': stale registration is removed after restart when disabled', async () => {
    const stale = [{ id: 'vpr-console-clear-debug', js: ['intercept-console-clear.js'] }];
    const env = harness(browserName, false, stale);
    await env.flush();
    assert.equal(env.scripts.size, 0);
  });

  test(browserName + ': rapid setting changes converge to the final setting', async () => {
    const env = harness(browserName);
    env.change(true);
    env.change(false);
    env.change(true);
    await env.flush();
    assert.equal(env.scripts.size, 1);
    env.change(false);
    await env.flush();
    assert.equal(env.scripts.size, 0);
  });
}

test('manifest no longer injects console interceptor unconditionally', () => {
  const scripts = manifest.content_scripts || [];
  assert.ok(scripts.every(item => !(item.js || []).includes('intercept-console-clear.js')));
});

test('each browser loads its registration helper correctly', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  if (manifest.background.service_worker) {
    assert.match(background, /shared\/console-clear-debug\.js/);
  } else {
    assert.ok(manifest.background.scripts.includes('shared/console-clear-debug.js'));
    assert.ok(manifest.background.scripts.indexOf('shared/console-clear-debug.js') <
      manifest.background.scripts.indexOf('background.js'));
  }
});

test('settings checkbox exists and is explicitly false by default', () => {
  const html = fs.readFileSync(path.join(root, 'setting/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'setting/setting.js'), 'utf8');
  assert.match(html, /id="debugConsoleClear"/);
  assert.match(js, /debugConsoleClear: false/);
  assert.match(js, /\[ui\.debugConsoleClear, "debugConsoleClear"\]/);
});

test('production build excludes the development-only DNR feedback permission', () => {
  assert.ok(!manifest.permissions.includes('declarativeNetRequestFeedback'));
});
