'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseArgs, readCatalog, buildConfig } = require('./mkimi.cjs');
const { adaptBundle } = require('./mirasim-kimi.cjs');

const catalog = {
  agent: 'kimi', models: [{ id: 'kimi-code/k3', contextWindow: 1048576 }],
  defaultEffort: 'high'
};

test('keeps native prompt contents and continuation flags intact', () => {
  assert.deepEqual(parseArgs(['--effort=max', '-c', '-p', '--effort low']), {
    args: ['-c', '-p', '--effort low'], dryRun: false, effort: 'max'
  });
  assert.deepEqual(parseArgs(['--', '--help']).args, ['--help']);
  assert.throws(() => parseArgs(['--effort']), /low、high 或 max/);
  assert.throws(() => parseArgs(['--effort=medium']), /low、high 或 max/);
});

test('uses the catalog context and effort while discarding inherited model credentials', () => {
  const inherited = {
    KIMI_MODEL_NAME: 'other', KIMI_MODEL_API_KEY: 'private-key',
    KIMI_MODEL_BASE_URL: 'https://other.example', KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
    KIMI_MODEL_MAX_CONTEXT_SIZE: '10', KIMI_MODEL_THINKING_EFFORT: 'low',
    KIMI_MODEL_MAX_COMPLETION_TOKENS: '1048576',
    MIRASIM_UPSTREAM_BASE_URL: 'https://other.example', KIMI_CODE_HOME: '/my-kimi',
    PATH: '/usr/bin'
  };
  const config = buildConfig(catalog, {}, inherited);
  assert.equal(config.env.KIMI_MODEL_NAME, 'kimi-k3');
  assert.equal(config.env.KIMI_MODEL_MAX_CONTEXT_SIZE, '1048576');
  assert.equal(config.env.KIMI_MODEL_MAX_COMPLETION_TOKENS, '131072');
  assert.equal(config.maxCompletionTokens, 131072);
  assert.equal(config.env.KIMI_MODEL_THINKING_EFFORT, 'high');
  assert.equal(config.env.KIMI_MODEL_PROVIDER_TYPE, 'kimi');
  assert.equal(config.env.KIMI_CODE_HOME, '/my-kimi');
  assert.equal(config.env.PATH, '/usr/bin');
  for (const name of ['KIMI_MODEL_API_KEY', 'KIMI_MODEL_BASE_URL', 'MIRASIM_UPSTREAM_BASE_URL']) {
    assert.equal(name in config.env, false);
    assert.ok(name in inherited);
  }
  assert.equal(buildConfig(catalog, { effort: 'max' }, {}).effort, 'max');
  assert.equal(buildConfig({ ...catalog, defaultEffort: undefined }, {}, {}).effort, 'high');
});

test('fails when K3 is unavailable or its metadata is invalid', () => {
  for (const input of [null, {}, { ...catalog, agent: 'claude' }, { ...catalog, models: [] },
    { ...catalog, models: {} }, { ...catalog, models: [null] },
    { ...catalog, models: [{ id: 'kimi-code/k3', contextWindow: 0 }] }]) {
    assert.throws(() => buildConfig(input), /Kimi K3/);
  }
  assert.throws(() => buildConfig({ ...catalog, defaultEffort: 'unknown' }), /推理强度/);
});

test('queries a temporary backend if Desktop is unavailable, without exposing startup tokens', () => {
  const calls = [];
  const result = readCatalog('/mirasim/server.cjs', (_command, args, options) => {
    calls.push(args);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    if (calls.length === 1) throw new Error('private-token');
    return `backend token=private-token\n${JSON.stringify(catalog, null, 2)}\n`;
  });
  assert.deepEqual(calls, [
    ['/mirasim/server.cjs', 'ui-cli', '--port', '4970', 'catalog', '--agent', 'kimi'],
    ['/mirasim/server.cjs', 'ui-cli', 'catalog', '--agent', 'kimi']
  ]);
  assert.deepEqual(result, catalog);
  assert.throws(() => readCatalog('/mirasim/server.cjs', () => {
    throw new Error('private-token');
  }), (error) => /无法读取/.test(error.message) && !error.message.includes('private-token'));
});

const fixture = `
const agents={'kimi':{'id':'kimi','binEnv':'MIRASIM_KIMI_BIN'},'gemini':{'id':'gemini'}};
const cloud={'kimi':{'agent':'kimi','baseURL':origin(),'authScheme':auth.scheme,'quotaFailover':false,'pathPrefix':'/v1'}};
result={agent:agents.kimi,cloud:cloud.kimi};
`;

test('adapted metadata supplies a gated cloud proxy to the terminal runner', () => {
  const context = { origin: () => 'https://relay.mirasim.ai', auth: { scheme: 'bearer' } };
  vm.runInNewContext(adaptBundle(fixture), context);
  const { agent, cloud } = context.result;
  assert.equal(agent.upstreamBaseURL, 'https://relay.mirasim.ai');
  assert.equal(agent.baseUrlEnv, 'KIMI_MODEL_BASE_URL');
  assert.equal(agent.authTokenEnv, 'KIMI_MODEL_API_KEY');
  assert.equal(agent.relayPrimary, true);
  assert.equal(cloud.quotaFailover, true);
  assert.equal(cloud.pathPrefix, '/v1');
});

test('refuses changed or ambiguous Mirasim structures before loading them', () => {
  for (const input of [fixture + fixture, fixture.replace("'quotaFailover'", "'newQuotaField'"),
    fixture.replace("'binEnv':'MIRASIM_KIMI_BIN'", "'baseUrlEnv':'NATIVE_URL'"),
    adaptBundle(fixture)]) {
    assert.throws(() => adaptBundle(input), /结构已变化|配置已变化/);
  }
});
