#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
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

function readLauncherConfig(file = path.join(__dirname, 'mcodex.config.json')) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('无法读取 mcodex.config.json，请检查 JSON 格式。');
  }
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
      (config.autoReviewModel !== undefined && typeof config.autoReviewModel !== 'string')) {
    throw new Error('mcodex.config.json 的 autoReviewModel 必须是模型 ID 字符串，留空表示不配置。');
  }
  return { autoReviewModel: config.autoReviewModel?.trim() || '' };
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
  const config = { model, effort, contextWindow, env };
  if (options.autoReviewModel) {
    const id = options.autoReviewModel;
    const reviewer = catalog.models.find(item => item.id === id);
    if (!reviewer || id === 'codex-auto-review') {
      throw new Error(`审核模型 ${id} 不在 Mirasim 可用目录中。可用模型：${catalog.models.map(item => item.id).join(', ')}`);
    }
    const levels = catalog.effortByModel?.[id] ?? catalog.effort;
    const efforts = Array.isArray(levels) ? levels.filter(item => item && !item.unavailable).map(item => item.id) : [];
    if (!efforts.includes('low')) throw new Error(`审核模型 ${id} 未提供 low 推理强度。`);
    if (!Number.isSafeInteger(reviewer.contextWindow) || reviewer.contextWindow <= 0) {
      throw new Error('Mirasim 返回的审核模型上下文长度无效。');
    }
    config.autoReview = { model: id, effort: 'low', efforts, contextWindow: reviewer.contextWindow };
  }
  return config;
}

function readReviewCatalog(config, run = execFileSync) {
  let catalog;
  try {
    catalog = JSON.parse(run(config.env.MIRASIM_CODEX_BIN || 'codex', ['debug', 'models', '--bundled'], {
      env: config.env, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  } catch {
    throw new Error('无法读取 Codex 内置模型目录，请使用支持 debug models --bundled 的 Codex CLI。');
  }
  const models = catalog?.models;
  if (!Array.isArray(models) || models.some(item => !item || typeof item.slug !== 'string')) {
    throw new Error('Codex 内置模型目录无效，请更新 Codex CLI。');
  }
  const template = models.find(item => item.slug === 'codex-auto-review');
  let primary = models.find(item => item.slug === config.model);
  const sibling = models.find(item => item.visibility === 'list');
  const review = config.autoReview;
  const existing = models.find(item => item.slug === review.model);
  if (!template || (!primary && !sibling)) {
    throw new Error('Codex 内置目录缺少主模型或审核模型，请更新 Codex CLI。');
  }
  if (!primary) {
    // Match Mirasim's use of a bundled sibling for models absent from Codex.
    primary = { ...sibling, slug: config.model, display_name: config.model,
      context_window: config.contextWindow, max_context_window: config.contextWindow,
      use_responses_lite: false };
    models.push(primary);
  }
  const reviewer = {
    ...(existing || (review.model === config.model ? primary : template)),
    slug: review.model, display_name: review.model,
    description: existing?.description || 'Automatic approval review model for Mirasim.',
    context_window: review.contextWindow, max_context_window: review.contextWindow,
    supported_reasoning_levels: review.efforts.map(effort => ({ effort, description: effort })),
    default_reasoning_level: review.effort,
    ...(!existing ? { use_responses_lite: false, support_verbosity: false,
      additional_speed_tiers: [], service_tiers: [] } : {})
  };
  return { ...catalog, models: [...models.filter(item => item.slug !== review.model), reviewer]
    .map(item => ({ ...item, auto_review_model_override: review.model })) };
}

function launch(entry, config, args) {
  let directory;
  const reviewArgs = [];
  const cleanCatalog = () => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  };
  let child;
  try {
    if (config.autoReview) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcodex-review-'));
      const file = path.join(directory, 'models.json');
      fs.writeFileSync(file, JSON.stringify(config.reviewCatalog), { mode: 0o600 });
      reviewArgs.push('-c', `model_catalog_json=${JSON.stringify(file)}`, '-c', 'approvals_reviewer="auto_review"');
    }
    child = spawn(process.execPath, [path.join(__dirname, 'mirasim-codex.cjs'), entry,
      '-c', `model=${JSON.stringify(config.model)}`, '-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`,
      '-c', `model_context_window=${config.contextWindow}`, ...reviewArgs, ...args
    ], { stdio: 'inherit', env: config.env });
  } catch (error) {
    cleanCatalog();
    throw error;
  }
  const interrupt = () => {};
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const cleanup = () => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    cleanCatalog();
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
    console.log('用法：mcodex [--dry-run] [--model 模型] [--effort 强度] [Codex 参数]\n\n使用 Mirasim 云额度启动官方 Codex CLI，默认模型和推理强度跟随 Mirasim。\n项目根目录 mcodex.config.json 的 autoReviewModel 指定自动审批模型（low），留空则沿用原审批配置。\n启动器选项放在 Codex 参数之前；--dry-run 只检查配置。\n例如：mcodex、mcodex resume --last、mcodex --effort high exec "解释当前项目"。\n查看官方 CLI 帮助：mcodex -- --help。');
    return;
  }
  const options = parseArgs(args);
  const mirasim = findMirasim();
  adaptBundle(fs.readFileSync(mirasim.entry, 'utf8'));
  const config = buildConfig(readCatalog(mirasim.entry), { ...options, ...readLauncherConfig() });
  if (config.autoReview) config.reviewCatalog = readReviewCatalog(config);
  if (options.dryRun) {
    console.log(JSON.stringify({ ...mirasim, model: config.model, effort: config.effort,
      contextWindow: config.contextWindow, route: 'Mirasim cloud',
      ...(config.autoReview ? { autoReview: { model: config.autoReview.model, effort: config.autoReview.effort,
        reviewer: 'auto_review', catalogSource: 'Codex bundled' } } : {}) }, null, 2));
    return;
  }
  console.error(`mcodex · Mirasim ${mirasim.version} · ${config.model} · ${config.effort}`);
  if (config.autoReview) console.error(`自动审批 · ${config.autoReview.model} · ${config.autoReview.effort}`);
  launch(mirasim.entry, config, options.args);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`mcodex: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, readCatalog, readLauncherConfig, buildConfig, readReviewCatalog };
