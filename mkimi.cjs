#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { findMirasim } = require('./mclaude.cjs');
const { adaptBundle } = require('./mirasim-kimi.cjs');

function parseArgs(args) {
  const result = { args: [], dryRun: false };
  let i = 0;
  // Launcher options precede native arguments, so prompt text stays untouched.
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--effort' || arg.startsWith('--effort=')) {
      const value = arg === '--effort' ? args[++i] : arg.slice('--effort='.length);
      if (!['low', 'high', 'max'].includes(value)) {
        throw new Error('--effort 需要 low、high 或 max。');
      }
      result.effort = value;
    } else {
      if (arg === '--') i++;
      break;
    }
  }
  result.args = args.slice(i);
  return result;
}

function readCatalog(entry, run = execFileSync) {
  for (const port of [['--port', '4970'], []]) {
    try {
      const output = run(process.execPath, [entry, 'ui-cli', ...port, 'catalog', '--agent', 'kimi'], {
        encoding: 'utf8', timeout: port.length ? 15000 : 30000,
        maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
      });
      return JSON.parse(output.slice(output.lastIndexOf('\n{') + 1));
    } catch {}
  }
  throw new Error('无法读取 Mirasim Kimi 模型目录。请检查 Mirasim 登录和网络。');
}

function buildConfig(catalog, options = {}, inherited = process.env) {
  const model = catalog?.agent === 'kimi' && Array.isArray(catalog.models) &&
    catalog.models.find((item) => item?.id === 'kimi-code/k3');
  if (!model || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error('Mirasim 当前目录未提供有效的 Kimi K3 配置。');
  }
  // The temporary backend can omit Kimi's native default effort.
  const effort = options.effort || catalog.defaultEffort || 'high';
  if (!['low', 'high', 'max'].includes(effort)) {
    throw new Error('Mirasim 的 Kimi 推理强度无效。');
  }
  const maxCompletionTokens = 131072;
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (key.startsWith('KIMI_MODEL_')) delete env[key];
  }
  delete env.MIRASIM_UPSTREAM_BASE_URL;
  Object.assign(env, {
    KIMI_MODEL_NAME: 'kimi-k3',
    KIMI_MODEL_PROVIDER_TYPE: 'kimi',
    KIMI_MODEL_DISPLAY_NAME: 'Mirasim Kimi K3',
    KIMI_MODEL_MAX_CONTEXT_SIZE: String(model.contextWindow),
    // Kimi otherwise uses the entire context window as the completion budget.
    KIMI_MODEL_MAX_COMPLETION_TOKENS: String(maxCompletionTokens),
    KIMI_MODEL_THINKING_EFFORT: effort
  });
  return { model: 'kimi-k3', contextWindow: model.contextWindow, maxCompletionTokens, effort, env };
}

function launch(entry, config, args) {
  const child = spawn(process.execPath, [path.join(__dirname, 'mirasim-kimi.cjs'), entry, ...args], {
    stdio: 'inherit', env: config.env
  });
  // Terminal Ctrl+C already reaches both the runner and its foreground CLI.
  const interrupt = () => {};
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const cleanup = () => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
  child.once('error', (error) => {
    cleanup();
    console.error(`mkimi: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('用法：mkimi [--dry-run] [--effort low|high|max] [Kimi Code 参数]\n\n使用 Mirasim 云额度启动官方 Kimi Code CLI，默认模型为 K3。\n启动器选项放在 Kimi 参数之前；--dry-run 只检查配置。\n例如：mkimi、mkimi -c、mkimi --effort max -p "解释当前项目"。\n查看官方 CLI 帮助：mkimi -- --help。');
    return;
  }
  const options = parseArgs(args);
  const mirasim = findMirasim();
  adaptBundle(fs.readFileSync(mirasim.entry, 'utf8'));
  const config = buildConfig(readCatalog(mirasim.entry), options);
  if (options.dryRun) {
    console.log(JSON.stringify({ ...mirasim, model: config.model,
      contextWindow: config.contextWindow, maxCompletionTokens: config.maxCompletionTokens,
      effort: config.effort, route: 'Mirasim cloud' }, null, 2));
    return;
  }
  console.error(`mkimi · Mirasim ${mirasim.version} · ${config.model} · ${config.effort}`);
  launch(mirasim.entry, config, options.args);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`mkimi: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, readCatalog, buildConfig };
