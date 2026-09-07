'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findMirasim, parseArgs, buildSettings } = require('./mclaude.cjs');

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
  assert.equal(result.settings.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.equal(result.settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  assert.equal(result.settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, catalog.defaultModel);
  assert.equal(result.roles.fable, 'claude-fable-5-1[1m]');
  assert.equal(result.settings.env.CLAUDE_CODE_SUBAGENT_MODEL, catalog.defaultModel);
  assert.deepEqual(result.fallbacks, ['haiku']);
  assert.deepEqual(Object.keys(result.settings), ['env']);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in result.settings.env, false);
  assert.equal('ANTHROPIC_BASE_URL' in result.settings.env, false);
});

test('explicit model and effort win, while resume and literal prompt arguments survive', () => {
  const options = parseArgs([
    '--dry-run', '--model=claude-opus-4-8', '--effort', 'ultra',
    '--resume', 'session-id', '--', '--model', 'literal prompt'
  ]);
  const result = buildSettings(catalog, options);
  assert.equal(result.model, 'claude-opus-4-8');
  assert.equal(result.roles.opus, 'claude-opus-4-8');
  assert.equal(result.effort, 'max');
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.args, ['--resume', 'session-id', '--', '--model', 'literal prompt']);
  assert.equal(buildSettings(catalog, { model: 'sonnet' }).model, 'claude-sonnet-5[1m]');
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
