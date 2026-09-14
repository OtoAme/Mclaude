'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { parseArgs, readCatalog, buildConfig } = require('./mcodex.cjs');
const { adaptBundle, proxyArgs } = require('./mirasim-codex.cjs');

const catalog = {
  agent: 'codex', models: [
    { id: 'gpt-5.6-sol', contextWindow: 872000 },
    { id: 'gpt-6-astra', contextWindow: 872000 }
  ], defaultModel: 'gpt-5.6-sol', defaultEffort: 'xhigh',
  effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id }))
};

test('parses Codex launcher options without consuming native subcommands or prompt text', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--model=gpt-6-astra', '--effort', 'ultra', 'resume', '--last']), {
    args: ['resume', '--last'], dryRun: true, model: 'gpt-6-astra', effort: 'ultra'
  });
  assert.deepEqual(parseArgs(['exec', 'explain --model and --effort']).args,
    ['exec', 'explain --model and --effort']);
  assert.deepEqual(parseArgs(['--', '--help']).args, ['--help']);
  for (const args of [['--model'], ['--effort='], ['--model', '--dry-run']]) {
    assert.throws(() => parseArgs(args), /需要一个值/);
  }
});

test('reads Codex catalog from Desktop and falls back to a temporary backend', () => {
  const calls = [];
  const run = (_command, args, options) => {
    calls.push(args);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    if (calls.length === 1) throw new Error('private-token');
    return `backend private-token\n${JSON.stringify(catalog, null, 2)}\n`;
  };
  assert.deepEqual(readCatalog('/mirasim/server.cjs', run), catalog);
  assert.deepEqual(calls, [
    ['/mirasim/server.cjs', 'ui-cli', '--port', '4970', 'catalog', '--agent', 'codex'],
    ['/mirasim/server.cjs', 'ui-cli', 'catalog', '--agent', 'codex']
  ]);
  let desktopCalls = 0;
  assert.deepEqual(readCatalog('/mirasim/server.cjs', () => {
    desktopCalls++;
    return JSON.stringify(catalog);
  }), catalog);
  assert.equal(desktopCalls, 1);
  assert.throws(() => readCatalog('/mirasim/server.cjs', () => {
    throw new Error('private-token');
  }), error => /无法读取/.test(error.message) && !error.message.includes('private-token'));
});

test('uses Mirasim GPT defaults and explicit selections with isolated cloud credentials', () => {
  const inherited = {
    OPENAI_API_KEY: 'private-key', CODEX_API_KEY: 'private-key',
    OPENAI_BASE_URL: 'https://other.example', MIRASIM_UPSTREAM_BASE_URL: 'https://other.example',
    MCODEX_API_KEY: 'stale-proxy-token', CODEX_HOME: '/my-codex', PATH: '/usr/bin'
  };
  assert.deepEqual(buildConfig(catalog, {}, inherited), {
    model: 'gpt-5.6-sol', effort: 'xhigh', contextWindow: 872000,
    env: { CODEX_HOME: '/my-codex', PATH: '/usr/bin' }
  });
  assert.equal(inherited.MCODEX_API_KEY, 'stale-proxy-token');
  const selected = buildConfig(catalog, { model: 'gpt-6-astra', effort: 'ultra' }, {});
  assert.equal(selected.model, 'gpt-6-astra');
  assert.equal(selected.effort, 'ultra');
  assert.equal(buildConfig(catalog, { model: 'default' }, {}).model, catalog.defaultModel);
  assert.equal(buildConfig({ ...catalog, defaultModel: 'gpt-6-astra' }, {}, {}).model, 'gpt-6-astra');
});

test('rejects unavailable GPT models, invalid catalogs and unsupported reasoning levels', () => {
  for (const input of [null, {}, { ...catalog, agent: 'kimi' }, { ...catalog, models: [] },
    { ...catalog, models: {} }, { ...catalog, models: [null] }]) {
    assert.throws(() => buildConfig(input), /模型目录无效/);
  }
  assert.throws(() => buildConfig(catalog, { model: 'missing' }), /不在 Mirasim 目录中/);
  for (const contextWindow of [undefined, 0, -1, 1.5, '872000']) {
    assert.throws(() => buildConfig({ ...catalog, models: [{ id: catalog.defaultModel, contextWindow }] }), /上下文长度/);
  }
  for (const input of [{ ...catalog, defaultEffort: 'unknown' }, { ...catalog, effort: {} },
    { ...catalog, effort: [{ id: 'high' }] }]) {
    assert.throws(() => buildConfig(input), /推理强度/);
  }
});

const fixture = `
const agents={'codex':{'id':'codex','bin':'codex','binEnv':'MIRASIM_CODEX_BIN','capture':'mitm',
'proxyEnv':['HTTPS_PROXY'],'caEnv':['CODEX_CA_CERTIFICATE'],'mitmHosts':['chatgpt.com','api.openai.com']},'dsh':{'id':'dsh'}};
const cloud={'codex':{'agent':'codex','baseURL':origin(),'authScheme':auth.scheme,'quotaFailover':false}};
const options={agent:'codex'};
const interceptor={'failoverAgent':options['agent'],'relayCredentialless':()=>credentialless,'directAuth':()=>nativeAuth};
const driver={baseArgs:[],argv(plan){return [...this['baseArgs'],...plan['extraArgs']??[]];}};
result={agent:agents.codex,other:agents.dsh,cloud:cloud.codex,interceptor,driver};
`;

test('adapts Codex to a managed cloud proxy independently of native login state', () => {
  for (const credentialless of [true, false]) {
    const context = { origin: () => 'https://relay.mirasim.ai', auth: { scheme: 'bearer' },
      credentialless, nativeAuth: { name: 'authorization', value: 'private-key' } };
    vm.runInNewContext(adaptBundle(fixture), context);
    const { agent, cloud, interceptor, other } = context.result;
    assert.equal(agent.capture, 'redirect');
    assert.equal(agent.upstreamBaseURL, 'https://relay.mirasim.ai');
    assert.equal(agent.authTokenEnv, 'MCODEX_API_KEY');
    assert.equal(agent.relayPrimary, true);
    assert.equal(cloud.quotaFailover, true);
    assert.equal(cloud.authScheme, 'bearer');
    assert.equal(interceptor.relayCloudOnly(), true);
    assert.equal(interceptor.relayCredentialless(), credentialless);
    assert.equal(interceptor.directAuth(), context.nativeAuth);
    assert.equal(other.id, 'dsh');
    const args = Array.from(agent.baseUrlArgs('http://127.0.0.1:1234'));
    assert.deepEqual(args, proxyArgs('http://127.0.0.1:1234'));
    assert.ok(args[1].includes('base_url="http://127.0.0.1:1234/v1"'));
    assert.ok(args[1].includes('env_key="MCODEX_API_KEY"'));
    assert.ok(args[1].includes('requires_openai_auth=false'));
    assert.equal(args[3], 'model_provider="mirasim"');
    assert.ok(!args.join(' ').includes('private-key'));
  }
});

test('routes Responses and compaction under v1 while preserving the proxy access path', () => {
  for (const suffix of ['', '/']) {
    const args = proxyArgs('http://127.0.0.1:1234/proxy-access-path' + suffix);
    const baseURL = JSON.parse(args[1].match(/base_url=("[^"]+")/)[1]);
    assert.equal(baseURL, 'http://127.0.0.1:1234/proxy-access-path/v1');
    assert.equal(new URL('responses', baseURL + '/').pathname, '/proxy-access-path/v1/responses');
    assert.equal(new URL('responses/compact', baseURL + '/').pathname, '/proxy-access-path/v1/responses/compact');
  }
});

test('refuses changed or ambiguous Codex bundle structures before loading', () => {
  for (const source of [fixture + fixture, adaptBundle(fixture),
    fixture.replace("'capture':'mitm'", "'capture':'other'"),
    fixture.replace("'binEnv':'MIRASIM_CODEX_BIN'", "'baseUrlEnv':'NATIVE_URL'"),
    fixture.replace("'quotaFailover'", "'newQuotaField'"),
    fixture.replace("'relayCredentialless'", "'newRoutingField'"),
    fixture.replace("'baseArgs'", "'newArgs'"),
    fixture.replace("'quotaFailover':false", "'quotaFailover':false,'newPolicy':true")]) {
    assert.throws(() => adaptBundle(source), /结构已变化|配置已变化/);
  }
});

test('keeps proxy options outside literal prompts when forwarding exec and resume', () => {
  const context = { origin: () => 'https://relay.mirasim.ai', auth: { scheme: 'bearer' } };
  vm.runInNewContext(adaptBundle(fixture), context);
  const { driver, agent } = context.result;
  const extraArgs = agent.baseUrlArgs('http://127.0.0.1:1234');
  for (const args of [['resume', '--last'], ['exec', 'explain --effort'], ['exec', '--', '--effort']]) {
    driver.baseArgs = args;
    const actual = Array.from(driver.argv({ extraArgs }));
    const separator = args.indexOf('--');
    assert.deepEqual(actual, separator < 0 ? [...args, ...extraArgs]
      : [...args.slice(0, separator), ...extraArgs, ...args.slice(separator)]);
  }
});

test('launches through the GPT adapter with native arguments, config and exit status intact', () => {
  const source = fs.readFileSync(path.join(__dirname, 'mcodex.cjs'), 'utf8');
  const child = new EventEmitter();
  const parent = Object.assign(new EventEmitter(), { execPath: process.execPath, env: {}, exitCode: 0 });
  let captured;
  const context = vm.createContext({
    module: { exports: {} }, __dirname, process: parent, console, catalog,
    require: name => name === 'node:child_process' ? {
      spawn: (command, args, options) => { captured = { command, args, options }; return child; }
    } : require(name)
  });
  vm.runInContext(source, context);
  vm.runInContext("launch('/mirasim/server.cjs', buildConfig(catalog, {}, {}), ['exec', 'explain --effort']);", context);
  assert.equal(captured.command, process.execPath);
  assert.deepEqual(Array.from(captured.args), [
    path.join(__dirname, 'mirasim-codex.cjs'), '/mirasim/server.cjs',
    '-c', 'model="gpt-5.6-sol"', '-c', 'model_reasoning_effort="xhigh"',
    '-c', 'model_context_window=872000', 'exec', 'explain --effort'
  ]);
  assert.equal(captured.options.stdio, 'inherit');
  child.emit('exit', 7, null);
  assert.equal(parent.exitCode, 7);
  assert.equal(parent.listenerCount('SIGINT'), 0);
  assert.equal(parent.listenerCount('SIGTERM'), 0);
});
