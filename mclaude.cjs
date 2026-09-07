#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const families = ['opus', 'sonnet', 'haiku', 'fable'];
const catalogTtlMs = 7 * 24 * 60 * 60 * 1000;
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
  const result = { args: [], dryRun: false, refresh: false };
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
    if (arg === '--refresh') {
      result.refresh = true;
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

function readCatalog(entry, run = execFileSync) {
  // Without --port, Mirasim owns a temporary backend and closes it after querying.
  for (const portArgs of [['--port', '4970'], []]) {
    try {
      const output = run(process.execPath, [
        entry, 'ui-cli', ...portArgs, 'catalog', '--agent', 'claude'
      ], {
        encoding: 'utf8', timeout: portArgs.length ? 15000 : 30000,
        maxBuffer: 1024 * 1024,
        // Backend startup logs may contain local access tokens.
        stdio: ['ignore', 'pipe', 'pipe']
      });
      // Standalone ui-cli writes startup logs before its final JSON object.
      return JSON.parse(output.slice(output.lastIndexOf('\n{') + 1));
    } catch {
      // A closed Desktop can still be queried through the standalone backend.
    }
  }
  throw new Error('无法读取 Mirasim 模型配置。请检查安装、登录和网络；首次使用需打开 Desktop 完成初始化。');
}

function cachedCatalog(mirasim, {
  home = os.homedir(), env = process.env, now = Date.now, read = readCatalog,
  cacheDir = path.join(__dirname, '.cache'), refresh = false
} = {}) {
  const file = path.join(cacheDir, 'catalog.json');
  const configFile = path.resolve(env.MIRASIM_CONFIG?.trim() ||
    path.join(env.MIRASIM_HOME || path.join(home, '.mirasim'), 'setting.json'));
  const cacheKey = () => {
    try {
      // Hash the contents so rewriting unchanged settings does not expire the cache.
      const settings = createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
      return JSON.stringify([1, mirasim.version, mirasim.entry, configFile, settings,
        env.CLAUDE_MODEL || '', env.CLAUDE_REASONING_EFFORT || '']);
    } catch {
      return null;
    }
  };
  const key = cacheKey();
  try {
    const cached = readJson(file);
    const age = now() - cached.createdAt;
    if (!refresh && key && cached.key === key && Number.isFinite(cached.createdAt) &&
        age >= 0 && age < catalogTtlMs) {
      buildSettings(cached.catalog, {});
      return cached.catalog;
    }
  } catch {
    // Missing or damaged caches are refreshed through Mirasim.
  }

  const fresh = read(mirasim.entry);
  buildSettings(fresh, {});
  // Persist only model information, never backend logs, ports, or credentials.
  const catalog = {
    agent: fresh.agent,
    models: fresh.models.map(({ id, label }) => ({ id, label })),
    defaultModel: fresh.defaultModel,
    defaultEffort: fresh.defaultEffort
  };
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    // Do not reuse a result if settings changed while the query was running.
    if (!key || key !== cacheKey()) return catalog;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ key, createdAt: now(), catalog }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // Cache storage is optional; the fresh catalog can still launch Claude Code.
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return catalog;
}

function buildSettings(catalog, options) {
  if (catalog.agent !== 'claude' || !Array.isArray(catalog.models) ||
      !catalog.models.length || catalog.models.some((model) =>
        !model || typeof model.id !== 'string' || !model.id)) {
    throw new Error('Mirasim 返回的 Claude 模型目录无效。');
  }
  const models = catalog.models;
  const latest = (family) => models.filter((model) => familyOf(model.id) === family)
    .sort((a, b) => baseModel(b.id).localeCompare(baseModel(a.id), 'en', { numeric: true }) ||
      Number(/\[1m\]$/i.test(b.id)) - Number(/\[1m\]$/i.test(a.id)))[0]?.id;
  let model = options.model || catalog.defaultModel;
  if (model === 'default') model = catalog.defaultModel;
  if (families.includes(model)) {
    model = familyOf(catalog.defaultModel || '') === model
      ? catalog.defaultModel : latest(model) || catalog.defaultModel;
  }
  const selected = typeof model === 'string'
    ? models.find((item) => item.id === model) ||
      models.find((item) => baseModel(item.id) === baseModel(model))
    : undefined;
  if (!selected) {
    throw new Error(`模型 ${model || '(未设置)'} 不在 Mirasim 目录中。可用模型：${models.map((item) => item.id).join(', ')}`);
  }
  model = selected.id;
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
    const info = models.find((item) => item.id === id);
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
    console.log('用法：mclaude [--refresh] [--dry-run] [--model 模型] [--effort 强度] [Claude Code 参数]\n\n需要已安装并初始化的 Mirasim，无需保持 Desktop 运行。模型目录缓存 7 天；--refresh 强制刷新。--dry-run 仅显示模型配置，不启动 Claude Code。');
    return;
  }
  const options = parseArgs(args);
  const mirasim = findMirasim();
  const config = buildSettings(cachedCatalog(mirasim, { refresh: options.refresh }), options);
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

module.exports = { findMirasim, parseArgs, readCatalog, cachedCatalog, buildSettings };
