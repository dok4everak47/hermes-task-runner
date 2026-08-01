#!/usr/bin/env node
// htask — Hermes Task Runner
// 把「TASK.md → OpenCode 实现 → 完成通知 → 验证 → REPORT」整条链自动化成一条命令。
// 零 npm 依赖: 只用 node 内置模块。

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_VERIFY = ['npm run typecheck', 'npm test', 'npm run build'];
const VERIFY_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT = 2000;

// ---------- 工具函数 ----------

function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m${sec}s`;
}

function escapeOsascript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 弹 macOS 通知, 失败必须静默 (不阻塞主流程)
function notify(title, subtitle) {
  try {
    const script = `display notification "${escapeOsascript(subtitle)}" with title "${escapeOsascript(title)}"`;
    const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    child.on('error', () => {});
  } catch {
    /* 静默 */
  }
}

// ---------- 状态文件 ----------

export async function readState(cwd) {
  try {
    const raw = await readFile(path.join(cwd, '.htask', 'state.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeState(cwd, state) {
  await mkdir(path.join(cwd, '.htask'), { recursive: true });
  await writeFile(path.join(cwd, '.htask', 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

// ---------- 解析 ----------

// 解析 TASK.md: 标题取第一行 "# TASK — xxx"; 验证命令取 "## Verification Commands" 下
// 的 bash 代码块内容, 逐行 trim, 跳过空行与 # 注释行。
export function parseTaskFile(md) {
  let title = '';
  const firstLine = String(md).split('\n')[0] ?? '';
  const m = firstLine.match(/^#\s+TASK\s*[—–-]?\s*(.*)$/i);
  if (m && m[1].trim()) {
    title = m[1].trim();
  } else {
    const h = String(md).match(/^#\s+(.+)$/m);
    if (h) title = h[1].trim();
  }

  const verifyCommands = [];
  const idx = String(md).indexOf('## Verification Commands');
  if (idx === -1) return { title, verifyCommands };

  let section = String(md).slice(idx + '## Verification Commands'.length);
  const end = section.search(/\n##\s/);
  if (end !== -1) section = section.slice(0, end);

  const re = /```(?:bash|sh)?\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(section)) !== null) {
    for (const line of match[1].split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('#')) continue;
      verifyCommands.push(t);
    }
  }
  return { title, verifyCommands };
}

// ---------- OpenCode 启动 ----------

// 组装 opencode 参数: 前缀 (可被环境变量覆盖) + --model/--agent 覆盖
export function buildOpenCodeArgs({ model, agent } = {}) {
  const prefix = (process.env.HTASK_OPENCODE_ARGS_PREFIX || `run --pure -m ${DEFAULT_MODEL}`)
    .split(/\s+/)
    .filter(Boolean);
  const args = [...prefix];
  if (model) {
    const mi = args.indexOf('-m');
    if (mi >= 0) {
      args.splice(mi, 2, '-m', model);
    } else {
      const mi2 = args.indexOf('--model');
      if (mi2 >= 0) args.splice(mi2, 2, '--model', model);
      else args.push('-m', model);
    }
  }
  if (agent) args.push('--agent', agent);
  return args;
}

// spawn opencode 后台运行, stdout/stderr 追加到 .htask/<logName>, 退出时 resolve
export function spawnOpenCode(cwd, args, prompt, logName = 'implement.log') {
  return new Promise((resolve) => {
    const cmd = process.env.HTASK_OPENCODE_CMD || 'opencode';
    const logPath = path.join(cwd, '.htask', logName);
    const fullArgs = [...args, prompt];
    const start = Date.now();
    let settled = false;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, durationMs: Date.now() - start });
    };

    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
    } catch {
      /* 静默 */
    }
    try {
      appendFileSync(logPath, `\n=== ${new Date().toISOString()} · $ ${cmd} ${fullArgs.join(' ')} ===\n`);
    } catch {
      /* 静默 */
    }

    const child = spawn(cmd, fullArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => {
      try {
        appendFileSync(logPath, d);
      } catch {
        /* 静默 */
      }
    });
    child.stderr?.on('data', (d) => {
      try {
        appendFileSync(logPath, d);
      } catch {
        /* 静默 */
      }
    });
    child.on('error', (err) => {
      try {
        appendFileSync(logPath, `[spawn 错误] ${err.message}\n`);
      } catch {
        /* 静默 */
      }
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

// ---------- 验证 ----------

// 逐条执行验证命令, 超时 600s/条, 记录 exit code / 耗时 / 输出 (截断 2000 字符)
export async function runVerifyCommands(cwd, commands) {
  const results = [];
  for (const cmd of commands) {
    const start = Date.now();
    const out = spawnSync(cmd, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    let exitCode = out.status;
    let output = [out.stdout, out.stderr].filter(Boolean).join('').trim();
    if (out.error) {
      if (out.error.code === 'ETIMEDOUT') {
        exitCode = -1;
        output += '\n[超时: 超过 600s]';
      } else {
        exitCode = -1;
        output += `\n[执行错误: ${out.error.message}]`;
      }
    }
    if (output.length > OUTPUT_LIMIT) {
      output = output.slice(0, OUTPUT_LIMIT) + '\n…[输出截断]';
    }
    results.push({ command: cmd, exitCode, durationMs, output });
    console.log(`   ${exitCode === 0 ? '✅' : '❌'} ${cmd} (${fmtDuration(durationMs)})`);
  }
  return results;
}

// ---------- REPORT.md ----------

export async function writeReport(cwd, ctx) {
  const verify = ctx.verify ?? [];
  const pass = verify.length > 0 && verify.every((r) => r.exitCode === 0);
  const statusLabel = pass ? '✅ 通过' : '❌ 失败';
  const total = ctx.startedAt && ctx.endedAt ? new Date(ctx.endedAt) - new Date(ctx.startedAt) : null;

  const lines = [];
  lines.push(`# REPORT — ${ctx.title ?? '未知任务'}`);
  lines.push('');
  lines.push(`- 状态: ${statusLabel}`);
  lines.push(`- 开始: ${ctx.startedAt ?? '-'} · 结束: ${ctx.endedAt ?? '-'} · 耗时: ${fmtDuration(total)}`);
  lines.push(`- 实现: OpenCode exit ${ctx.implementExit ?? '-'} (${fmtDuration(ctx.implementDurationMs)}) · 日志: .htask/implement.log`);
  lines.push('');
  lines.push('## 验证结果');
  lines.push('');
  lines.push('| # | 命令 | exit | 耗时 | 结果 |');
  lines.push('|---|------|------|------|------|');
  if (verify.length === 0) {
    lines.push('| - | (无验证命令) | - | - | - |');
  } else {
    verify.forEach((r, i) => {
      lines.push(`| ${i + 1} | ${String(r.command).replace(/\|/g, '\\|')} | ${r.exitCode} | ${fmtDuration(r.durationMs)} | ${r.exitCode === 0 ? '✅' : '❌'} |`);
    });
  }
  lines.push('');
  lines.push('## 输出摘要');
  lines.push('');
  if (verify.length === 0) {
    lines.push('(无)');
  } else {
    verify.forEach((r, i) => {
      lines.push(`### ${i + 1}. ${r.command}`);
      lines.push('```text');
      lines.push(r.output || '(无输出)');
      lines.push('```');
      lines.push('');
    });
  }

  await writeFile(path.join(cwd, 'REPORT.md'), lines.join('\n') + '\n');
}

// ---------- 命令: start ----------

export async function cmdStart({ cwd, taskFile, model, agent, review }) {
  const ht = path.join(cwd, '.htask');
  const lock = path.join(ht, 'state.lock');
  await mkdir(ht, { recursive: true });

  if (existsSync(lock)) {
    console.error('❌ 已有任务在运行 (.htask/state.lock 存在), 请等待完成或删除锁文件');
    return { ok: false, reason: 'locked' };
  }
  await writeFile(lock, String(process.pid));

  try {
    if (!path.isAbsolute(taskFile)) taskFile = path.join(cwd, taskFile);
    const md = await readFile(taskFile, 'utf8');
    const { title, verifyCommands } = parseTaskFile(md);
    const startedAt = new Date().toISOString();

    if (verifyCommands.length === 0) {
      console.warn('⚠️ 未在 TASK.md 找到 Verification Commands, 使用默认验证 (typecheck+test+build)');
    }
    const commands = verifyCommands.length > 0 ? verifyCommands : DEFAULT_VERIFY;

    let state = {
      status: 'running',
      startedAt,
      taskFile: path.basename(taskFile),
      title,
      model: model ?? DEFAULT_MODEL,
      agent: agent ?? null,
    };
    await writeState(cwd, state);

    // 实现
    state.status = 'implementing';
    await writeState(cwd, state);
    console.log(`▶️  启动实现: ${path.basename(taskFile)} (model=${state.model}${agent ? `, agent=${agent}` : ''})`);
    const args = buildOpenCodeArgs({ model, agent });
    const implement = await spawnOpenCode(cwd, args, `按 ${path.basename(taskFile)} 实现，完成后总结`);
    state.implementExit = implement.exitCode;
    state.implementDurationMs = implement.durationMs;
    await writeState(cwd, state);

    notify(
      implement.exitCode === 0 ? '✅ OpenCode 完成' : '❌ OpenCode 失败',
      `exit ${implement.exitCode} · 耗时 ${fmtDuration(implement.durationMs)}`
    );

    // 验证
    state.status = 'verifying';
    await writeState(cwd, state);
    console.log('🔍 开始验证...');
    const verify = await runVerifyCommands(cwd, commands);
    state.verify = verify;
    state.endedAt = new Date().toISOString();
    state.status = verify.every((r) => r.exitCode === 0) ? 'done' : 'failed';
    await writeState(cwd, state);

    await writeReport(cwd, state);
    console.log(`📝 REPORT.md 已生成 (状态: ${state.status})`);

    if (review && state.status === 'done') {
      console.log('🧐 运行 reviewer agent...');
      const rev = await spawnOpenCode(
        cwd,
        buildOpenCodeArgs({ model, agent: 'reviewer' }),
        '按 .templates/REVIEW.md 模板独立验收本次实现并生成 REVIEW.md',
        'review.log'
      );
      if (rev.exitCode !== 0) console.warn(`⚠️ reviewer 退出码 ${rev.exitCode}, 详见 .htask/review.log`);
    }

    return { ok: true };
  } catch (err) {
    console.error(`❌ htask start 失败: ${err.message}`);
    process.exitCode = 1;
    return { ok: false, reason: 'error' };
  } finally {
    try {
      rmSync(lock, { force: true });
    } catch {
      /* 静默 */
    }
  }
}

// ---------- 命令: status ----------

export async function cmdStatus({ cwd }) {
  const state = await readState(cwd);
  if (!state) {
    console.log('状态: idle');
    return;
  }
  console.log(`状态: ${state.status}`);
  console.log(`任务: ${state.taskFile ?? '-'}`);
  if (state.title) console.log(`标题: ${state.title}`);
  console.log(`开始: ${state.startedAt ?? '-'}`);
  if (state.endedAt) console.log(`结束: ${state.endedAt}`);
  if (state.implementExit !== undefined) console.log(`实现: exit ${state.implementExit}`);
  if (Array.isArray(state.verify) && state.verify.length > 0) {
    console.log(`验证: ${state.verify.length} 条, 通过 ${state.verify.filter((r) => r.exitCode === 0).length}`);
  }
}

// ---------- 命令: report ----------

export async function cmdReport({ cwd }) {
  const state = await readState(cwd);
  if (!state) {
    console.error('❌ 没有任务记录 (.htask/state.json 不存在), 无法生成 REPORT.md');
    process.exitCode = 1;
    return;
  }
  await writeReport(cwd, state);
  console.log('📝 REPORT.md 已根据已有状态重新生成');
}

// ---------- CLI 入口 ----------

function printHelp() {
  console.log(`htask — Hermes Task Runner: TASK.md → OpenCode 实现 → 验证 → REPORT.md 全链路自动化

用法:
  htask start [--model <provider/model>] [--agent <agent>] [--review] [TASK.md]
  htask status
  htask report
  htask --help

选项:
  --model <provider/model>   覆盖模型 (默认 ${DEFAULT_MODEL})
  --agent <agent>            指定 opencode agent
  --review                   验证通过后运行 reviewer agent 生成 REVIEW.md

环境变量 (测试注入):
  HTASK_OPENCODE_CMD          opencode 命令 (默认 opencode)
  HTASK_OPENCODE_ARGS_PREFIX  参数前缀 (默认 "run --pure -m ${DEFAULT_MODEL}")
`);
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'start': {
      let model;
      let agent;
      let review = false;
      let taskFile;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--model') model = rest[++i];
        else if (a === '--agent') agent = rest[++i];
        else if (a === '--review') review = true;
        else taskFile = a;
      }
      taskFile = taskFile || 'TASK.md';
      await cmdStart({ cwd, taskFile, model, agent, review });
      break;
    }
    case 'status':
      await cmdStatus({ cwd });
      break;
    case 'report':
      await cmdReport({ cwd });
      break;
    default:
      console.error(`❌ 未知命令: ${cmd}`);
      printHelp();
      process.exitCode = 1;
  }
}

// 主模块守卫: 兼容软链安装 (npm link / /opt/homebrew/bin 软链)。
// 软链时 argv[1] 是链接路径, import.meta.url 是真实路径 — 需 realpath 解析后比较。
import { realpathSync } from 'node:fs'

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error('❌ htask 出错:', err);
    process.exit(1);
  });
}
