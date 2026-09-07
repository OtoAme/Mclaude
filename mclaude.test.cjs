'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { findMirasim, parseArgs, readCatalog, cachedCatalog, buildSettings } = require('./mclaude.cjs');

const catalog = {
  agent: 'claude',
  models: [
    { id: 'claude-opus-4-8[1m]', label: 'opus 4.8' },
    { id: 'claude-opus-5[1m]', label: 'opus 5' },
    { id: 'claude-sonnet-5[1m]', label: 'sonnet 5' },
    { id: 'claude-fable-5-1[1m]', label: 'fable 5.1' },
    { id: 'claude-fable-5[1m]', label: 'fable 5' }
  ],
  defaultModel: 'claude-opus-5[1m]',
  defaultEffort: 'high'
};

test('uses the running Desktop without starting another backend', () => {
  let calls = 0;
  const result = readCatalog('/mirasim/server.cjs', (command, args, options) => {
    calls++;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['/mirasim/server.cjs', 'ui-cli', '--port', '4970', 'catalog', '--agent', 'claude']);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    return JSON.stringify(catalog);
  });
  assert.deepEqual(result, catalog);
  assert.equal(calls, 1);
});

test('reads saved configuration through a temporary backend when Desktop is closed', () => {
  const calls = [];
  const result = readCatalog('/mirasim/server.cjs', (command, args, options) => {
    calls.push(args);
    if (args.includes('--port')) throw new Error('ECONNREFUSED');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok(options.timeout > 15000);
    return '[server] temporary backend started; access-token=test-secret\n' + JSON.stringify(catalog, null, 2) + '\n';
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['/mirasim/server.cjs', 'ui-cli', 'catalog', '--agent', 'claude']);
  assert.equal(buildSettings(result, {}).model, catalog.defaultModel);
});

test('reports failed catalog reads without exposing backend output', () => {
  let calls = 0;
  assert.throws(() => readCatalog('/mirasim/server.cjs', () => {
    calls++;
    const error = new Error('backend access-token=test-secret');
    error.stderr = 'private startup log';
    throw error;
  }), (error) => {
    assert.match(error.message, /无法读取 Mirasim 模型配置/);
    assert.doesNotMatch(error.message, /test-secret|private startup log/);
    return true;
  });
  assert.equal(calls, 2);
});

function cacheFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mclaude-cache-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.mirasim', 'setting.json');
  const file = path.join(home, '.cache', 'catalog.json');
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, JSON.stringify({ auth: 'test-private-credential' }));
  const state = {
    home, settings, file, time: 100000, calls: 0,
    mirasim: { version: '0.0.295', entry: '/mirasim/0.0.295/server.cjs' },
    read: () => catalog
  };
  state.get = (env = {}, refresh = false) => cachedCatalog(state.mirasim, {
    home, env, cacheDir: path.dirname(file), refresh, now: () => state.time,
    read: () => { state.calls++; return state.read(); }
  });
  return state;
}

test('shares model information for seven days without caching per-launch choices or credentials', (t) => {
  const cache = cacheFixture(t);
  cache.read = () => ({ ...catalog, token: 'test-backend-token', port: 12345,
    models: catalog.models.map((model) => ({ ...model, credential: 'test-model-secret' })) });
  assert.deepEqual(cache.get(), catalog);
  cache.time += 7 * 24 * 60 * 60 * 1000 - 1;
  assert.equal(buildSettings(cache.get(), { model: 'sonnet', effort: 'low' }).model, 'claude-sonnet-5[1m]');
  assert.equal(buildSettings(cache.get(), {}).model, catalog.defaultModel);
  assert.equal(cache.calls, 1);
  const saved = fs.readFileSync(cache.file, 'utf8');
  assert.doesNotMatch(saved, /test-private-credential|test-backend-token|test-model-secret|12345/);
  assert.equal(fs.statSync(cache.file).mode & 0o777, 0o600);
  cache.time++;
  cache.get();
  assert.equal(cache.calls, 2);
});

test('manual refresh replaces an unexpired catalog and preserves it if the query fails', (t) => {
  const cache = cacheFixture(t);
  cache.get();
  cache.time++;
  const updated = { ...catalog, defaultModel: 'claude-sonnet-5[1m]' };
  cache.read = () => updated;
  assert.deepEqual(cache.get(), catalog);
  assert.equal(cache.calls, 1);
  assert.deepEqual(cache.get({}, true), updated);
  assert.equal(cache.calls, 2);
  assert.deepEqual(cache.get(), updated);
  assert.equal(cache.calls, 2);
  cache.read = () => { throw new Error('catalog unavailable'); };
  assert.throws(() => cache.get({}, true), /catalog unavailable/);
  assert.deepEqual(cache.get(), updated);
  assert.equal(cache.calls, 3);
});

test('refreshes when the active version, configuration, or model environment changes', (t) => {
  const cache = cacheFixture(t);
  cache.get();
  fs.writeFileSync(cache.settings, fs.readFileSync(cache.settings));
  cache.get();
  assert.equal(cache.calls, 1);
  fs.writeFileSync(cache.settings, JSON.stringify({ claudeModel: 'claude-sonnet-5[1m]' }));
  cache.read = () => ({ ...catalog, defaultModel: 'claude-sonnet-5[1m]' });
  assert.equal(cache.get().defaultModel, 'claude-sonnet-5[1m]');
  assert.equal(cache.calls, 2);
  cache.mirasim = { version: '0.0.296', entry: '/mirasim/0.0.296/server.cjs' };
  cache.get();
  assert.equal(cache.calls, 3);
  cache.get({ CLAUDE_MODEL: 'claude-opus-5[1m]' });
  assert.equal(cache.calls, 4);
  cache.get({ CLAUDE_MODEL: 'claude-opus-5[1m]', CLAUDE_REASONING_EFFORT: 'low' });
  assert.equal(cache.calls, 5);
});

test('refreshes corrupt, invalid, and future-dated caches and rejects failed refreshes', (t) => {
  const cache = cacheFixture(t);
  cache.get();
  fs.writeFileSync(cache.file, '{broken');
  assert.deepEqual(cache.get(), catalog);
  const saved = JSON.parse(fs.readFileSync(cache.file, 'utf8'));
  fs.writeFileSync(cache.file, JSON.stringify({ ...saved, catalog: { ...catalog, models: [] } }));
  assert.deepEqual(cache.get(), catalog);
  cache.time--;
  cache.get();
  assert.equal(cache.calls, 4);
  cache.time += 7 * 24 * 60 * 60 * 1000;
  cache.read = () => { throw new Error('catalog unavailable'); };
  assert.throws(() => cache.get(), /catalog unavailable/);
  cache.read = () => ({ ...catalog, models: [] });
  assert.throws(() => cache.get(), /目录无效/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache.file, 'utf8')).catalog, catalog);
});

test('can launch with a fresh catalog when cache storage is unavailable', (t) => {
  const cache = cacheFixture(t);
  fs.writeFileSync(path.dirname(cache.file), 'not a directory');
  assert.deepEqual(cache.get(), catalog);
  assert.deepEqual(cache.get(), catalog);
  assert.equal(cache.calls, 2);
});

test('does not cache a query spanning a configuration change or an unreadable configuration', (t) => {
  const cache = cacheFixture(t);
  cache.read = () => {
    fs.writeFileSync(cache.settings, '{}');
    return catalog;
  };
  assert.deepEqual(cache.get(), catalog);
  assert.equal(fs.existsSync(cache.file), false);
  cache.get();
  assert.equal(fs.existsSync(cache.file), true);
  fs.rmSync(cache.settings);
  cache.read = () => catalog;
  assert.deepEqual(cache.get(), catalog);
  assert.equal(cache.calls, 3);
});

test('follows the confirmed payload rather than a newer directory', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mclaude-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.mirasim/app');
  for (const version of ['0.0.295', '0.0.296']) {
    const directory = path.join(root, version);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'payload.json'), JSON.stringify({ server: 'entry.cjs' }));
    fs.writeFileSync(path.join(directory, 'entry.cjs'), '');
  }
  const setVersion = (good) => fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ good }));
  setVersion('0.0.295');
  assert.equal(findMirasim(home).entry, path.join(root, '0.0.295/entry.cjs'));
  setVersion('0.0.296');
  assert.equal(findMirasim(home).version, '0.0.296');
});

test('overrides model roles without copying unrelated settings or credentials', () => {
  const result = buildSettings(catalog, {});
  assert.equal(result.settings.env.ANTHROPIC_MODEL, catalog.defaultModel);
  assert.equal(result.settings.env.CLAUDE_CODE_EFFORT_LEVEL, '');
  assert.equal(result.settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  assert.equal(result.settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, catalog.defaultModel);
  assert.equal(result.roles.fable, 'claude-fable-5-1[1m]');
  assert.equal(result.settings.env.CLAUDE_CODE_SUBAGENT_MODEL, catalog.defaultModel);
  assert.deepEqual(result.fallbacks, ['haiku']);
  assert.deepEqual(Object.keys(result.settings), ['env']);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in result.settings.env, false);
  assert.equal('ANTHROPIC_BASE_URL' in result.settings.env, false);
});

test('passes startup effort while clearing environment overrides in both launch sources', () => {
  const source = fs.readFileSync(path.join(__dirname, 'mclaude.cjs'), 'utf8');
  const entry = '/mirasim/server.cjs';
  for (const inherited of [undefined, 'high', 'max']) {
    for (const effort of [undefined, 'low', 'max']) {
      let captured;
      const child = new EventEmitter();
      const parent = Object.assign(new EventEmitter(), {
        execPath: process.execPath,
        env: inherited === undefined ? {} : { CLAUDE_CODE_EFFORT_LEVEL: inherited }
      });
      const context = vm.createContext({
        module: { exports: {} }, __dirname, process: parent, console,
        entry, catalog, options: effort ? { effort } : {},
        require: (name) => name === 'node:child_process' ? {
          spawn: (command, args, options) => {
            captured = { command, args, options };
            return child;
          }
        } : require(name)
      });
      vm.runInContext(source, context, { filename: 'mclaude.cjs' });
      vm.runInContext('launch(entry, buildSettings(catalog, options), []);', context);
      child.emit('exit', 0, null);

      assert.equal(captured.command, process.execPath);
      assert.deepEqual(Array.from(captured.args.slice(0, 6)), [
        entry, 'claude', '--model', catalog.defaultModel,
        '--effort', effort || catalog.defaultEffort
      ]);
      assert.equal(captured.args[6], '--settings');
      const settings = JSON.parse(captured.args[7]);
      assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, '');
      assert.equal(captured.options.env.CLAUDE_CODE_EFFORT_LEVEL, '');
    }
  }
});

test('explicit model and effort win, while resume and literal prompt arguments survive', () => {
  const options = parseArgs([
    '--refresh', '--dry-run', '--model=claude-opus-4-8', '--effort', 'ultra',
    '--resume', 'session-id', '--', '--model', '--refresh', 'literal prompt'
  ]);
  const result = buildSettings(catalog, options);
  assert.equal(result.model, 'claude-opus-4-8[1m]');
  assert.equal(result.roles.opus, 'claude-opus-4-8[1m]');
  assert.equal(result.effort, 'max');
  assert.equal(options.dryRun, true);
  assert.equal(options.refresh, true);
  assert.equal(parseArgs(['--', '--refresh']).refresh, false);
  assert.deepEqual(options.args, ['--resume', 'session-id', '--', '--model', '--refresh', 'literal prompt']);
  assert.equal(buildSettings(catalog, { model: 'sonnet' }).model, 'claude-sonnet-5[1m]');
});

test('uses the catalog model ID for the main model, subagents, and fallback roles', () => {
  for (const model of ['claude-opus-5', 'claude-opus-5[1M]']) {
    const result = buildSettings(catalog, { model });
    assert.equal(result.model, 'claude-opus-5[1m]');
    assert.equal(result.settings.env.ANTHROPIC_MODEL, result.model);
    assert.equal(result.settings.env.CLAUDE_CODE_SUBAGENT_MODEL, result.model);
    assert.equal(result.roles.opus, result.model);
    assert.equal(result.roles.haiku, result.model);
    assert.equal(result.settings.env.ANTHROPIC_SMALL_FAST_MODEL, result.model);
  }
  const noSuffix = { ...catalog, models: [{ id: 'claude-opus-5', label: 'opus 5' }] };
  assert.equal(buildSettings(noSuffix, {}).model, 'claude-opus-5');
});

test('prefers an exact catalog variant and its label regardless of catalog order', () => {
  const variants = [
    { id: 'claude-opus-5[1m]', label: 'opus 5 extended' },
    { id: 'claude-opus-5', label: 'opus 5 standard' }
  ];
  for (const models of [variants, [...variants].reverse()]) {
    const both = { ...catalog, models };
    for (const variant of variants) {
      const result = buildSettings(both, { model: variant.id });
      assert.equal(result.model, variant.id);
      assert.equal(result.roles.opus, variant.id);
      assert.equal(result.settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, variant.label);
    }
    assert.equal(buildSettings(both, { model: 'opus' }).model, catalog.defaultModel);
    assert.equal(buildSettings(both, { model: 'default' }).model, catalog.defaultModel);
  }
});

test('automatic family selection prefers the extended variant only when versions tie', () => {
  const variants = [
    { id: 'claude-opus-5', label: 'opus 5 standard' },
    { id: 'claude-opus-5[1m]', label: 'opus 5 extended' }
  ];
  for (const ordered of [variants, [...variants].reverse()]) {
    const mixed = {
      ...catalog,
      defaultModel: 'claude-sonnet-5[1m]',
      models: [...ordered, ...catalog.models.filter((item) => !item.id.startsWith('claude-opus-5'))]
    };
    const result = buildSettings(mixed, {});
    assert.equal(result.model, 'claude-sonnet-5[1m]');
    assert.equal(result.roles.opus, 'claude-opus-5[1m]');
    assert.equal(result.settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, 'opus 5 extended');
    assert.equal(buildSettings(mixed, { model: 'opus' }).model, 'claude-opus-5[1m]');

    const newer = { ...mixed, models: [...mixed.models, { id: 'claude-opus-6' }] };
    assert.equal(buildSettings(newer, {}).roles.opus, 'claude-opus-6');
    assert.equal(buildSettings(newer, { model: 'opus' }).model, 'claude-opus-6');
  }
});

test('adopts new family models from the catalog and rejects invalid inputs', () => {
  const updated = {
    ...catalog,
    models: [...catalog.models,
      { id: 'claude-haiku-4-5', label: 'haiku 4.5' },
      { id: 'claude-sonnet-6', label: 'sonnet 6' }
    ]
  };
  const result = buildSettings(updated, {});
  assert.equal(result.roles.haiku, 'claude-haiku-4-5');
  assert.equal(result.roles.sonnet, 'claude-sonnet-6');
  assert.deepEqual(result.fallbacks, []);
  assert.throws(() => parseArgs(['--model']), /需要一个值/);
  assert.throws(() => buildSettings(catalog, { model: 'unavailable-model' }), /不在 Mirasim 目录/);
  assert.throws(() => buildSettings(catalog, { effort: 'unavailable-effort' }), /不支持的推理强度/);
  assert.throws(() => buildSettings({ agent: 'claude', models: [] }, {}), /目录无效/);
});
