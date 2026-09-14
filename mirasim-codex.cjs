'use strict';

const fs = require('node:fs');
const Module = require('node:module');

function proxyArgs(baseURL) {
  // Codex appends /responses; Mirasim's cloud endpoint is /v1/responses.
  const provider = 'name="Mirasim",base_url=' + JSON.stringify(baseURL.replace(/\/+$/, '') + '/v1') +
    ',wire_api="responses",env_key="MCODEX_API_KEY",requires_openai_auth=false';
  return ['-c', 'model_providers.mirasim={' + provider + '}', '-c', 'model_provider="mirasim"'];
}

function mergeArgs(args, extraArgs) {
  const separator = args.indexOf('--');
  const index = separator < 0 ? args.length : separator;
  return [...args.slice(0, index), ...extraArgs, ...args.slice(index)];
}

function adaptBundle(source) {
  const marker = "'codex':{'id':'codex',";
  const start = source.indexOf(marker);
  const end = source.indexOf(",'dsh':", start);
  if (start < 0 || start !== source.lastIndexOf(marker) || end < 0) {
    throw new Error('Mirasim 的 Codex 启动配置结构已变化，需要更新 mcodex 适配。');
  }
  const descriptor = source.slice(start, end);
  if (!descriptor.includes("'binEnv':'MIRASIM_CODEX_BIN'") ||
      !descriptor.includes("'capture':'mitm'") ||
      /'(?:upstreamBaseURL|baseUrlEnv|baseUrlArgs|authTokenEnv|relayPrimary|keySources)'\s*:/.test(descriptor)) {
    throw new Error('Mirasim 的 Codex 启动配置已变化，需要重新验证 mcodex 适配。');
  }

  // Use the terminal runner's authenticated redirect proxy for this process.
  const fields = "'upstreamBaseURL':'https://relay.mirasim.ai'," +
    "'authTokenEnv':'MCODEX_API_KEY','relayPrimary':true,'baseUrlArgs':" + proxyArgs.toString() + ',';
  const adapted = descriptor.replace(marker, marker + fields).replace("'capture':'mitm'", "'capture':'redirect'");
  source = source.slice(0, start) + adapted + source.slice(end);

  const relay = /('codex':\{'agent':'codex','baseURL':[^,{}]+,'authScheme':[^,{}]+,'quotaFailover':)[^,{}]+(\})/g;
  // Keep the cloud-only decision after credential renewal or Desktop route changes.
  const routing = /('failoverAgent':[\w$]+\['agent'\],)('relayCredentialless':\(\)=>[\w$]+,)/g;
  // Provider options must precede Codex's literal prompt separator.
  const argv = /\[\.\.\.this\['baseArgs'\],\.\.\.([\w$]+\['extraArgs'\])\?\?\[\]\]/g;
  if ([...source.matchAll(relay)].length !== 1 || [...source.matchAll(routing)].length !== 1 ||
      [...source.matchAll(argv)].length !== 1) {
    throw new Error('Mirasim 的 Codex 云路由结构已变化，需要更新 mcodex 适配。');
  }
  return source.replace(relay, '$1true$2')
    .replace(routing, "$1'relayCloudOnly':()=>true,$2")
    .replace(argv, (_match, extraArgs) => `(${mergeArgs.toString()})(this['baseArgs'],${extraArgs}??[])`);
}

function run(entry, args) {
  const source = adaptBundle(fs.readFileSync(entry, 'utf8'));
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = (module, filename) => {
    if (filename !== entry) return original(module, filename);
    Module._extensions['.js'] = original;
    module._compile(source, filename);
  };
  process.argv = [process.execPath, entry, 'codex', ...args];
  Module._load(entry, null, true);
}

if (require.main === module) {
  try { run(process.argv[2], process.argv.slice(3)); }
  catch (error) {
    console.error(`mcodex: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { adaptBundle, proxyArgs };
