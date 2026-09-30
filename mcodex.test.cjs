'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { parseArgs, readCatalog, readLauncherConfig, buildConfig, readReviewCatalog } = require('./mcodex.cjs');
const { adaptBundle, proxyArgs } = require('./mirasim-codex.cjs');

const catalog = {
  agent: 'codex', models: [
    { id: 'gpt-5.6-sol', contextWindow: 872000 },
    { id: 'gpt-6-astra', contextWindow: 872000 }
  ], defaultModel: 'gpt-5.6-sol', defaultEffort: 'xhigh',
  effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id }))
};

const reviewModels = ['deepseek-flash', 'kimi-k3', 'glm-5.3-flash'];
const reviewCatalog = {
  ...catalog,
  models: [...catalog.models, ...reviewModels.map(id => ({ id, contextWindow: 1000000 }))],
  effortByModel: Object.fromEntries(reviewModels.map(id => [id,
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({
      id, unavailable: ['medium', 'xhigh', 'ultra'].includes(id)
    }))
  ]))
};

const nativeCatalog = {
  version: 'test-version',
  models: [
    {
      slug: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol', context_window: 872000, visibility: 'list',
      default_reasoning_level: 'medium', use_responses_lite: true,
      supports_parallel_tool_calls: true, base_instructions: 'Main model instructions',
      additional_speed_tiers: ['fast'], service_tiers: ['priority'],
      supported_reasoning_levels: [{ effort: 'ultra', description: 'Ultra reasoning' }]
    },
    { slug: 'gpt-6-astra', context_window: 872000, base_instructions: 'Astra instructions' },
    {
      slug: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 128000,
      max_context_window: 128000, use_responses_lite: true, support_verbosity: true,
      default_reasoning_level: 'medium', base_instructions: 'Approval review instructions',
      additional_speed_tiers: ['fast'], service_tiers: ['priority'],
      supported_reasoning_levels: [{ effort: 'medium', description: 'Medium reasoning' }]
    }
  ]
};

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcodex-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('reads the launcher review model and disables it for missing or blank configuration', t => {
  const file = path.join(makeTempDirectory(t), 'mcodex.config.json');
  assert.deepEqual(readLauncherConfig(file), {});
  for (const input of [{}, { autoReviewModel: '' }, { autoReviewModel: ' \n\t ' }]) {
    fs.writeFileSync(file, JSON.stringify(input));
    const options = readLauncherConfig(file);
    assert.equal(options.autoReviewModel, '');
    assert.equal(buildConfig(reviewCatalog, options, {}).autoReview, undefined);
  }
  fs.writeFileSync(file, JSON.stringify({ autoReviewModel: '  deepseek-flash \n' }));
  assert.deepEqual(readLauncherConfig(file), { autoReviewModel: 'deepseek-flash' });
});

test('rejects malformed configuration without exposing file contents', t => {
  const file = path.join(makeTempDirectory(t), 'mcodex.config.json');
  fs.writeFileSync(file, '{private-configuration');
  assert.throws(() => readLauncherConfig(file), error =>
    /JSON 格式/.test(error.message) && !error.message.includes('private-configuration'));
  for (const input of [null, [], 'deepseek-flash', { autoReviewModel: null },
    { autoReviewModel: 123 }, { autoReviewModel: true }, { autoReviewModel: [] }]) {
    fs.writeFileSync(file, JSON.stringify(input));
    assert.throws(() => readLauncherConfig(file), /必须是模型 ID 字符串/);
  }
});

test('resolves launcher configuration from its installation directory independently of cwd', () => {
  const source = fs.readFileSync(path.join(__dirname, 'mcodex.cjs'), 'utf8');
  let captured;
  const context = vm.createContext({
    module: { exports: {} }, __dirname: '/installed/mclaude',
    process: { cwd: () => '/different/project' },
    require: name => name === 'node:fs' ? {
      readFileSync: file => { captured = file; return '{"autoReviewModel":"deepseek-flash"}'; }
    } : require(name)
  });
  vm.runInContext(source, context);
  assert.equal(context.readLauncherConfig().autoReviewModel, 'deepseek-flash');
  assert.equal(captured, '/installed/mclaude/mcodex.config.json');
});

test('selects supported Mirasim review models with low effort and filters unavailable levels', () => {
  for (const model of reviewModels) {
    const config = buildConfig(reviewCatalog, { autoReviewModel: model }, {});
    assert.equal(config.model, catalog.defaultModel);
    assert.equal(config.effort, 'xhigh');
    assert.deepEqual(config.autoReview, {
      model, effort: 'low', efforts: ['low', 'high', 'max'], contextWindow: 1000000
    });
  }
  const { effortByModel, ...sharedEfforts } = reviewCatalog;
  assert.deepEqual(buildConfig(sharedEfforts, { autoReviewModel: 'deepseek-flash' }, {}).autoReview.efforts,
    catalog.effort.map(item => item.id));
});

test('rejects unknown review models, invalid context lengths and unavailable low effort', () => {
  for (const model of ['missing', 'v4.1-flash', 'k3', 'codex-auto-review']) {
    assert.throws(() => buildConfig(reviewCatalog, { autoReviewModel: model }, {}), /审核模型.*不在 Mirasim 可用目录/);
  }
  const options = { autoReviewModel: 'deepseek-flash' };
  for (const levels of [[], [{ id: 'high' }], [{ id: 'low', unavailable: true }], {}]) {
    assert.throws(() => buildConfig({
      ...reviewCatalog, effortByModel: { 'deepseek-flash': levels }
    }, options, {}), /未提供 low/);
  }
  for (const contextWindow of [undefined, 0, -1, 1.5, '1000000']) {
    assert.throws(() => buildConfig({ ...reviewCatalog, models: reviewCatalog.models.map(item =>
      item.id === options.autoReviewModel ? { ...item, contextWindow } : item)
    }, options, {}), /审核模型上下文长度无效/);
  }
});

test('maps all native review slots while preserving main model metadata and ordinary Responses for domestic models', () => {
  const before = JSON.stringify(nativeCatalog);
  for (const model of reviewModels) {
    const config = buildConfig(reviewCatalog, { autoReviewModel: model }, { MIRASIM_CODEX_BIN: '/custom/codex' });
    const rewritten = readReviewCatalog(config, (command, args, options) => {
      assert.equal(command, '/custom/codex');
      assert.deepEqual(args, ['debug', 'models', '--bundled']);
      assert.deepEqual(options.env, config.env);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      return JSON.stringify(nativeCatalog);
    });
    assert.equal(rewritten.version, nativeCatalog.version);
    assert.equal(rewritten.models.length, nativeCatalog.models.length + 1);
    for (const original of nativeCatalog.models) {
      assert.deepEqual(rewritten.models.find(item => item.slug === original.slug), {
        ...original, auto_review_model_override: model
      });
    }
    const reviewer = rewritten.models.find(item => item.slug === model);
    assert.equal(reviewer.display_name, model);
    assert.equal(reviewer.context_window, 1000000);
    assert.equal(reviewer.max_context_window, 1000000);
    assert.equal(reviewer.default_reasoning_level, 'low');
    assert.deepEqual(reviewer.supported_reasoning_levels.map(item => item.effort), ['low', 'high', 'max']);
    assert.equal(reviewer.base_instructions, 'Approval review instructions');
    assert.equal(reviewer.use_responses_lite, false);
    assert.equal(reviewer.support_verbosity, false);
    assert.deepEqual(reviewer.additional_speed_tiers, []);
    assert.deepEqual(reviewer.service_tiers, []);
    assert.ok(rewritten.models.every(item => item.auto_review_model_override === model));
  }
  assert.equal(JSON.stringify(nativeCatalog), before);
});

test('keeps existing native review model capabilities without duplicating its catalog entry', () => {
  const config = buildConfig(reviewCatalog, { autoReviewModel: 'gpt-5.6-sol' }, {});
  const rewritten = readReviewCatalog(config, command => {
    assert.equal(command, 'codex');
    return JSON.stringify(nativeCatalog);
  });
  assert.equal(rewritten.models.length, nativeCatalog.models.length);
  const reviewer = rewritten.models.find(item => item.slug === config.autoReview.model);
  assert.equal(reviewer.use_responses_lite, true);
  assert.equal(reviewer.base_instructions, 'Main model instructions');
  assert.equal(reviewer.supports_parallel_tool_calls, true);
  assert.deepEqual(reviewer.service_tiers, ['priority']);
});

test('retains normal main model instructions for Mirasim models absent from the bundled catalog', () => {
  for (const model of ['kimi-k3', 'deepseek-flash']) {
    const config = buildConfig(reviewCatalog, { model, effort: 'high', autoReviewModel: 'deepseek-flash' }, {});
    const rewritten = readReviewCatalog(config, () => JSON.stringify(nativeCatalog));
    const main = rewritten.models.find(item => item.slug === model);
    assert.equal(rewritten.models.filter(item => item.slug === model).length, 1);
    assert.equal(main.base_instructions, 'Main model instructions');
    assert.equal(main.supports_parallel_tool_calls, true);
    assert.equal(main.display_name, model);
    assert.equal(main.context_window, 1000000);
    assert.equal(main.max_context_window, 1000000);
    assert.equal(main.auto_review_model_override, 'deepseek-flash');
  }
});

test('reports native catalog failures without exposing subprocess output', () => {
  const config = buildConfig(reviewCatalog, { autoReviewModel: 'deepseek-flash' }, {});
  for (const run of [
    () => { throw Object.assign(new Error('private-token'), { stdout: 'private-output', stderr: 'private-error' }); },
    () => 'private-output is not JSON'
  ]) {
    assert.throws(() => readReviewCatalog(config, run), error =>
      /无法读取 Codex 内置模型目录/.test(error.message) && !error.message.includes('private-'));
  }
  for (const input of [{}, { models: {} }, { models: [null] }, { models: [{ slug: 42 }] }]) {
    assert.throws(() => readReviewCatalog(config, () => JSON.stringify(input)), /内置模型目录无效/);
  }
  assert.throws(() => readReviewCatalog(config, () => JSON.stringify({
    models: nativeCatalog.models.filter(item => item.slug !== 'codex-auto-review')
  })), /内置目录缺少/);
});

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

const modernFixture = fixture.replace("'quotaFailover':false", "'carriesOrdinaryTraffic':!(0x1931*-0x1+0x53*-0x37+0x89b*0x5)")
  .replace("const options={agent:'codex'};", `
const options={agent:'codex',accountToken:nativeToken};
const credentialless=!options['accountToken']&&!!config['relayToken']&&feature()&&!!lookup(options['agent'])&&!native(settings(),options['agent']);
const useRelay=(cloud.codex.carriesOrdinaryTraffic||credentialless)&&config.relayToken&&(config.enabled||credentialless);
`)
  .replace('result={agent:', 'result={useRelay,agent:');

test('adapts the current cloud policy and enables managed auth even with a native account', () => {
  for (const enabled of [false, true]) {
    for (const nativeToken of [null, 'native-token']) {
      const context = { origin: () => 'https://relay.mirasim.ai', auth: { scheme: 'bearer' },
        config: { enabled, relayToken: 'cloud-token' }, nativeToken,
        feature: () => true, lookup: () => ({}),
        native: () => { throw new Error('native credentials must not be consulted'); } };
      vm.runInNewContext(adaptBundle(modernFixture), context);
      assert.equal(context.result.cloud.carriesOrdinaryTraffic, true);
      assert.equal(context.result.useRelay, true);
      assert.equal(context.result.agent.authTokenEnv, 'MCODEX_API_KEY');
      assert.equal(context.result.interceptor.relayCredentialless(), true);
      assert.equal(context.result.interceptor.relayCloudOnly(), true);
      context.config.enabled = !enabled;
      assert.equal(context.result.interceptor.relayCloudOnly(), true);
    }
  }
});

test('current runner stops before launch when cloud login or capability is missing', () => {
  for (const missing of ['token', 'feature', 'agent']) {
    const context = { origin: () => 'https://relay.mirasim.ai', auth: { scheme: 'bearer' },
      config: { enabled: true, relayToken: missing === 'token' ? '' : 'cloud-token' },
      nativeToken: 'native-token', feature: () => missing !== 'feature',
      lookup: () => missing === 'agent' ? null : {} };
    assert.throws(() => vm.runInNewContext(adaptBundle(modernFixture), context), /需要可用的 Mirasim 云端登录/);
    assert.equal(context.result, undefined);
  }
  for (const source of [modernFixture + modernFixture, adaptBundle(modernFixture),
    modernFixture.replace("'accountToken'", "'newAccountField'"),
    modernFixture.replace("'carriesOrdinaryTraffic'", "'newPolicyField'")]) {
    assert.throws(() => adaptBundle(source), /结构已变化|配置已变化/);
  }
});

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

function createLaunchHarness(t, spawnOverride) {
  const directory = makeTempDirectory(t);
  const child = new EventEmitter();
  const childSignals = [];
  child.kill = signal => childSignals.push(signal);
  const parentSignals = [];
  const parent = Object.assign(new EventEmitter(), {
    execPath: process.execPath, env: {}, exitCode: 0, pid: 12345,
    kill: (pid, signal) => parentSignals.push({ pid, signal })
  });
  const errors = [];
  const harness = { directory, child, parent, errors, childSignals, parentSignals };
  const context = vm.createContext({
    module: { exports: {} }, __dirname, process: parent,
    console: { error: message => errors.push(message) },
    require: name => name === 'node:child_process' ? {
      spawn: (command, args, options) => {
        harness.captured = { command, args: Array.from(args), options };
        return spawnOverride ? spawnOverride() : child;
      }
    } : name === 'node:os' ? { ...os, tmpdir: () => directory } : require(name)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'mcodex.cjs'), 'utf8'), context);
  harness.launch = config => context.launch('/mirasim/server.cjs', config, ['resume', '--last']);
  return harness;
}

function reviewLaunchConfig() {
  const config = buildConfig(reviewCatalog, { autoReviewModel: 'deepseek-flash' }, { CODEX_HOME: '/my-codex' });
  config.reviewCatalog = readReviewCatalog(config, () => JSON.stringify(nativeCatalog));
  return config;
}

test('launches with a temporary review catalog and removes it after a normal exit', t => {
  const harness = createLaunchHarness(t);
  const config = reviewLaunchConfig();
  harness.launch(config);
  const { captured, parent, child } = harness;
  const catalogOption = captured.args.find(arg => arg.startsWith('model_catalog_json='));
  const file = JSON.parse(catalogOption.slice('model_catalog_json='.length));
  assert.equal(path.dirname(path.dirname(file)), harness.directory);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), config.reviewCatalog);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(captured.args, [
    path.join(__dirname, 'mirasim-codex.cjs'), '/mirasim/server.cjs',
    '-c', 'model="gpt-5.6-sol"', '-c', 'model_reasoning_effort="xhigh"',
    '-c', 'model_context_window=872000', '-c', catalogOption,
    '-c', 'approvals_reviewer="auto_review"', 'resume', '--last'
  ]);
  assert.equal(captured.options.env, config.env);
  assert.equal(parent.listenerCount('SIGINT'), 1);
  assert.equal(parent.listenerCount('SIGTERM'), 1);
  child.emit('exit', 7, null);
  assert.equal(parent.exitCode, 7);
  assert.equal(parent.listenerCount('SIGINT'), 0);
  assert.equal(parent.listenerCount('SIGTERM'), 0);
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.deepEqual(fs.readdirSync(harness.directory), []);
});

test('cleans temporary review files when spawn throws or the child emits an error', t => {
  const spawnError = new Error('spawn failed');
  const failedSpawn = createLaunchHarness(t, () => { throw spawnError; });
  assert.throws(() => failedSpawn.launch(reviewLaunchConfig()), error => error === spawnError);
  assert.deepEqual(fs.readdirSync(failedSpawn.directory), []);
  assert.equal(failedSpawn.parent.listenerCount('SIGINT'), 0);
  assert.equal(failedSpawn.parent.listenerCount('SIGTERM'), 0);

  const failedChild = createLaunchHarness(t);
  failedChild.launch(reviewLaunchConfig());
  assert.equal(fs.readdirSync(failedChild.directory).length, 1);
  failedChild.child.emit('error', new Error('child failed'));
  assert.equal(failedChild.parent.exitCode, 1);
  assert.deepEqual(failedChild.errors, ['mcodex: child failed']);
  assert.deepEqual(fs.readdirSync(failedChild.directory), []);
  assert.equal(failedChild.parent.listenerCount('SIGINT'), 0);
  assert.equal(failedChild.parent.listenerCount('SIGTERM'), 0);
});

test('cleans temporary review files before propagating a child termination signal', t => {
  const harness = createLaunchHarness(t);
  harness.launch(reviewLaunchConfig());
  harness.parent.emit('SIGTERM');
  assert.deepEqual(harness.childSignals, ['SIGTERM']);
  harness.child.emit('exit', null, 'SIGTERM');
  assert.deepEqual(fs.readdirSync(harness.directory), []);
  assert.deepEqual(harness.parentSignals, [{ pid: 12345, signal: 'SIGTERM' }]);
  assert.equal(harness.parent.listenerCount('SIGTERM'), 0);
});

test('keeps inherited approval configuration and creates no review files when the slot is empty', t => {
  const harness = createLaunchHarness(t);
  const config = buildConfig(reviewCatalog, { autoReviewModel: '' }, { CODEX_HOME: '/my-codex' });
  harness.launch(config);
  assert.deepEqual(harness.captured.args, [
    path.join(__dirname, 'mirasim-codex.cjs'), '/mirasim/server.cjs',
    '-c', 'model="gpt-5.6-sol"', '-c', 'model_reasoning_effort="xhigh"',
    '-c', 'model_context_window=872000', 'resume', '--last'
  ]);
  assert.equal(harness.captured.options.env.CODEX_HOME, '/my-codex');
  assert.deepEqual(fs.readdirSync(harness.directory), []);
  harness.child.emit('exit', 0, null);
  assert.equal(harness.parent.exitCode, 0);
});
