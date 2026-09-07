#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const families = ['opus', 'sonnet', 'haiku', 'fable'];
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const baseModel = (id) => id.replace(/\[1m\]$/i, '');
const familyOf = (id) => /^claude-(opus|sonnet|haiku|fable)-/.exec(id)?.[1];

function findMirasim(home = os.homedir()) {
  const root = path.join(home, '.mirasim', 'app');
  const { good } = readJson(path.join(root, 'state.json'));
  if (typeof good !== 'string' || !/^\d+\.\d+\.\d+[\w.-]*$/.test(good)) {
    throw new Error('Mirasim 没有已确认可用的版本，请先打开 Desktop 完成更新。');
  }
  const directory = path.join(root, good);
  const manifest = readJson(path.join(directory, 'payload.json'));
  const entry = path.resolve(directory, manifest.server || 'server.cjs');
  if (!entry.startsWith(directory + path.sep) || !fs.statSync(entry).isFile()) {
    throw new Error('Mirasim 的启动入口无效，请检查 Desktop 安装。');
  }
  return { version: good, entry };
}

function parseArgs(args) {
  const result = { args: [], dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      result.args.push(...args.slice(i));
      break;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    const match = /^--(model|effort)(?:=(.*))?$/.exec(arg);
    if (match) {
      const value = match[2] ?? args[++i];
      if (!value || value.startsWith('--')) {
        throw new Error(`--${match[1]} 需要一个值。`);
      }
      result[match[1]] = value;
    } else {
      result.args.push(arg);
    }
  }
  return result;
}

function readCatalog(entry) {
  try {
    return JSON.parse(execFileSync(process.execPath, [
      entry, 'ui-cli', '--port', '4970', 'catalog', '--agent', 'claude'
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }));
  } catch {
    throw new Error('无法读取 Mirasim 模型配置。请确认 Desktop 已运行（本机端口 4970）。');
  }
}

function buildSettings(catalog, options) {
  if (catalog.agent !== 'claude' || !Array.isArray(catalog.models) ||
      !catalog.models.length || catalog.models.some((model) =>
        !model || typeof model.id !== 'string' || !model.id)) {
    throw new Error('Mirasim 返回的 Claude 模型目录无效。');
  }
  const models = catalog.models;
  const latest = (family) => models.filter((model) => familyOf(model.id) === family)
    .sort((a, b) => baseModel(b.id).localeCompare(baseModel(a.id), 'en', { numeric: true }))[0]?.id;
  let model = options.model || catalog.defaultModel;
  if (model === 'default') model = catalog.defaultModel;
  if (families.includes(model)) {
    model = familyOf(catalog.defaultModel || '') === model
      ? catalog.defaultModel : latest(model) || catalog.defaultModel;
  }
  if (typeof model !== 'string' || !models.some((item) =>
    baseModel(item.id) === baseModel(model))) {
    throw new Error(`模型 ${model || '(未设置)'} 不在 Mirasim 目录中。可用模型：${models.map((item) => item.id).join(', ')}`);
  }
  // Desktop exposes "ultra", but launches Claude Code with "max" for that level.
  let effort = options.effort || catalog.defaultEffort;
  if (effort === 'ultra') effort = 'max';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error(`不支持的推理强度：${effort || '(未设置)'}。`);
  }
  const env = {
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: effort,
    CLAUDE_CODE_SUBAGENT_MODEL: model
  };
  const roles = {};
  const fallbacks = [];
  for (const family of families) {
    const id = familyOf(model) === family ? model : latest(family) || model;
    const info = models.find((item) => baseModel(item.id) === baseModel(id));
    const key = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`;
    env[key] = id;
    env[`${key}_NAME`] = info?.label || id;
    env[`${key}_DESCRIPTION`] = id;
    roles[family] = id;
    if (familyOf(id) !== family) fallbacks.push(family);
  }
  env.ANTHROPIC_SMALL_FAST_MODEL = roles.haiku;
  return { model, effort, roles, fallbacks, settings: { env } };
}

function launch(entry, config, args) {
  // The overlay and process environment must agree: Claude reads both sources.
  const child = spawn(process.execPath, [
    entry, 'claude', '--model', config.model, '--effort', config.effort,
    '--settings', JSON.stringify(config.settings), ...args
  ], { stdio: 'inherit', env: { ...process.env, ...config.settings.env } });

  // Terminal Ctrl+C reaches the whole foreground group, including the child.
  const onInterrupt = () => {};
  const onTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const cleanup = () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
  child.once('error', (error) => {
    cleanup();
    console.error(`mclaude: ${error.message}`);
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
    console.log('用法：mclaude [--dry-run] [--model 模型] [--effort 强度] [Claude Code 参数]\n\n需要运行 Mirasim Desktop。--dry-run 仅显示模型配置，不启动 Claude Code。');
    return;
  }
  const options = parseArgs(args);
  const mirasim = findMirasim();
  const config = buildSettings(readCatalog(mirasim.entry), options);
  if (options.dryRun) {
    console.log(JSON.stringify({
      ...mirasim, model: config.model, effort: config.effort,
      roles: config.roles, subagentModel: config.settings.env.CLAUDE_CODE_SUBAGENT_MODEL,
      fallbacks: config.fallbacks
    }, null, 2));
    return;
  }
  console.error(`mclaude · Mirasim ${mirasim.version} · ${config.model} · ${config.effort}`);
  for (const family of config.fallbacks) {
    console.error(`mclaude · 目录未提供 ${family}，该角色使用 ${config.roles[family]}`);
  }
  launch(mirasim.entry, config, options.args);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`mclaude: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { findMirasim, parseArgs, buildSettings };
