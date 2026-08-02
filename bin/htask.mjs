#!/usr/bin/env node
// htask — Hermes Task Runner
// 把「TASK.md → OpenCode 实现 → 完成通知 → 验证 → REPORT」整条链自动化成一条命令,
// 并给每个任务引入生命周期状态机 (CREATED → ... → MERGED), 升级为 orchestrator。
// 零 npm 依赖: 只用 node 内置模块。

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_VERIFY = ['npm run typecheck', 'npm test', 'npm run build'];
const VERIFY_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT = 2000;

// 内置保护: merge/advance 提交时排除的运行产物 (不依赖项目 .gitignore 配置)
// 含 .htask/ 状态目录 — 任何项目用 htask 都不会把状态/日志/报告污染进 commit
export const MERGE_EXCLUDE = ['REPORT.md', 'REVIEW.md', '.htask'];

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
  FAILED: ['PLANNING'], // retry --fix: 允许从终态回到规划重新实现
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

// 分诊状态 (给 Hermes 的决策信号): RUNNING / WAITING_HUMAN / BLOCKED / DONE / STALE
// 纯函数, 不依赖额外 IO。STALE 覆盖任意非终态 (终态不标 stale)。
export function deriveState(task) {
  const status = task?.status;
  if (status === 'MERGED') return 'DONE';
  if (status === 'FAILED' || status === 'CANCELLED') return 'BLOCKED';
  if (status === 'VERIFYING') {
    if (staleInfo(task)) return 'STALE';
    const verify = task.verify ?? [];
    return verify.every((r) => r.exitCode === 0) ? 'WAITING_HUMAN' : 'BLOCKED';
  }
  if (status === 'ACCEPTED') return staleInfo(task) ? 'STALE' : 'WAITING_HUMAN';
  if (status === 'CREATED') return staleInfo(task) ? 'STALE' : 'WAITING_HUMAN';
  if (status === 'PLANNING' || status === 'IMPLEMENTING' || status === 'REVIEWING') {
    return staleInfo(task) ? 'STALE' : 'RUNNING';
  }
  return 'BLOCKED';
}

// advance 跳过时的原因 (人类可读)
function skipReason(task) {
  switch (task?.status) {
    case 'CREATED':
      return '未开始, 请先 htask start';
    case 'PLANNING':
      return '规划中';
    case 'IMPLEMENTING':
      return '等待 opencode 完成';
    case 'REVIEWING':
      return '等待 reviewer 完成';
    case 'FAILED':
      return '任务失败, 需修复后重试';
    case 'CANCELLED':
      return '任务已取消';
    default:
      return deriveState(task) === 'STALE' ? `已卡住: ${staleInfo(task)?.reason}` : '状态不可自动推进';
  }
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

// ---------- Artifact Bundle ----------

// 每任务独立产物目录 .htask/artifacts/<taskId>/: TASK.md/PLAN.md/REVIEW.md/REPORT.md/
// diff.patch/metrics.json/timeline.json。artifacts 是衍生产物 (非状态源), 删掉可随时重建。

export function artifactDir(cwd, taskId) {
  return path.join(cwd, '.htask', 'artifacts', taskId);
}

// 确保产物目录存在 (状态变更时缺失会自动重建), 返回目录路径
export function ensureArtifactDir(cwd, taskId) {
  const dir = artifactDir(cwd, taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// timeline.json: 与 tasks/<id>.json 的 history 同步, 冗余一份供复盘
export async function writeTimeline(cwd, task) {
  if (!task?.id) return;
  try {
    const dir = ensureArtifactDir(cwd, task.id);
    const history = Array.isArray(task.history) ? task.history : [];
    await writeFile(path.join(dir, 'timeline.json'), JSON.stringify(history, null, 2) + '\n');
  } catch (err) {
    console.warn(`⚠️ 写入 timeline.json 失败: ${err.message}`);
  }
}

// metrics.json: durationMs 从 startedAt 算 (未终态按当前时刻), model/agent 取自任务字段
export async function writeMetrics(cwd, task) {
  if (!task?.id) return;
  const started = task.startedAt ? new Date(task.startedAt).getTime() : null;
  const ended = task.endedAt ? new Date(task.endedAt).getTime() : null;
  const metrics = {
    durationMs: started ? Math.max(0, (ended ?? Date.now()) - started) : null,
    tokens: task.tokens ?? null,
    iterations: task.iterations ?? null,
    model: task.model ?? null,
    agent: task.agent ?? null,
  };
  try {
    const dir = ensureArtifactDir(cwd, task.id);
    await writeFile(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  } catch (err) {
    console.warn(`⚠️ 写入 metrics.json 失败: ${err.message}`);
  }
}

// ---------- Event System ----------

// 追加事件到 .htask/events.jsonl (JSON Lines), 并调用可选的订阅钩子。
// 钩子: .htask/hooks/on-<type> 存在且可执行时 spawn, 参数=事件 JSON, cwd=项目根。
// 钩子失败仅 warn 不阻断主流程。
export function emitEvent(cwd, event) {
  const record = { ts: new Date().toISOString(), ...event };
  try {
    mkdirSync(path.join(cwd, '.htask'), { recursive: true });
    appendFileSync(path.join(cwd, '.htask', 'events.jsonl'), JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn(`⚠️ 写入事件失败: ${err.message}`);
  }
  const hook = path.join(cwd, '.htask', 'hooks', `on-${record.type}`);
  try {
    accessSync(hook, constants.X_OK);
  } catch {
    return; // 钩子不存在或不可执行
  }
  try {
    const child = spawn(hook, [JSON.stringify(record)], { cwd, stdio: 'ignore' });
    child.on('error', (err) => console.warn(`⚠️ hook ${hook} 执行失败: ${err.message}`));
    child.on('exit', (code) => {
      if (code !== 0) console.warn(`⚠️ hook ${hook} 退出码 ${code}`);
    });
  } catch (err) {
    console.warn(`⚠️ hook 执行失败: ${err.message}`);
  }
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
    agentBackend: meta.agentBackend ?? null,
    model: meta.model ?? DEFAULT_MODEL,
    taskFile: meta.taskFile ?? 'TASK.md',
    plan: null,
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
  ensureArtifactDir(cwd, id);
  emitEvent(cwd, { type: 'task.created', taskId: task.id, title: task.title });
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
  if (TERMINAL.has(from)) task.endedAt = null; // 离开终态 (retry) 清除结束时间
  if (TERMINAL.has(to)) task.endedAt = task.endedAt ?? task.updatedAt;
  await writeTask(cwd, task);
  await writeTimeline(cwd, task);
  if (TERMINAL.has(to)) {
    await writeMetrics(cwd, task);
    emitEvent(cwd, { type: 'task.completed', taskId: id, status: to });
  }
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

// ---------- Task Planner ----------

// 纯规则任务分析 (零依赖, 不用 LLM — 保持可测可离线):
//   complexity: high (架构|重构|迁移|安全|认证|oauth|数据库|schema 或 >3000 字)
//               medium (功能|接口|api|测试|工具 或 1000-3000 字) / low (其他)
//   risk: security/database/api/dependency 关键字命中集合
//   pipeline: 按 complexity 生成, risk 含 security → 插 security-reviewer, 含 database → 插 schema-check
export function analyzeTask(md) {
  const text = String(md ?? '');
  const len = text.length;

  let complexity = 'low';
  if (/架构|重构|迁移|安全|认证|oauth|数据库|schema/.test(text) || len > 3000) {
    complexity = 'high';
  } else if (/功能|接口|api|测试|工具/.test(text) || (len >= 1000 && len <= 3000)) {
    complexity = 'medium';
  }

  const risk = [];
  if (/安全|认证|oauth|注入|权限/.test(text)) risk.push('security');
  if (/数据库|schema|迁移|migration/.test(text)) risk.push('database');
  if (/接口|api|路由/.test(text)) risk.push('api');
  if (/依赖|引入|require/.test(text)) risk.push('dependency');

  let pipeline;
  if (complexity === 'high') pipeline = ['architect', 'developer', 'security-reviewer', 'tester'];
  else if (complexity === 'medium') pipeline = ['developer', 'reviewer', 'tester'];
  else pipeline = ['developer', 'tester'];

  const insertAfter = (arr, ref, item) => {
    const i = arr.indexOf(ref);
    arr.splice(i === -1 ? arr.length : i + 1, 0, item);
    return arr;
  };
  if (risk.includes('security') && !pipeline.includes('security-reviewer')) {
    insertAfter(pipeline, 'developer', 'security-reviewer');
  }
  if (risk.includes('database') && !pipeline.includes('schema-check')) {
    insertAfter(pipeline, 'developer', 'schema-check');
  }

  const estimated =
    complexity === 'high'
      ? { files: 6, minutes: 40 }
      : complexity === 'medium'
        ? { files: 4, minutes: 25 }
        : { files: 2, minutes: 10 };

  return {
    complexity,
    risk,
    pipeline,
    estimated,
    suggestModel: DEFAULT_MODEL,
    suggestReview: complexity !== 'low' || risk.length > 0,
  };
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

// 通用 agent spawn: 命令/输出追加到 .htask/<logName>, 退出时 resolve {exitCode, durationMs}
function spawnAgentCmd(cwd, cmd, fullArgs, logName, extraEnv = {}) {
  return new Promise((resolve) => {
    const logPath = path.join(cwd, '.htask', logName);
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

    const child = spawn(cmd, fullArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // agent 内部跑命令用 $SHELL; zsh 加载 .zshrc 会产生 direnv/zoxide/starship 噪音
      // (nix shell PATH 下找不到) — 统一用 bash, 输出干净
      env: { ...process.env, SHELL: process.env.HTASK_SHELL || '/bin/bash', ...extraEnv },
    });
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

// 兼容层: 直接跑 opencode 命令 (HTASK_OPENCODE_CMD / ARGS_PREFIX 走原路径)
export function spawnOpenCode(cwd, args, prompt, logName = 'implement.log') {
  const cmd = process.env.HTASK_OPENCODE_CMD || 'opencode';
  return spawnAgentCmd(cwd, cmd, [...args, prompt], logName);
}

// ---------- Agent Adapter Layer ----------

// 内置适配器表 (可扩展): 多后端抽象, 未安装的后端标 available:false, 选用时报清晰错误。
// 自定义适配器: .htask/agent.<name>.json 覆盖内置同名条目 (零依赖, JSON 定义)。
export const AGENT_ADAPTERS = {
  opencode: {
    name: 'opencode',
    display: 'OpenCode',
    available: true,
    runCmd: ['opencode', 'run', '--pure'],
    modelFlag: '-m',
    agentFlag: '--agent',
    env: { SHELL: '/bin/bash' },
  },
  codex: {
    name: 'codex',
    display: 'Codex',
    available: false,
    runCmd: ['codex', 'exec'],
    modelFlag: '-m',
    agentFlag: null,
    env: {},
  },
  claude: {
    name: 'claude',
    display: 'Claude',
    available: false,
    runCmd: ['claude'],
    modelFlag: '--model',
    agentFlag: null,
    env: {},
  },
};

export function availableAgentNames() {
  return Object.keys(AGENT_ADAPTERS).filter((k) => AGENT_ADAPTERS[k].available);
}

// 读 .htask/agent.<name>.json 自定义适配器 (存在才返回, 否则 null)
export function loadCustomAgentAdapter(cwd, name) {
  try {
    const raw = readFileSync(path.join(cwd, '.htask', `agent.${name}.json`), 'utf8');
    const def = JSON.parse(raw);
    if (def && typeof def === 'object' && def.name) return def;
  } catch {
    /* 无自定义适配器 */
  }
  return null;
}

// 查适配器表 (自定义优先), 未知返回 null
export function getAgentAdapter(cwd, name) {
  return loadCustomAgentAdapter(cwd, name) || AGENT_ADAPTERS[name] || null;
}

// 校验后端可用性: 返回 { ok, backend, adapter } 或 { ok:false, backend, error }
export function resolveAgentBackend(cwd, explicit) {
  const backend = explicit || process.env.HTASK_AGENT || 'opencode';
  const adapter = getAgentAdapter(cwd, backend);
  if (!adapter) return { ok: false, backend, error: 'unknown' };
  if (!adapter.available) return { ok: false, backend, error: 'unavailable' };
  return { ok: true, backend, adapter };
}

function reportAgentUnavailable(backend) {
  console.error(`❌ agent 后端 '${backend}' 未安装 (可用: ${availableAgentNames().join(', ')})`);
  process.exitCode = 1;
}

// 按适配器组装参数: runCmd + modelFlag/agentFlag + prompt
export function buildAgentArgs(adapter, { model, agent } = {}) {
  const args = [...adapter.runCmd];
  if (model) args.push(adapter.modelFlag, model);
  if (agent && adapter.agentFlag) args.push(adapter.agentFlag, agent);
  return args;
}

// 统一 agent 执行入口: 查适配器表 → 组装参数 → spawn 并追加日志。
// 未安装后端 → 清晰报错 (退出码 1), 不尝试执行。
// HTASK_OPENCODE_CMD / HTASK_OPENCODE_ARGS_PREFIX 设置时直接走原 opencode 路径 (向后兼容)。
export async function runAgent(cwd, backend, { model, agent } = {}, prompt, logName = 'implement.log') {
  if (process.env.HTASK_OPENCODE_CMD || process.env.HTASK_OPENCODE_ARGS_PREFIX) {
    return spawnOpenCode(cwd, buildOpenCodeArgs({ model, agent }), prompt, logName);
  }
  const adapter = getAgentAdapter(cwd, backend);
  if (!adapter || !adapter.available) {
    reportAgentUnavailable(backend);
    return { exitCode: -1, durationMs: 0, error: 'unavailable' };
  }
  const fullArgs = [...buildAgentArgs(adapter, { model, agent }), prompt];
  return spawnAgentCmd(cwd, adapter.runCmd[0], fullArgs, logName, adapter.env);
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

  const content = lines.join('\n') + '\n';
  await writeFile(path.join(cwd, 'REPORT.md'), content);
  if (ctx.id) {
    try {
      await writeFile(path.join(ensureArtifactDir(cwd, ctx.id), 'REPORT.md'), content);
    } catch (err) {
      console.warn(`⚠️ 写入 artifacts REPORT.md 失败: ${err.message}`);
    }
  }
  await writeMetrics(cwd, ctx);
}

// ---------- 命令: start ----------

export async function cmdStart({ cwd, taskFile, model, agent, review, id, noReview, agentBackend }) {
  const ht = path.join(cwd, '.htask');
  const lock = path.join(ht, 'state.lock');
  await mkdir(ht, { recursive: true });

  // 校验 agent 后端可用性 (未安装/未知 → 清晰报错, 不创建任务)
  const backend = resolveAgentBackend(cwd, agentBackend);
  if (!backend.ok) {
    reportAgentUnavailable(backend.backend);
    return { ok: false, reason: 'agent-unavailable' };
  }

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
      agentBackend: backend.backend,
      taskFile: path.basename(taskFile),
    });

    // 1.5 自动 Planner: 写 state.plan + artifacts (TASK.md 副本 / PLAN.md), 并按建议定默认 review
    const plan = md ? analyzeTask(md) : null;
    if (plan) {
      task.plan = plan;
      await writeTask(cwd, task);
    }
    try {
      const aDir = ensureArtifactDir(cwd, task.id);
      if (md) await writeFile(path.join(aDir, 'TASK.md'), md);
      if (plan) await writeFile(path.join(aDir, 'PLAN.md'), JSON.stringify(plan, null, 2) + '\n');
    } catch (err) {
      console.warn(`⚠️ 写入 artifacts 失败: ${err.message}`);
    }
    const useReview = !!review || (!!plan?.suggestReview && !noReview);
    if (plan) {
      console.log(`📋 计划: complexity=${plan.complexity}, risk=[${plan.risk.join(', ')}], pipeline=[${plan.pipeline.join(', ')}]`);
    }

    // 2. 解析 TASK.md → 成功 PLANNING, 失败 FAILED
    if (parseError) {
      console.error(`❌ 解析 TASK.md 失败: ${parseError.message}`);
      await transition(cwd, task.id, 'FAILED', 'auto');
      await writeReport(cwd, await readTask(cwd, task.id));
      return { ok: false, reason: 'parse-error' };
    }
    const { verifyCommands } = parseTaskFile(md);

    // 3. IMPLEMENTING → spawn agent
    await transition(cwd, task.id, 'PLANNING', 'auto');
    await transition(cwd, task.id, 'IMPLEMENTING', 'auto');
    emitEvent(cwd, { type: 'task.started', taskId: task.id, status: 'IMPLEMENTING' });
    console.log(
      `▶️  启动实现: ${path.basename(taskFile)} (model=${task.model}${agent ? `, agent=${agent}` : ''}${backend.backend !== 'opencode' ? `, backend=${backend.backend}` : ''})`
    );
    const logName = `logs/${task.id}.log`;
    const implement = await runAgent(
      cwd,
      backend.backend,
      { model, agent },
      `按 ${path.basename(taskFile)} 实现，完成后总结`,
      logName
    );
    task = await readTask(cwd, task.id);
    task.implementExit = implement.exitCode;
    task.implementDurationMs = implement.durationMs;
    task.updatedAt = new Date().toISOString();
    await writeTask(cwd, task);

    notify(
      implement.exitCode === 0 ? '✅ Agent 完成' : '❌ Agent 失败',
      `exit ${implement.exitCode} · 耗时 ${fmtDuration(implement.durationMs)}`
    );

    if (implement.exitCode !== 0) {
      await transition(cwd, task.id, 'FAILED', 'auto');
      console.error(`❌ agent 退出码 ${implement.exitCode}, 任务已 FAILED (日志: .htask/${logName})`);
      await writeReport(cwd, await readTask(cwd, task.id));
      return { ok: false, reason: 'implement-failed' };
    }

    // 4. --review → REVIEWING → reviewer → 记录 review 结果 → VERIFYING
    if (useReview) {
      await transition(cwd, task.id, 'REVIEWING', 'auto');
      console.log('🧐 运行 reviewer agent...');
      const revLog = `logs/${task.id}.review.log`;
      const rev = await runAgent(
        cwd,
        backend.backend,
        { model, agent: 'reviewer' },
        '按 .templates/REVIEW.md 模板独立验收本次实现并生成 REVIEW.md',
        revLog
      );
      task = await readTask(cwd, task.id);
      task.review = rev.exitCode === 0 ? 'passed' : 'failed';
      await writeTask(cwd, task);
      if (rev.exitCode !== 0) {
        console.warn(`⚠️ reviewer 退出码 ${rev.exitCode}, 详见 .htask/${revLog}`);
        emitEvent(cwd, { type: 'task.review_failed', taskId: task.id });
      }
      try {
        const reviewSrc = path.join(cwd, 'REVIEW.md');
        if (existsSync(reviewSrc)) {
          const dest = path.join(ensureArtifactDir(cwd, task.id), 'REVIEW.md');
          await writeFile(dest, await readFile(reviewSrc, 'utf8'));
        }
      } catch (err) {
        console.warn(`⚠️ 复制 REVIEW.md 到 artifacts 失败: ${err.message}`);
      }
    }
    await transition(cwd, task.id, 'VERIFYING', 'auto');
    emitEvent(cwd, { type: 'task.verifying', taskId: task.id });

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
      emitEvent(cwd, { type: 'task.waiting_human', taskId: task.id, reason: 'accept' });
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
  emitEvent(cwd, { type: 'task.waiting_human', taskId: task.id, reason: 'merge' });
  console.log(`✅ ${task.id} → ACCEPTED, 下一步: htask merge`);
  return { ok: true };
}

// ---------- 命令: merge ----------

// 在 git add 后、commit 前取消暂存内置保护文件 (仅排除, 不删除工作区文件)。
// git reset 不存在的文件也会 exit 0 (no-op), 无需检查存在性。
function unstageExcluded(cwd) {
  for (const f of MERGE_EXCLUDE) {
    const r = spawnSync('git', ['reset', '--', f], { cwd, encoding: 'utf8' });
    if (r.status !== 0) console.warn(`⚠️ git reset ${f} 失败 (已忽略): ${(r.stderr ?? '').trim()}`);
  }
}

// merge 时生成 git diff 快照到 artifacts/<id>/diff.patch (暂存+工作区 vs HEAD, 排除内置保护文件)。
// 需在 git add -A 之后调用, 否则新建文件 (untracked) 不会出现在 diff 里。
async function writeDiffPatch(cwd, task) {
  if (!task?.id) return;
  try {
    const dir = ensureArtifactDir(cwd, task.id);
    const excludes = MERGE_EXCLUDE.map((f) => `:(exclude)${f}`);
    const diff = spawnSync('git', ['diff', 'HEAD', '--', '.', ...excludes], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const content = diff.status === 0 ? (diff.stdout ?? '') : `[git diff 失败: ${(diff.stderr ?? '').trim()}]`;
    await writeFile(path.join(dir, 'diff.patch'), content);
  } catch (err) {
    console.warn(`⚠️ 生成 diff.patch 失败: ${err.message}`);
  }
}

// git add/commit/push + transition MERGED, 供 cmdMerge / cmdAdvance 复用。
// json 模式下进度消息走 stderr, 保持 stdout 只有 JSON。
export async function doMerge(cwd, task, { noPush = false, by = 'human', json = false } = {}) {
  const out = json ? console.error : console.log;
  const warn = console.warn;
  const add = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf8' });
  if (add.status !== 0) {
    console.error(`❌ git add 失败 (状态不变):\n${add.stderr ?? add.stdout ?? ''}`);
    process.exitCode = 1;
    return { ok: false, reason: 'commit-failed' };
  }
  unstageExcluded(cwd);
  await writeDiffPatch(cwd, task);
  const commit = spawnSync('git', ['commit', '-m', String(task.title), '--no-verify'], {
    cwd,
    encoding: 'utf8',
  });
  if (commit.status !== 0) {
    const detail = (commit.stderr || commit.stdout || '').trim();
    // 无代码改动 (工作树 clean) 不算失败: 任务仍算完成, 仅归档状态
    if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(detail)) {
      console.warn('⚠️ 无代码改动 (工作树 clean), 仅归档任务状态');
    } else {
      console.error(`❌ git commit 失败 (状态不变):\n${detail}`);
      process.exitCode = 1;
      return { ok: false, reason: 'commit-failed' };
    }
  } else {
    out(`✅ git commit: ${task.title}`);
  }

  await transition(cwd, task.id, 'MERGED', by);

  if (noPush) {
    out('跳过 git push (--no-push)');
  } else {
    const push = spawnSync('git', ['push'], { cwd, encoding: 'utf8' });
    if (push.status !== 0) {
      warn(`⚠️ git push 失败 (任务已 MERGED):\n${push.stderr ?? push.stdout ?? ''}`);
    } else {
      out('✅ git push 成功');
    }
  }
  return { ok: true };
}

export async function cmdMerge({ cwd, id, noPush }) {
  const task = await resolveTask(cwd, id);
  if (!task) return { ok: false, reason: 'no-task' };
  if (task.status !== 'ACCEPTED') {
    console.error(`❌ 拒绝: 任务状态是 ${task.status}, 只有 ACCEPTED 可 merge`);
    process.exitCode = 1;
    return { ok: false, reason: 'wrong-state' };
  }
  return doMerge(cwd, task, { noPush, by: 'human' });
}

// ---------- 命令: advance ----------

// 自动推进可自动的迁移: VERIFYING(全过) → ACCEPTED → MERGED; ACCEPTED → MERGED。
// 其余状态幂等跳过 (退出码 0); 验证失败拒绝 (退出码 1); 无任务报错 (退出码 1)。
export async function cmdAdvance({ cwd, id, noPush, json = false }) {
  const task = await resolveTask(cwd, id);
  if (!task) {
    if (json) {
      console.log(
        JSON.stringify(
          { id: id ?? null, status: null, state: 'NOT_FOUND', action: 'none', message: '没有当前任务或任务不存在' },
          null,
          2
        )
      );
    }
    return { ok: false, reason: 'no-task' };
  }
  const out = json ? console.error : console.log;

  // 幂等: 已 MERGED → 无操作
  if (task.status === 'MERGED') {
    const msg = `⏸ ${task.id} 已是终态 (MERGED), 无操作`;
    if (json) console.log(JSON.stringify({ id: task.id, status: 'MERGED', state: 'DONE', action: 'none', message: msg }, null, 2));
    else out(msg);
    return { ok: true, action: 'none' };
  }

  if (task.status === 'VERIFYING') {
    const verify = task.verify ?? [];
    if (!verify.every((r) => r.exitCode === 0)) {
      console.error(`❌ ${task.id} 验证未全过, 需修复 (保持 ${task.status})`);
      process.exitCode = 1;
      if (json) {
        console.log(
          JSON.stringify(
            { id: task.id, status: 'VERIFYING', state: 'BLOCKED', action: 'none', message: '验证未全过, 需修复' },
            null,
            2
          )
        );
      }
      return { ok: false, reason: 'verify-failed' };
    }
    // 审批策略闸门: 仅对 Planner 分析过的任务 (有 plan.risk) 生效;
    // 无 plan (旧任务/手工构造) 保持原自动推进行为 (向后兼容)。
    if (task.plan) {
      const policy = await loadApprovalPolicy(cwd);
      const approval = approvalDecision({ risk: task.plan.risk ?? [], policy });
      if (approval === 'human') {
        const risky = (task.plan.risk ?? []).length > 0;
        const msg = `⏸ ${task.id} 停在 VERIFYING: ${risky ? '高风险任务' : '低风险但策略需人工'} 请运行 htask accept`;
        if (json) {
          console.log(
            JSON.stringify(
              { id: task.id, status: 'VERIFYING', state: 'WAITING_HUMAN', action: 'none', message: msg },
              null,
              2
            )
          );
        } else {
          out(msg);
        }
        return { ok: true, action: 'none' };
      }
    }
    await transition(cwd, task.id, 'ACCEPTED', 'auto');
    out(`✅ ${task.id}: VERIFYING → ACCEPTED${task.plan ? ' (自动过闸)' : ''}`);
    // 落到 ACCEPTED 分支继续
  }

  const cur = await readTask(cwd, task.id);
  if (cur.status === 'ACCEPTED') {
    const res = await doMerge(cwd, cur, { noPush, by: 'auto', json });
    if (res.ok) {
      const msg = `✅ ${cur.id} → MERGED, 全链路自动完成`;
      if (json) console.log(JSON.stringify({ id: cur.id, status: 'MERGED', state: 'DONE', action: 'merged', message: msg }, null, 2));
      else out(msg);
      return { ok: true, action: 'merged' };
    }
    const msg = `⏸ ${cur.id} 停在 ACCEPTED: ${res.reason === 'commit-failed' ? 'git commit 失败, 请检查' : res.reason}`;
    if (json) {
      console.log(JSON.stringify({ id: cur.id, status: 'ACCEPTED', state: 'WAITING_HUMAN', action: 'accepted', message: msg }, null, 2));
    } else {
      out(msg);
    }
    return { ok: false, reason: res.reason };
  }

  // 其他状态: 幂等跳过, 打印 state + 原因, 退出码 0
  const state = deriveState(cur);
  const msg = `⏸ ${cur.id} 停在 ${cur.status}: ${skipReason(cur)}`;
  if (json) console.log(JSON.stringify({ id: cur.id, status: cur.status, state, action: 'none', message: msg }, null, 2));
  else out(msg);
  return { ok: true, action: 'none' };
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

// ---------- 命令: retry (Failure Recovery) ----------

// 读取失败日志尾部 (最后 N 行, 优先任务专属日志, 回退 implement.log)
function readLogTail(cwd, taskId, n = 15) {
  const candidates = [path.join(cwd, '.htask', 'logs', `${taskId}.log`), path.join(cwd, '.htask', 'implement.log')];
  for (const p of candidates) {
    try {
      const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      if (lines.length > 0) return lines.slice(-n);
    } catch {
      /* 尝试下一个 */
    }
  }
  return [];
}

// 无 --fix: 输出失败诊断 (实现/验证/日志尾部/建议)
export function printDiagnosis(cwd, task) {
  const failedVerify = (task.verify ?? []).filter((r) => r.exitCode !== 0);
  console.log(`🔍 失败诊断: ${task.id} (FAILED)`);
  console.log(`- 实现: exit ${task.implementExit ?? '-'} (${fmtDuration(task.implementDurationMs)})`);
  if ((task.verify ?? []).length === 0) {
    console.log('- 验证: (未执行)');
  } else if (failedVerify.length === 0) {
    console.log(`- 验证: ${task.verify.length} 条全部通过`);
  } else {
    const first = failedVerify[0];
    console.log(`- 验证: ${task.verify.length} 条中 ${failedVerify.length} 条失败 → ${first.command} (exit ${first.exitCode})`);
  }
  const tail = readLogTail(cwd, task.id);
  if (tail.length === 0) {
    console.log('- 日志尾部: (无日志)');
  } else {
    console.log(`- 日志尾部: ${tail[0]}`);
    for (const l of tail.slice(1)) console.log(`  ${l}`);
  }
  const advice = [];
  if (task.implementExit != null && task.implementExit !== 0) advice.push('实现阶段失败 → 检查 TASK.md 是否明确');
  if (failedVerify.length > 0) advice.push('验证失败 → 修复代码或调整验证命令');
  console.log(`- 建议: ${advice.join('; ') || '检查任务状态与日志'}`);
  console.log('运行 htask retry --fix 自动修复, 或人工介入');
}

// retry --fix 的提示词: 携带上次失败上下文 (exit code + 失败命令输出摘要)
function buildRetryPrompt(task) {
  const lines = [`按 ${task.taskFile} 重新实现 (上次失败, 修复模式)。`, '', '## 上次失败上下文'];
  if (task.implementExit != null) {
    lines.push(`- 上次实现退出码: ${task.implementExit} (耗时 ${fmtDuration(task.implementDurationMs)})`);
  }
  const failedVerify = (task.verify ?? []).filter((r) => r.exitCode !== 0);
  if (failedVerify.length > 0) {
    lines.push('- 失败验证:');
    for (const r of failedVerify) {
      lines.push(`  - ${r.command} (exit ${r.exitCode})`);
      for (const o of String(r.output ?? '').split('\n').slice(0, 10)) {
        if (o.trim()) lines.push(`    ${o}`);
      }
    }
  }
  lines.push('', '请诊断失败原因并修复后重新实现, 不要重复已完成的部分, 完成后总结。');
  return lines.join('\n');
}

// 交互式 y/N 确认; 非 TTY 直接返回空 (视为取消)
function readStdinLine() {
  return new Promise((resolve) => {
    if (!process.stdin || !process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    const onData = (d) => {
      data += d;
      if (data.includes('\n')) {
        process.stdin.removeListener('data', onData);
        resolve(data);
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

// htask retry [--id <id>] [--fix] [--yes]:
//   无 --fix → 诊断输出; 有 --fix → 用当前 agent 重新实现, FAILED → PLANNING → IMPLEMENTING 重流转
export async function cmdRetry({ cwd, id, fix, yes }) {
  const task = await resolveTask(cwd, id);
  if (!task) return { ok: false, reason: 'no-task' };
  if (task.status !== 'FAILED') {
    console.error(`❌ 只能重试 FAILED 任务 (当前 ${task.status})`);
    process.exitCode = 1;
    return { ok: false, reason: 'wrong-state' };
  }
  emitEvent(cwd, { type: 'task.retrying', taskId: task.id });

  if (!fix) {
    printDiagnosis(cwd, task);
    return { ok: true };
  }

  if (!yes) {
    console.error('⚠️ 将重新运行 agent 修复, 确认? (y/N)');
    const ans = await readStdinLine();
    if (!/^y(es)?$/i.test(String(ans).trim())) {
      console.log('已取消');
      return { ok: false, reason: 'aborted' };
    }
  }

  // FAILED → PLANNING (retry) → IMPLEMENTING 重新流转 (历史追加, 不新建任务)
  await transition(cwd, task.id, 'PLANNING', 'retry');
  await transition(cwd, task.id, 'IMPLEMENTING', 'auto');
  emitEvent(cwd, { type: 'task.started', taskId: task.id, status: 'IMPLEMENTING' });

  const backend = task.agentBackend || process.env.HTASK_AGENT || 'opencode';
  const logName = `logs/${task.id}.log`;
  const implement = await runAgent(cwd, backend, { model: task.model, agent: task.agent }, buildRetryPrompt(task), logName);
  let cur = await readTask(cwd, task.id);
  cur.implementExit = implement.exitCode;
  cur.implementDurationMs = implement.durationMs;
  cur.updatedAt = new Date().toISOString();
  await writeTask(cwd, cur);

  if (implement.exitCode !== 0) {
    await transition(cwd, task.id, 'FAILED', 'auto');
    console.error(`❌ agent 退出码 ${implement.exitCode}, 任务仍 FAILED (日志: .htask/${logName})`);
    await writeReport(cwd, await readTask(cwd, task.id));
    return { ok: false, reason: 'implement-failed' };
  }

  // 重新验证 (沿用任务 TASK.md 的 Verification Commands)
  let verifyCommands = [];
  try {
    const taskFile = path.isAbsolute(task.taskFile) ? task.taskFile : path.join(cwd, task.taskFile);
    verifyCommands = parseTaskFile(await readFile(taskFile, 'utf8')).verifyCommands;
  } catch {
    /* 读取失败用默认验证 */
  }
  const commands = verifyCommands.length > 0 ? verifyCommands : DEFAULT_VERIFY;
  console.log('🔍 重新验证...');
  const verify = await runVerifyCommands(cwd, commands);
  cur = await readTask(cwd, task.id);
  cur.verify = verify;
  cur.verification = verificationSummary(verify);
  cur.updatedAt = new Date().toISOString();
  await writeTask(cwd, cur);

  const allPass = verify.every((r) => r.exitCode === 0);
  if (allPass) {
    await transition(cwd, task.id, 'VERIFYING', 'auto');
    console.log('✅ 验证全过, 任务回到 VERIFYING, 下一步: htask advance / accept');
    emitEvent(cwd, { type: 'task.verifying', taskId: task.id });
  } else {
    await transition(cwd, task.id, 'FAILED', 'auto');
    console.error('❌ 验证仍有失败项, 任务仍 FAILED');
  }
  await writeReport(cwd, await readTask(cwd, task.id));
  return { ok: allPass, reason: allPass ? null : 'verify-failed' };
}

// ---------- 命令: status / list ----------

// 单任务 JSON 序列化 (供 status --json)
export function taskToJson(task) {
  const stale = staleInfo(task);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    state: deriveState(task),
    taskFile: task.taskFile,
    model: task.model,
    agent: task.agent ?? null,
    agentBackend: task.agentBackend ?? null,
    review: task.review ?? null,
    verification: task.verification ?? verificationSummary(task.verify ?? []),
    verify: (task.verify ?? []).map((r) => ({ command: r.command, exitCode: r.exitCode })),
    historyCount: (task.history ?? []).length,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    endedAt: task.endedAt ?? null,
    stale: stale ? { reason: stale.reason } : null,
    nextStep: nextStep(task),
    artifactDir: task.id ? path.join('.htask', 'artifacts', task.id) : null,
  };
}

// 列表 JSON 聚合 (供 list --json): tasks[] + summary { total, byStatus }
export function listToJson(tasks) {
  const byStatus = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  }
  return {
    tasks: tasks.map((t) => {
      const stale = staleInfo(t);
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        state: deriveState(t),
        updatedAt: t.updatedAt,
        stale: stale ? { reason: stale.reason } : null,
        nextStep: nextStep(t),
        artifactDir: t.id ? path.join('.htask', 'artifacts', t.id) : null,
      };
    }),
    summary: { total: tasks.length, byStatus },
  };
}

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

export async function cmdStatus({ cwd, id, all, json }) {
  if (all) {
    await cmdList({ cwd, json });
    return;
  }
  const task = id ? await readTask(cwd, id) : await currentTask(cwd);
  if (!task) {
    if (id) {
      if (json) console.log(JSON.stringify({ id, status: null, state: 'NOT_FOUND', message: `任务不存在: ${id}` }, null, 2));
      else console.error(`❌ 任务不存在: ${id}`);
      process.exitCode = 1;
    } else if (json) {
      console.log(JSON.stringify({ status: 'idle', state: 'IDLE', message: '没有当前任务, 先运行 htask start' }, null, 2));
    } else {
      console.log('状态: idle');
    }
    return;
  }
  if (json) console.log(JSON.stringify(taskToJson(task), null, 2));
  else printTaskDetail(task);
}

export async function cmdList({ cwd, json }) {
  const tasks = await readAllTasks(cwd);
  if (json) {
    console.log(JSON.stringify(listToJson(tasks), null, 2));
    return;
  }
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

// ---------- Human Approval Policy ----------

// .htask/approval.yaml (可选, 零依赖 YAML 子集解析): rules.high_risk / rules.low_risk。
// 不存在或解析失败 → 默认全部需人工 (保守, 向后兼容)。
//   规则: risk 非空 → high_risk; risk 空 → low_risk
//   rule 为 true → human (advance 停在 VERIFYING 等 accept); false → auto (advance 自动过闸)
export async function loadApprovalPolicy(cwd) {
  const defaults = { high_risk: true, low_risk: true };
  let text;
  try {
    text = await readFile(path.join(cwd, '.htask', 'approval.yaml'), 'utf8');
  } catch {
    return { rules: { ...defaults }, source: 'default' };
  }
  try {
    const parsed = parseApprovalYaml(text);
    return { rules: { ...defaults, ...parsed }, source: 'file' };
  } catch (err) {
    console.warn(`⚠️ 解析 approval.yaml 失败, 使用默认 (全部人工): ${err.message}`);
    return { rules: { ...defaults }, source: 'default' };
  }
}

// 解析 YAML 子集: 支持 "key: value" 与 "rules:" 段下的缩进项; 值支持 true/false/数字/字符串/#注释
export function parseApprovalYaml(text) {
  const rules = {};
  let inRules = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('rules:')) {
      const rest = line.slice('rules:'.length).trim();
      if (rest && rest !== '{}') throw new Error(`无效的 rules 行: ${line}`);
      inRules = true;
      continue;
    }
    if (!inRules) continue;
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (m) rules[m[1]] = parseYamlScalar(m[2]);
  }
  return rules;
}

function parseYamlScalar(v) {
  const s = String(v).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  if (s !== '' && Number.isFinite(n)) return n;
  return s.replace(/^["']|["']$/g, '');
}

// 判定单任务/单 plan 审批级别: risk 非空 → high_risk 规则; 空 → low_risk 规则
export function approvalDecision({ risk = [], policy }) {
  const rule = risk.length > 0 ? policy.rules.high_risk : policy.rules.low_risk;
  return rule ? 'human' : 'auto';
}

// ---------- 命令: policy ----------

// htask policy: 显示当前审批策略 + 解释 (读 .htask/approval.yaml 或默认)
export async function cmdPolicy({ cwd }) {
  const policy = await loadApprovalPolicy(cwd);
  const fmt = (b) => (b ? '需人工 accept' : 'advance 自动过闸');
  console.log(`审批策略 (来源: ${policy.source === 'file' ? '.htask/approval.yaml' : '默认, 无 approval.yaml (保守)'}):`);
  console.log(`  - 高风险 (有 risk): ${fmt(policy.rules.high_risk)}`);
  console.log(`  - 低风险 (无 risk): ${fmt(policy.rules.low_risk)}`);
  console.log('说明: htask advance 时判定; accept 人工显式确认始终有效。');
  console.log('配置: .htask/approval.yaml → rules: { high_risk: true/false, low_risk: true/false }');
}

// ---------- 命令: agents ----------

// htask agents: 列出可用/不可用后端 (内置 + .htask/agent.<name>.json 自定义)
export async function cmdAgents({ cwd }) {
  const names = new Set(Object.keys(AGENT_ADAPTERS));
  try {
    for (const f of await readdir(path.join(cwd, '.htask'))) {
      const m = f.match(/^agent\.(.+)\.json$/);
      if (m) names.add(m[1]);
    }
  } catch {
    /* 无 .htask 目录 */
  }
  console.log('Agent 后端:');
  for (const name of [...names].sort()) {
    const a = getAgentAdapter(cwd, name);
    if (a?.available) {
      console.log(`  ✅ ${name}  ${a.display ?? name}`);
    } else {
      console.log(`  ❌ ${name}  ${a?.display ?? name} (未安装)`);
    }
  }
  console.log(`默认后端: ${process.env.HTASK_AGENT || 'opencode'} (HTASK_AGENT 或 --agent-backend 覆盖)`);
  console.log(`默认模型: ${DEFAULT_MODEL}`);
}

// ---------- 命令: plan ----------

// htask plan [TASK.md] [--json]: 纯规则分析复杂度/风险/推荐 pipeline (不用 LLM)
export async function cmdPlan({ cwd, taskFile, json }) {
  const file = taskFile || 'TASK.md';
  const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
  let md;
  try {
    md = await readFile(abs, 'utf8');
  } catch (err) {
    console.error(`❌ 读取 ${file} 失败: ${err.message}`);
    process.exitCode = 1;
    return { ok: false, reason: 'read-error' };
  }
  const plan = analyzeTask(md);
  const policy = await loadApprovalPolicy(cwd);
  plan.approval = approvalDecision({ risk: plan.risk, policy });
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`复杂度: ${plan.complexity}`);
    console.log(`风险: ${plan.risk.length > 0 ? plan.risk.join(', ') : '无'}`);
    console.log(`审批: ${plan.approval === 'auto' ? 'auto (advance 自动过闸)' : 'human (advance 停在 VERIFYING)'}`);
    console.log(`推荐 pipeline: ${plan.pipeline.join(' → ')}`);
    console.log(`预计: ${plan.estimated.files} 文件 / ${plan.estimated.minutes} 分钟`);
    console.log(`建议模型: ${plan.suggestModel}`);
    console.log(`建议 review: ${plan.suggestReview ? '是' : '否'}`);
  }
  return { ok: true, plan };
}

// ---------- 命令: events ----------

// htask events [--tail N]: 查看最近 N 条事件 (默认 10, JSON Lines 输出)
export async function cmdEvents({ cwd, tail }) {
  const file = path.join(cwd, '.htask', 'events.jsonl');
  let lines = [];
  try {
    const raw = await readFile(file, 'utf8');
    lines = raw.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    /* 无事件文件 */
  }
  const n = Number.isFinite(Number(tail)) && Number(tail) > 0 ? Number(tail) : 10;
  const last = lines.slice(-n);
  if (lines.length === 0) {
    console.log('(无事件)');
    return { ok: true, count: 0 };
  }
  for (const l of last) console.log(l);
  return { ok: true, count: last.length };
}

// ---------- CLI 入口 ----------

function printHelp() {
  console.log(`htask — Hermes Task Runner: TASK.md → OpenCode 实现 → 验证 → REPORT.md 全链路自动化
状态机: CREATED → PLANNING → IMPLEMENTING → REVIEWING → VERIFYING → ACCEPTED → MERGED (FAILED / CANCELLED)

用法:
  htask plan [TASK.md] [--json]
  htask start [--model <provider/model>] [--agent <agent>] [--agent-backend <name>] [--review] [--no-review] [--id <id>] [TASK.md]
  htask status [--id <id> | --all] [--json]
  htask list [--json]
  htask accept [--id <id>]
  htask merge [--id <id>] [--no-push]
  htask advance [--id <id>] [--no-push] [--json]
  htask retry [--id <id>] [--fix] [--yes]
  htask cancel [--id <id>]
  htask agents
  htask policy
  htask events [--tail N]
  htask report
  htask --help

选项:
  --model <provider/model>   覆盖模型 (默认 ${DEFAULT_MODEL})
  --agent <agent>            指定 agent
  --agent-backend <name>     覆盖 agent 后端 (默认 HTASK_AGENT 或 opencode; 可用: ${availableAgentNames().join(', ')})
  --review                   验证通过后运行 reviewer agent 生成 REVIEW.md
  --no-review                关闭 Planner 建议的自动 review
  --id <id>                  指定任务 id (默认当前任务)
  --all                      列出所有任务
  --no-push                  merge/advance 时跳过 git push
  --fix                      retry 时用 agent 自动修复重实现
  --yes                      retry --fix 跳过确认
  --json                     plan/status/list/advance 输出 JSON (可 JSON.parse)
  --tail N                   events 查看最近 N 条 (默认 10)
  advance                    自动推进可自动的迁移: VERIFYING(全过)→ACCEPTED→MERGED

环境变量 (测试注入):
  HTASK_OPENCODE_CMD          opencode 命令 (默认 opencode)
  HTASK_OPENCODE_ARGS_PREFIX  参数前缀 (默认 "run --pure -m ${DEFAULT_MODEL}")
  HTASK_AGENT                 默认 agent 后端 (默认 opencode)
  HTASK_SHELL                 agent 内部命令 shell (默认 /bin/bash)
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
    else if (a === '--agent-backend') opts.agentBackend = rest[++i];
    else if (a === '--review') opts.review = true;
    else if (a === '--no-review') opts.noReview = true;
    else if (a === '--id') opts.id = rest[++i];
    else if (a === '--all') opts.all = true;
    else if (a === '--no-push') opts.noPush = true;
    else if (a === '--fix') opts.fix = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--tail') opts.tail = rest[++i];
    else opts.taskFile = a;
  }

  switch (cmd) {
    case 'plan':
      await cmdPlan({ cwd, taskFile: opts.taskFile, json: opts.json });
      break;
    case 'start':
      await cmdStart({ cwd, taskFile: opts.taskFile || 'TASK.md', model: opts.model, agent: opts.agent, review: opts.review, noReview: opts.noReview, id: opts.id, agentBackend: opts.agentBackend });
      break;
    case 'status':
      await cmdStatus({ cwd, id: opts.id, all: opts.all, json: opts.json });
      break;
    case 'list':
      await cmdList({ cwd, json: opts.json });
      break;
    case 'accept':
      await cmdAccept({ cwd, id: opts.id });
      break;
    case 'merge':
      await cmdMerge({ cwd, id: opts.id, noPush: opts.noPush });
      break;
    case 'advance':
      await cmdAdvance({ cwd, id: opts.id, noPush: opts.noPush, json: opts.json });
      break;
    case 'retry':
      await cmdRetry({ cwd, id: opts.id, fix: opts.fix, yes: opts.yes });
      break;
    case 'cancel':
      await cmdCancel({ cwd, id: opts.id });
      break;
    case 'agents':
      await cmdAgents({ cwd });
      break;
    case 'policy':
      await cmdPolicy({ cwd });
      break;
    case 'events':
      await cmdEvents({ cwd, tail: opts.tail });
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
