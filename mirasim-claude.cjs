'use strict';

const fs = require('node:fs');
const Module = require('node:module');

function adaptBundle(source) {
  // The redirect runner uses this value to enable signed relay requests and
  // inject a managed proxy token even when a native Claude login exists.
  const credentials = /![\w$]+\['accountToken'\]&&!!([\w$]+)\['relayToken'\]&&([\w$]+)\(\)&&!!([\w$]+)\(([\w$]+)\['agent'\]\)&&![\w$]+\([\w$]+\(\),\4\['agent'\]\)/g;
  const routing = /('failoverAgent':[\w$]+\['agent'\],)('relayCredentialless':\(\)=>[\w$]+,)/g;
  if ([...source.matchAll(credentials)].length !== 1 ||
      [...source.matchAll(routing)].length !== 1 ||
      !source.includes("'baseUrlEnv':'ANTHROPIC_BASE_URL'") ||
      !source.includes("'authTokenEnv':'ANTHROPIC_AUTH_TOKEN'")) {
    throw new Error('Mirasim 的 Claude 云路由结构已变化，需要更新 mclaude 适配。');
  }
  return source.replace(credentials, (_match, config, enabled, agent, options) =>
    `(()=>{if(!${config}['relayToken']||!${enabled}()||!${agent}(${options}['agent']))` +
    `{throw new Error('mclaude 需要可用的 Mirasim 云端登录。');}return true;})()`)
    // The callback remains authoritative after renewal or Desktop route changes.
    .replace(routing, "$1'relayCloudOnly':()=>true,$2");
}

function run(entry, args) {
  const source = adaptBundle(fs.readFileSync(entry, 'utf8'));
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = (module, filename) => {
    if (filename !== entry) return original(module, filename);
    Module._extensions['.js'] = original;
    module._compile(source, filename);
  };
  process.argv = [process.execPath, entry, 'claude', ...args];
  Module._load(entry, null, true);
}

if (require.main === module) {
  try { run(process.argv[2], process.argv.slice(3)); }
  catch (error) {
    console.error(`mclaude: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { adaptBundle };
