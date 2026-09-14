#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { findMirasim } = require('./mclaude.cjs');
const { adaptBundle } = require('./mirasim-codex.cjs');

function parseArgs(args) {
  const result = { args: [], dryRun: false };
  let i = 0;
  // Stop at native arguments so subcommands and prompt contents stay intact.
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    const match = /^--(model|effort)(?:=(.*))?$/.exec(arg);
    if (match) {
      const value = match[2] ?? args[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${match[1]} 需要一个值。`);
      result[match[1]] = value;
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
      const output = run(process.execPath, [entry, 'ui-cli', ...port, 'catalog', '--agent', 'codex'], {
        encoding: 'utf8', timeout: port.length ? 15000 : 30000,
        maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
      });
      return JSON.parse(output.slice(output.lastIndexOf('\n{') + 1));
    } catch {}
  }
  throw new Error('无法读取 Mirasim GPT 模型目录。请检查 Mirasim 登录和网络。');
}

function buildConfig(catalog, options = {}, inherited = process.env) {
  if (catalog?.agent !== 'codex' || !Array.isArray(catalog.models) || !catalog.models.length ||
      catalog.models.some(item => !item || typeof item.id !== 'string' || !item.id)) {
    throw new Error('Mirasim 返回的 GPT 模型目录无效。');
  }
  const model = !options.model || options.model === 'default' ? catalog.defaultModel : options.model;
  const selected = catalog.models.find(item => item.id === model);
  if (!selected) {
    throw new Error(`模型 ${model || '(未设置)'} 不在 Mirasim 目录中。可用模型：${catalog.models.map(item => item.id).join(', ')}`);
  }
  const effort = options.effort || catalog.defaultEffort;
  const efforts = catalog.effort === undefined ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    : Array.isArray(catalog.effort) ? catalog.effort.map(item => item?.id) : [];
  if (!effort || !efforts.includes(effort)) throw new Error(`不支持的推理强度：${effort || '(未设置)'}。`);
  const contextWindow = selected.contextWindow;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('Mirasim 返回的 GPT 上下文长度无效。');
  }
  const env = { ...inherited };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'MCODEX_API_KEY', 'MIRASIM_UPSTREAM_BASE_URL']) {
    delete env[key];
  }
  return { model, effort, contextWindow, env };
}

function launch(entry, config, args) {
  const child = spawn(process.execPath, [path.join(__dirname, 'mirasim-codex.cjs'), entry,
    '-c', `model=${JSON.stringify(config.model)}`, '-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`,
    '-c', `model_context_window=${config.contextWindow}`, ...args
  ], { stdio: 'inherit', env: config.env });
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
    console.error(`mcodex: ${error.message}`);
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
    console.log('用法：mcodex [--dry-run] [--model 模型] [--effort 强度] [Codex 参数]\n\n使用 Mirasim 云额度启动官方 Codex CLI，默认模型和推理强度跟随 Mirasim。\n启动器选项放在 Codex 参数之前；--dry-run 只检查配置。\n例如：mcodex、mcodex resume --last、mcodex --effort high exec "解释当前项目"。\n查看官方 CLI 帮助：mcodex -- --help。');
    return;
  }
  const options = parseArgs(args);
  const mirasim = findMirasim();
  adaptBundle(fs.readFileSync(mirasim.entry, 'utf8'));
  const config = buildConfig(readCatalog(mirasim.entry), options);
  if (options.dryRun) {
    console.log(JSON.stringify({ ...mirasim, model: config.model, effort: config.effort,
      contextWindow: config.contextWindow, route: 'Mirasim cloud' }, null, 2));
    return;
  }
  console.error(`mcodex · Mirasim ${mirasim.version} · ${config.model} · ${config.effort}`);
  launch(mirasim.entry, config, options.args);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`mcodex: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, readCatalog, buildConfig };
