'use strict';

const fs = require('node:fs');
const Module = require('node:module');

function adaptBundle(source) {
  const marker = "'kimi':{'id':'kimi',";
  const start = source.indexOf(marker);
  const end = source.indexOf(",'gemini':", start);
  if (start < 0 || start !== source.lastIndexOf(marker) || end < 0) {
    throw new Error('Mirasim 的 Kimi 启动配置结构已变化，需要更新 mkimi 适配。');
  }
  const descriptor = source.slice(start, end);
  if (!descriptor.includes("'binEnv':'MIRASIM_KIMI_BIN'") ||
      /'(?:upstreamBaseURL|baseUrlEnv|authTokenEnv|relayPrimary)'\s*:/.test(descriptor)) {
    throw new Error('Mirasim 的 Kimi 启动配置已变化，需要重新验证 mkimi 适配。');
  }

  // The terminal runner needs these fields to create and authenticate its local proxy.
  const fields = "'upstreamBaseURL':'https://relay.mirasim.ai'," +
    "'baseUrlEnv':'KIMI_MODEL_BASE_URL','authTokenEnv':'KIMI_MODEL_API_KEY'," +
    "'proxyPathPrefix':'','relayPrimary':true,";
  source = source.replace(marker, marker + fields);

  // Keep the signed cloud route available even when a native Kimi login exists.
  const relay = /('kimi':\{'agent':'kimi','baseURL':[^,]+,'authScheme':[^,]+,'quotaFailover':)([^,]+)(,'pathPrefix':'\/v1'\})/g;
  if ([...source.matchAll(relay)].length !== 1) {
    throw new Error('Mirasim 的 Kimi 云路由结构已变化，需要更新 mkimi 适配。');
  }
  return source.replace(relay, '$1true$3');
}

function run(entry, args) {
  const source = adaptBundle(fs.readFileSync(entry, 'utf8'));
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = (module, filename) => {
    if (filename !== entry) return original(module, filename);
    Module._extensions['.js'] = original;
    module._compile(source, filename);
  };
  process.argv = [process.execPath, entry, 'kimi', ...args];
  Module._load(entry, null, true);
}

if (require.main === module) {
  try {
    run(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error(`mkimi: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { adaptBundle };
