#!/usr/bin/env node
// htask — Hermes Task Runner
// 把「TASK.md → OpenCode 实现 → 完成通知 → 验证 → REPORT」整条链自动化成一条命令,
// 并给每个任务引入生命周期状态机 (CREATED → ... → MERGED), 升级为 orchestrator。
// 零 npm 依赖: 只用 node 内置模块。

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_VERIFY = ['npm run typecheck', 'npm test', 'npm run build'];
const VERIFY_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT = 2000;

// ---------- 状态机核心 ----------

export const STATES = [
  'CREATED',
  'PLANNING',
  'IMPLEMENTING',
  'REVIEWING',
  'VERIFYING',
  'ACCEPTED',
  'MERGED',
  'FAILED',
  'CANCELLED',
];
export const TERMINAL = new Set(['MERGED', 'FAILED', 'CANCELLED']);

// from -> 允许的 to (非法迁移会被 transition 拒绝)
export const TRANSITIONS = {
  CREATED: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['IMPLEMENTING', 'FAILED', 'CANCELLED'],
  IMPLEMENTING: ['REVIEWING', 'VERIFYING', 'FAILED', 'CANCELLED'],
  REVIEWING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['ACCEPTED', 'FAILED', 'CANCELLED'],
  ACCEPTED: ['MERGED', 'CANCELLED'],
  MERGED: [],
  FAILED: [],
  CANCELLED: [],
};

// task-YYYYMMDD-<slug>: 日期 + 标题前 12 字符 (去非字母数字, 小写)
export function newTaskId(title = '') {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12);
  return `task-${date}-${slug || 'task'}`;
}

// 根据状态返回下一步建议: "等待人工: htask accept" 等
export function nextStep(task) {
  switch (task?.status) {
    case 'CREATED':
      return '未开始';
    case 'PLANNING':
      return '规划中';
    case 'IMPLEMENTING':
      return '实现中';
    case 'REVIEWING':
      return '审查中';
    case 'VERIFYING':
      return '等待人工: htask accept';
    case 'ACCEPTED':
      return '可继续: htask merge';
    case 'MERGED':
      return '已完成';
    case 'FAILED':
      return '失败: 需人工介入';
    case 'CANCELLED':
      return '已取消';
    default:
      return '-';
  }
}

// 卡住检测: 非终态且停留超过阈值 → { stale, reason }, 否则 null
export function staleInfo(task) {
  if (!task || TERMINAL.has(task.status)) return null;
  const thresholds = {
    IMPLEMENTING: { min: 30, msg: 'opencode 可能挂了' },
    REVIEWING: { min: 15, msg: 'reviewer 可能挂了' },
    VERIFYING: { min: 60, msg: '等待人工 accept 太久' },
    ACCEPTED: { min: 24 * 60, msg: '等待 merge 太久' },
  };
  const t = thresholds[task.status];
  if (!t) return null;
  const updated = task.updatedAt ? new Date(task.updatedAt).getTime() : Date.now();
  const minutes = (Date.now() - updated) / 60000;
  if (minutes > t.min) {
    return { stale: true, reason: `${task.status} 停留超过 ${t.min}min, ${t.msg}` };
  }
  return null;
}

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

// ---------- 任务存储 ----------

function statePath(cwd) {
  return path.join(cwd, '.htask', 'state.json');
}

function taskPath(cwd, id) {
  return path.join(cwd, '.htask', 'tasks', `${id}.json`);
}

// 读 .htask/state.json: 新格式为当前任务指针 { currentId }, 旧格式含 status (待迁移)
export async function readState(cwd) {
  try {
    const raw = await readFile(statePath(cwd), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeState(cwd, state) {
  await mkdir(path.join(cwd, '.htask'), { recursive: true });
  await writeFile(statePath(cwd), JSON.stringify(state, null, 2) + '\n');
}

export async function writeTask(cwd, task) {
  const dir = path.join(cwd, '.htask', 'tasks');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${task.id}.json`), JSON.stringify(task, null, 2) + '\n');
}

export async function readTask(cwd, id) {
  try {
    const raw = await readFile(taskPath(cwd, id), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readAllTasks(cwd) {
  const dir = path.join(cwd, '.htask', 'tasks');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const tasks = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const t = JSON.parse(await readFile(path.join(dir, n), 'utf8'));
      if (t && t.id) tasks.push(t);
    } catch {
      /* 跳过损坏文件 */
    }
  }
  tasks.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  return tasks;
}

// 创建任务: 写 tasks/<id>.json (状态 CREATED), 更新 state.json 指针
export async function createTask(cwd, meta) {
  const id = meta.id || newTaskId(meta.title || 'task');
  const now = new Date().toISOString();
  const task = {
    id,
    title: meta.title ?? '未知任务',
    status: 'CREATED',
    agent: meta.agent ?? null,
    model: meta.model ?? DEFAULT_MODEL,
    taskFile: meta.taskFile ?? 'TASK.md',
    review: null,
    verification: null,
    history: [{ from: null, to: 'CREATED', at: now, by: 'auto' }],
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    implementExit: null,
    implementDurationMs: null,
    verify: [],
  };
  await writeTask(cwd, task);
  await writeState(cwd, { currentId: id });
  return task;
}

// 校验迁移合法(TRANSITIONS 表)后推进: 追加 history, 更新 status/updatedAt, 终态写 endedAt
export async function transition(cwd, id, to, by = 'auto') {
  const task = await readTask(cwd, id);
  if (!task) throw new Error(`任务不存在: ${id}`);
  const from = task.status;
  if (from === to) return task;
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`非法迁移: ${from} → ${to}`);
  }
  task.history = task.history ?? [];
  task.history.push({ from, to, at: new Date().toISOString(), by });
  task.status = to;
  task.updatedAt = new Date().toISOString();
  if (TERMINAL.has(to)) task.endedAt = task.endedAt ?? task.updatedAt;
  await writeTask(cwd, task);
  return task;
}

// 旧格式 state.json (含 status) 首次读取时: 迁移到 tasks/<legacy-id>.json, 写指针
export async function migrateLegacyState(cwd) {
  const raw = await readState(cwd);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.currentId) return null; // 已是新格式

  const started = raw.startedAt ? new Date(raw.startedAt) : new Date();
  const dateStr = started.toISOString().slice(0, 10).replace(/-/g, '');
  const id = `task-${dateStr}-legacy`;
  const now = new Date().toISOString();

  const statusMap = {
    running: 'IMPLEMENTING',
    implementing: 'IMPLEMENTING',
    verifying: 'VERIFYING',
    done: 'VERIFYING',
    failed: 'FAILED',
  };
  const newStatus = statusMap[raw.status] || 'VERIFYING';
  const updated = raw.endedAt ?? raw.startedAt ?? now;

  const task = {
    id,
    title: raw.title ?? path.basename(raw.taskFile ?? 'TASK.md'),
    status: newStatus,
    agent: raw.agent ?? null,
    model: raw.model ?? DEFAULT_MODEL,
    taskFile: raw.taskFile ?? 'TASK.md',
    review: null,
    verification: null,
    history: [{ from: 'CREATED', to: newStatus, at: raw.startedAt ?? now, by: 'migration' }],
    startedAt: raw.startedAt ?? now,
    updatedAt: updated,
    endedAt: TERMINAL.has(newStatus) ? updated : null,
    implementExit: raw.implementExit ?? null,
    implementDurationMs: raw.implementDurationMs ?? null,
    verify: Array.isArray(raw.verify) ? raw.verify : [],
  };
  await writeTask(cwd, task);
  await writeState(cwd, { currentId: id });
  return task;
}

// 读 state.json 指针 → tasks/<id>.json; 旧格式自动迁移
export async function currentTask(cwd) {
  const state = await readState(cwd);
  if (!state) return null;
  if (state.currentId) return readTask(cwd, state.currentId);
  return migrateLegacyState(cwd);
}

// 按 id 或当前任务解析, 找不到时报错并置退出码 1
async function resolveTask(cwd, id) {
  if (id) {
    const t = await readTask(cwd, id);
    if (!t) {
      console.error(`❌ 任务不存在: ${id}`);
      process.exitCode = 1;
      return null;
    }
    return t;
  }
  const t = await currentTask(cwd);
  if (!t) {
    console.error('❌ 没有当前任务, 先运行 htask start');
    process.exitCode = 1;
    return null;
  }
  return t;
}

function dwellMs(task) {
  const upd = task.updatedAt ? new Date(task.updatedAt).getTime() : Date.now();
  return Math.max(0, Date.now() - upd);
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

// 从 verify 数组汇总出 { typecheck: true, test: true, build: true } 风格的摘要
function verificationSummary(verify) {
  const out = {};
  (verify || []).forEach((r, i) => {
    let key = String(r.command || '')
      .replace(/^npm\s+(run\s+)?/, '')
      .replace(/[^a-z0-9]+/gi, '')
      .toLowerCase();
    if (!key) key = `cmd${i + 1}`;
    out[key] = r.exitCode === 0;
  });
  return out;
}

// ---------- REPORT.md ----------

export async function writeReport(cwd, ctx) {
  const verify = ctx.verify ?? [];
  const hasVerify = verify.length > 0;
  const pass = hasVerify ? verify.every((r) => r.exitCode === 0) : null;
  const statusLabel = pass === null ? '—' : pass ? '✅ 通过' : '❌ 失败';
  const total = ctx.startedAt && ctx.endedAt ? new Date(ctx.endedAt) - new Date(ctx.startedAt) : null;
  const status = ctx.status ?? (pass === null ? 'UNKNOWN' : pass ? 'VERIFYING' : 'FAILED');

  const lines = [];
  lines.push(`# REPORT — ${ctx.title ?? '未知任务'}`);
  lines.push('');
  lines.push(`- 状态: ${status} · ${statusLabel}`);
  lines.push(`- 下一步: ${nextStep(ctx)}`);
  if (Array.isArray(ctx.history) && ctx.history.length > 0) {
    lines.push(`- 迁移历史: ${ctx.history.map((h) => (h.from ? `${h.from}→${h.to}` : h.to)).join(' → ')}`);
  }
  lines.push(`- 开始: ${ctx.startedAt ?? '-'} · 结束: ${ctx.endedAt ?? '-'} · 耗时: ${fmtDuration(total)}`);
  lines.push(`- 实现: OpenCode exit ${ctx.implementExit ?? '-'} (${fmtDuration(ctx.implementDurationMs)})`);
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

export async function cmdStart({ cwd, taskFile, model, agent, review, id }) {
  const ht = path.join(cwd, '.htask');
  const lock = path.join(ht, 'state.lock');
  await mkdir(ht, { recursive: true });

  if (existsSync(lock)) {
    console.error('❌ 已有任务在运行 (.htask/state.lock 存在), 请等待完成或删除锁文件');
    return { ok: false, reason: 'locked' };
  }
  await writeFile(lock, String(process.pid));

  let task = null;
  try {
    if (!path.isAbsolute(taskFile)) taskFile = path.join(cwd, taskFile);

    // 1. 创建任务 → CREATED (标题先用尽力解析)
    let md = null;
    let parseError = null;
    try {
      md = await readFile(taskFile, 'utf8');
    } catch (err) {
      parseError = err;
    }
    const { title } = md ? parseTaskFile(md) : { title: path.basename(taskFile) };
    task = await createTask(cwd, {
      id,
      title,
      model: model ?? DEFAULT_MODEL,
      agent,
      taskFile: path.basename(taskFile),
    });

    // 2. 解析 TASK.md → 成功 PLANNING, 失败 FAILED
    if (parseError) {
      console.error(`❌ 解析 TASK.md 失败: ${parseError.message}`);
      await transition(cwd, task.id, 'FAILED', 'auto');
      await writeReport(cwd, await readTask(cwd, task.id));
      return { ok: false, reason: 'parse-error' };
    }
    const { verifyCommands } = parseTaskFile(md);

    // 3. IMPLEMENTING → spawn opencode
    await transition(cwd, task.id, 'PLANNING', 'auto');
    await transition(cwd, task.id, 'IMPLEMENTING', 'auto');
    console.log(`▶️  启动实现: ${path.basename(taskFile)} (model=${task.model}${agent ? `, agent=${agent}` : ''})`);
    const args = buildOpenCodeArgs({ model, agent });
    const logName = `logs/${task.id}.log`;
    const implement = await spawnOpenCode(cwd, args, `按 ${path.basename(taskFile)} 实现，完成后总结`, logName);
    task = await readTask(cwd, task.id);
    task.implementExit = implement.exitCode;
    task.implementDurationMs = implement.durationMs;
    task.updatedAt = new Date().toISOString();
    await writeTask(cwd, task);

    notify(
      implement.exitCode === 0 ? '✅ OpenCode 完成' : '❌ OpenCode 失败',
      `exit ${implement.exitCode} · 耗时 ${fmtDuration(implement.durationMs)}`
    );

    if (implement.exitCode !== 0) {
      await transition(cwd, task.id, 'FAILED', 'auto');
      console.error(`❌ opencode 退出码 ${implement.exitCode}, 任务已 FAILED (日志: .htask/${logName})`);
      await writeReport(cwd, await readTask(cwd, task.id));
      return { ok: false, reason: 'implement-failed' };
    }

    // 4. --review → REVIEWING → reviewer → 记录 review 结果 → VERIFYING
    if (review) {
      await transition(cwd, task.id, 'REVIEWING', 'auto');
      console.log('🧐 运行 reviewer agent...');
      const revLog = `logs/${task.id}.review.log`;
      const rev = await spawnOpenCode(
        cwd,
        buildOpenCodeArgs({ model, agent: 'reviewer' }),
        '按 .templates/REVIEW.md 模板独立验收本次实现并生成 REVIEW.md',
        revLog
      );
      task = await readTask(cwd, task.id);
      task.review = rev.exitCode === 0 ? 'passed' : 'failed';
      await writeTask(cwd, task);
      if (rev.exitCode !== 0) console.warn(`⚠️ reviewer 退出码 ${rev.exitCode}, 详见 .htask/${revLog}`);
    }
    await transition(cwd, task.id, 'VERIFYING', 'auto');

    // 5. 验证 → 全绿停 VERIFYING (等人工 accept), 有失败 FAILED
    if (verifyCommands.length === 0) {
      console.warn('⚠️ 未在 TASK.md 找到 Verification Commands, 使用默认验证 (typecheck+test+build)');
    }
    const commands = verifyCommands.length > 0 ? verifyCommands : DEFAULT_VERIFY;
    console.log('🔍 开始验证...');
    const verify = await runVerifyCommands(cwd, commands);
    task = await readTask(cwd, task.id);
    task.verify = verify;
    task.verification = verificationSummary(verify);
    task.updatedAt = new Date().toISOString();
    await writeTask(cwd, task);

    const allPass = verify.every((r) => r.exitCode === 0);
    if (allPass) {
      console.log('✅ 验证全过, 下一步: htask accept');
    } else {
      await transition(cwd, task.id, 'FAILED', 'auto');
      console.error('❌ 验证有失败项:');
      verify
        .filter((r) => r.exitCode !== 0)
        .forEach((r) => console.error(`   ❌ ${r.command} (exit ${r.exitCode})`));
      console.log('下一步: 修复后重试或人工介入');
    }

    // 6. REPORT.md (含状态机信息)
    await writeReport(cwd, await readTask(cwd, task.id));
    console.log(`📝 REPORT.md 已生成 (状态: ${allPass ? 'VERIFYING' : 'FAILED'})`);
    return { ok: allPass, reason: allPass ? null : 'verify-failed' };
  } catch (err) {
    console.error(`❌ htask start 失败: ${err.message}`);
    if (task?.id) {
      try {
        const cur = await readTask(cwd, task.id);
        if (cur && !TERMINAL.has(cur.status)) await transition(cwd, task.id, 'FAILED', 'auto');
      } catch {
        /* 静默 */
      }
    }
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

// ---------- 命令: accept ----------

export async function cmdAccept({ cwd, id }) {
  const task = await resolveTask(cwd, id);
  if (!task) return { ok: false, reason: 'no-task' };
  if (task.status !== 'VERIFYING') {
    console.error(`❌ 拒绝: 任务状态是 ${task.status}, 只有 VERIFYING 可 accept`);
    process.exitCode = 1;
    return { ok: false, reason: 'wrong-state' };
  }
  const verify = task.verify ?? [];
  if (!verify.every((r) => r.exitCode === 0)) {
    console.error('❌ 拒绝: 验证未全过, 任务应处于 FAILED, 需人工介入');
    process.exitCode = 1;
    return { ok: false, reason: 'verify-failed' };
  }
  await transition(cwd, task.id, 'ACCEPTED', 'human');
  console.log(`✅ ${task.id} → ACCEPTED, 下一步: htask merge`);
  return { ok: true };
}

// ---------- 命令: merge ----------

export async function cmdMerge({ cwd, id, noPush }) {
  const task = await resolveTask(cwd, id);
  if (!task) return { ok: false, reason: 'no-task' };
  if (task.status !== 'ACCEPTED') {
    console.error(`❌ 拒绝: 任务状态是 ${task.status}, 只有 ACCEPTED 可 merge`);
    process.exitCode = 1;
    return { ok: false, reason: 'wrong-state' };
  }

  const add = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf8' });
  if (add.status !== 0) {
    console.error(`❌ git add 失败 (状态不变):\n${add.stderr ?? add.stdout ?? ''}`);
    process.exitCode = 1;
    return { ok: false, reason: 'commit-failed' };
  }
  const commit = spawnSync('git', ['commit', '-m', String(task.title), '--no-verify'], {
    cwd,
    encoding: 'utf8',
  });
  if (commit.status !== 0) {
    console.error(`❌ git commit 失败 (状态不变):\n${commit.stderr ?? commit.stdout ?? ''}`);
    process.exitCode = 1;
    return { ok: false, reason: 'commit-failed' };
  }
  console.log(`✅ git commit: ${task.title}`);

  await transition(cwd, task.id, 'MERGED', 'human');

  if (noPush) {
    console.log('跳过 git push (--no-push)');
  } else {
    const push = spawnSync('git', ['push'], { cwd, encoding: 'utf8' });
    if (push.status !== 0) {
      console.warn(`⚠️ git push 失败 (任务已 MERGED):\n${push.stderr ?? push.stdout ?? ''}`);
    } else {
      console.log('✅ git push 成功');
    }
  }
  return { ok: true };
}

// ---------- 命令: cancel ----------

export async function cmdCancel({ cwd, id }) {
  const task = await resolveTask(cwd, id);
  if (!task) return { ok: false, reason: 'no-task' };
  if (TERMINAL.has(task.status)) {
    console.error(`❌ 拒绝: ${task.status} 是终态, 不能取消`);
    process.exitCode = 1;
    return { ok: false, reason: 'terminal' };
  }
  await transition(cwd, task.id, 'CANCELLED', 'human');
  console.log(`🚫 ${task.id} → CANCELLED`);
  return { ok: true };
}

// ---------- 命令: status / list ----------

function printTaskDetail(task) {
  const stale = staleInfo(task);
  console.log(`状态: ${task.status}${stale ? ` ⚠️ 卡住 (${stale.reason})` : ''}`);
  console.log(`任务: ${task.id}`);
  console.log(`标题: ${task.title ?? '-'}`);
  console.log(
    `任务文件: ${task.taskFile ?? '-'} · 模型: ${task.model ?? '-'}${task.agent ? ` · agent: ${task.agent}` : ''}`
  );
  console.log(
    `开始: ${task.startedAt ?? '-'} · 更新: ${task.updatedAt ?? '-'}${task.endedAt ? ` · 结束: ${task.endedAt}` : ''}`
  );
  if (task.implementExit !== undefined && task.implementExit !== null) {
    console.log(`实现: exit ${task.implementExit} (${fmtDuration(task.implementDurationMs)})`);
  }
  if (Array.isArray(task.verify) && task.verify.length > 0) {
    const pass = task.verify.filter((r) => r.exitCode === 0).length;
    console.log(`验证: ${task.verify.length} 条, 通过 ${pass}`);
  }
  if (task.review) console.log(`review: ${task.review}`);
  console.log(`下一步: ${nextStep(task)}`);
  console.log('迁移历史:');
  (task.history ?? []).forEach((h, i) => {
    const from = h.from ? `${h.from} → ` : '';
    console.log(`  ${i + 1}. ${from}${h.to} (${h.by}, ${h.at})`);
  });
}

export async function cmdStatus({ cwd, id, all }) {
  if (all) {
    await cmdList({ cwd });
    return;
  }
  const task = id ? await readTask(cwd, id) : await currentTask(cwd);
  if (!task) {
    if (id) {
      console.error(`❌ 任务不存在: ${id}`);
      process.exitCode = 1;
    } else {
      console.log('状态: idle');
    }
    return;
  }
  printTaskDetail(task);
}

export async function cmdList({ cwd }) {
  const tasks = await readAllTasks(cwd);
  if (tasks.length === 0) {
    console.log('(无任务记录)');
    return;
  }
  const pad = (s, n) => {
    s = String(s ?? '');
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
  };
  const rows = tasks.map((t) => {
    const stale = staleInfo(t);
    return {
      id: String(t.id ?? '-'),
      title: String(t.title ?? '-'),
      status: String(t.status ?? '-'),
      dwell: fmtDuration(dwellMs(t)),
      stale: stale ? `⚠️ 卡住 (${stale.reason})` : TERMINAL.has(t.status) ? '' : '',
    };
  });
  const w = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    title: Math.max(4, ...rows.map((r) => r.title.length)),
    status: Math.max(4, ...rows.map((r) => r.status.length)),
    dwell: Math.max(4, ...rows.map((r) => r.dwell.length)),
  };
  console.log(`${pad('ID', w.id)}  ${pad('标题', w.title)}  ${pad('状态', w.status)}  ${pad('停留', w.dwell)}  卡住`);
  for (const r of rows) {
    console.log(`${pad(r.id, w.id)}  ${pad(r.title, w.title)}  ${pad(r.status, w.status)}  ${pad(r.dwell, w.dwell)}  ${r.stale}`);
  }
}

// ---------- 命令: report ----------

export async function cmdReport({ cwd }) {
  const task = await currentTask(cwd);
  if (!task) {
    console.error('❌ 没有任务记录, 无法生成 REPORT.md');
    process.exitCode = 1;
    return;
  }
  await writeReport(cwd, task);
  console.log('📝 REPORT.md 已根据已有状态重新生成');
}

// ---------- CLI 入口 ----------

function printHelp() {
  console.log(`htask — Hermes Task Runner: TASK.md → OpenCode 实现 → 验证 → REPORT.md 全链路自动化
状态机: CREATED → PLANNING → IMPLEMENTING → REVIEWING → VERIFYING → ACCEPTED → MERGED (FAILED / CANCELLED)

用法:
  htask start [--model <provider/model>] [--agent <agent>] [--review] [--id <id>] [TASK.md]
  htask status [--id <id> | --all]
  htask list
  htask accept [--id <id>]
  htask merge [--id <id>] [--no-push]
  htask cancel [--id <id>]
  htask report
  htask --help

选项:
  --model <provider/model>   覆盖模型 (默认 ${DEFAULT_MODEL})
  --agent <agent>            指定 opencode agent
  --review                   验证通过后运行 reviewer agent 生成 REVIEW.md
  --id <id>                  指定任务 id (默认当前任务)
  --all                      列出所有任务
  --no-push                  merge 时跳过 git push

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
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--model') opts.model = rest[++i];
    else if (a === '--agent') opts.agent = rest[++i];
    else if (a === '--review') opts.review = true;
    else if (a === '--id') opts.id = rest[++i];
    else if (a === '--all') opts.all = true;
    else if (a === '--no-push') opts.noPush = true;
    else opts.taskFile = a;
  }

  switch (cmd) {
    case 'start':
      await cmdStart({ cwd, taskFile: opts.taskFile || 'TASK.md', model: opts.model, agent: opts.agent, review: opts.review, id: opts.id });
      break;
    case 'status':
      await cmdStatus({ cwd, id: opts.id, all: opts.all });
      break;
    case 'list':
      await cmdList({ cwd });
      break;
    case 'accept':
      await cmdAccept({ cwd, id: opts.id });
      break;
    case 'merge':
      await cmdMerge({ cwd, id: opts.id, noPush: opts.noPush });
      break;
    case 'cancel':
      await cmdCancel({ cwd, id: opts.id });
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
