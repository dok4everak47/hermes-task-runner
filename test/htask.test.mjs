import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseTaskFile,
  spawnOpenCode,
  runVerifyCommands,
  writeReport,
  buildOpenCodeArgs,
  cmdStart,
  cmdStatus,
  cmdReport,
  cmdAccept,
  cmdMerge,
  cmdCancel,
  cmdList,
  readState,
  readTask,
  readAllTasks,
  writeTask,
  createTask,
  transition,
  currentTask,
  staleInfo,
  nextStep,
  newTaskId,
  TERMINAL,
  main,
} from '../bin/htask.mjs';

async function makeTempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'htask-test-'));
  // macOS 上 .htask 写入后立即递归删除可能 ENOTEMPTY, 加重试
  t.after(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
  return dir;
}

async function makeFakeOpencode(dir, { exitCode = 0 } = {}) {
  const script = path.join(dir, 'fake-opencode.sh');
  const body = `#!/bin/sh\n# fake opencode: 记录调用参数并退出 ${exitCode}\nprintf '%s\\n' "$*" >> "$(dirname "$0")/fake.log"\nprintf 'fake implemented ok\\n'\nexit ${exitCode}\n`;
  await writeFile(script, body);
  await chmod(script, 0o755);
  return script;
}

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  const restore = () => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  };
  try {
    const r = fn();
    // async 回调: 等 Promise 完成后才还原 env, 否则 env 提前丢失
    if (r && typeof r.then === 'function') {
      return r.finally(restore);
    }
    return r;
  } catch (err) {
    restore();
    throw err;
  }
}

async function currentId(dir) {
  const s = await readState(dir);
  return s?.currentId;
}

async function taskById(dir, id) {
  return JSON.parse(await readFile(path.join(dir, '.htask', 'tasks', `${id}.json`), 'utf8'));
}

async function initGitRepo(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@test.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
}

// 走合法迁移链到指定非终态 (CREATED 起步)
async function walkTo(dir, id, target) {
  const chain = {
    VERIFYING: ['PLANNING', 'IMPLEMENTING', 'VERIFYING'],
    ACCEPTED: ['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'ACCEPTED'],
  };
  for (const s of chain[target]) {
    await transition(dir, id, s, 'auto');
  }
}

async function toAccepted(dir, id) {
  await walkTo(dir, id, 'VERIFYING');
  let cur = await readTask(dir, id);
  cur.verify = [{ command: 'true', exitCode: 0, durationMs: 1, output: '' }];
  await writeTask(dir, cur);
  await cmdAccept({ cwd: dir });
  assert.equal((await readTask(dir, id)).status, 'ACCEPTED');
}

// ---------- parseTaskFile ----------

test('parseTaskFile 提取标题与验证命令, 忽略注释与空行', () => {
  const md = `# TASK — 示例任务

## Goal

实现某功能

## Verification Commands

\`\`\`bash
# 验收时依次执行
npm run typecheck

npm test
\`\`\`

## Rollback Plan

\`\`\`bash
rm -rf x
\`\`\`
`;
  const r = parseTaskFile(md);
  assert.equal(r.title, '示例任务');
  assert.deepEqual(r.verifyCommands, ['npm run typecheck', 'npm test']);
});

test('parseTaskFile 无 Verification Commands 时返回空数组, 不 crash', () => {
  const md = '# TASK — 无验证\n\n## Goal\nx';
  const r = parseTaskFile(md);
  assert.equal(r.title, '无验证');
  assert.equal(r.verifyCommands.length, 0);
});

test('parseTaskFile 标题为普通 # 标题时也能提取', () => {
  const r = parseTaskFile('# 普通标题\n\n## Verification Commands\n\n\`\`\`bash\nls\n\`\`\`\n');
  assert.equal(r.title, '普通标题');
  assert.deepEqual(r.verifyCommands, ['ls']);
});

// ---------- buildOpenCodeArgs ----------

test('buildOpenCodeArgs 默认参数, 且支持 --model/--agent 覆盖', () => {
  withEnv('HTASK_OPENCODE_ARGS_PREFIX', undefined, () => {
    assert.deepEqual(buildOpenCodeArgs({}), ['run', '--pure', '-m', 'deepseek/deepseek-v4-flash']);
    assert.deepEqual(buildOpenCodeArgs({ model: 'gpt-4o' }), ['run', '--pure', '-m', 'gpt-4o']);
    assert.deepEqual(buildOpenCodeArgs({ agent: 'reviewer' }), [
      'run',
      '--pure',
      '-m',
      'deepseek/deepseek-v4-flash',
      '--agent',
      'reviewer',
    ]);
    assert.deepEqual(buildOpenCodeArgs({ model: 'gpt-4o', agent: 'reviewer' }), [
      'run',
      '--pure',
      '-m',
      'gpt-4o',
      '--agent',
      'reviewer',
    ]);
  });
});

test('buildOpenCodeArgs 尊重 HTASK_OPENCODE_ARGS_PREFIX 环境变量', () => {
  withEnv('HTASK_OPENCODE_ARGS_PREFIX', 'run --pure', () => {
    assert.deepEqual(buildOpenCodeArgs({ model: 'm' }), ['run', '--pure', '-m', 'm']);
  });
});

// ---------- spawnOpenCode ----------

test('spawnOpenCode 用假脚本跑通: 记录日志并解析退出码', async (t) => {
  const dir = await makeTempDir(t);
  const script = await makeFakeOpencode(dir, { exitCode: 0 });
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const r = await spawnOpenCode(dir, ['run', '--pure', '-m', 'm'], '按 TASK.md 实现，完成后总结');
    assert.equal(r.exitCode, 0);
    assert.ok(r.durationMs >= 0);
    const log = await readFile(path.join(dir, '.htask', 'implement.log'), 'utf8');
    assert.ok(log.includes('fake implemented ok'));
    const fake = await readFile(path.join(dir, 'fake.log'), 'utf8');
    assert.ok(fake.includes('按 TASK.md 实现，完成后总结'));
  });
});

test('spawnOpenCode 退出码非 0 时能解析', async (t) => {
  const dir = await makeTempDir(t);
  const script = await makeFakeOpencode(dir, { exitCode: 7 });
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const r = await spawnOpenCode(dir, ['run', '--pure'], 'prompt');
    assert.equal(r.exitCode, 7);
  });
});

// ---------- runVerifyCommands ----------

test('runVerifyCommands 记录 exit code / 耗时 / 输出, 长输出截断', async (t) => {
  const dir = await makeTempDir(t);
  const cmds = [
    'node -e "console.log(\'hello\')"',
    'node -e "process.exit(3)"',
    'node -e "console.log(\'a\'.repeat(3000))"',
  ];
  const results = await runVerifyCommands(dir, cmds);
  assert.equal(results.length, 3);
  assert.equal(results[0].exitCode, 0);
  assert.ok(results[0].output.includes('hello'));
  assert.equal(results[1].exitCode, 3);
  assert.ok(results[2].output.length <= 2010);
  assert.ok(results[2].output.includes('输出截断'));
});

// ---------- writeReport ----------

test('writeReport 生成包含验证结果表的 REPORT.md', async (t) => {
  const dir = await makeTempDir(t);
  const ctx = {
    title: '示例任务',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    implementExit: 0,
    implementDurationMs: 5000,
    verify: [
      { command: 'npm run typecheck', exitCode: 0, durationMs: 8200, output: 'OK' },
      { command: 'npm test', exitCode: 1, durationMs: 1000, output: 'FAIL' },
    ],
  };
  await writeReport(dir, ctx);
  const report = await readFile(path.join(dir, 'REPORT.md'), 'utf8');
  assert.ok(report.includes('# REPORT — 示例任务'));
  // 数据里 npm test exitCode=1 → 整体应为失败
  assert.ok(report.includes('❌ 失败'));
  assert.ok(report.includes('| # | 命令 | exit | 耗时 | 结果 |'));
  assert.ok(report.includes('| 1 | npm run typecheck | 0 |'));
  assert.ok(report.includes('| 2 | npm test | 1 |'));
  assert.ok(report.includes('## 输出摘要'));
});

// ---------- 状态机核心 ----------

test('newTaskId 生成 task-日期-slug (去非字母数字, 小写)', () => {
  const id = newTaskId('Cortex 新增 toolStats 工具');
  assert.match(id, /^task-\d{8}-[a-z0-9]{1,12}$/);
  assert.ok(!id.includes(' '));
  assert.ok(id.endsWith('toolst') || id.includes('toolstats')); // 保留英文字母 slug
});

test('createTask 写 tasks/<id>.json 并更新指针, 状态 CREATED', async (t) => {
  const dir = await makeTempDir(t);
  const task = await createTask(dir, { title: '示例任务' });
  assert.equal(task.status, 'CREATED');
  const read = await taskById(dir, task.id);
  assert.equal(read.id, task.id);
  assert.equal(read.status, 'CREATED');
  assert.ok(read.history.length >= 1);
  assert.equal((await readState(dir)).currentId, task.id);
});

test('transition 合法迁移通过并追加 history', async (t) => {
  const dir = await makeTempDir(t);
  const task = await createTask(dir, { title: '迁移' });
  await transition(dir, task.id, 'PLANNING', 'auto');
  await transition(dir, task.id, 'IMPLEMENTING', 'auto');
  const read = await readTask(dir, task.id);
  assert.equal(read.status, 'IMPLEMENTING');
  assert.equal(read.history.length, 3);
  assert.equal(read.history[1].from, 'CREATED');
  assert.equal(read.history[1].to, 'PLANNING');
  assert.equal(read.history[1].by, 'auto');
});

test('非法迁移被拒绝', async (t) => {
  const dir = await makeTempDir(t);
  const task = await createTask(dir, { title: '迁移' }); // CREATED
  await assert.rejects(() => transition(dir, task.id, 'MERGED', 'auto'), /非法迁移: CREATED → MERGED/);
  await assert.rejects(() => transition(dir, task.id, 'ACCEPTED', 'auto'), /非法迁移/);
});

test('transition 到终态写 endedAt, 非终态保持 null', async (t) => {
  const dir = await makeTempDir(t);
  const task = await createTask(dir, { title: 'x' });
  await transition(dir, task.id, 'PLANNING', 'auto');
  await transition(dir, task.id, 'IMPLEMENTING', 'auto');
  await transition(dir, task.id, 'VERIFYING', 'auto');
  await transition(dir, task.id, 'ACCEPTED', 'human');
  assert.equal((await readTask(dir, task.id)).status, 'ACCEPTED');
  assert.equal((await readTask(dir, task.id)).endedAt, null);
  await transition(dir, task.id, 'MERGED', 'human');
  const merged = await readTask(dir, task.id);
  assert.equal(merged.status, 'MERGED');
  assert.ok(merged.endedAt);
  assert.ok(TERMINAL.has('MERGED'));
});

test('staleInfo: 超过阈值标卡住, 终态/新鲜不标', () => {
  const mk = (status, updatedAt) => ({ status, updatedAt });
  const old = (min) => new Date(Date.now() - min * 60000).toISOString();
  assert.ok(staleInfo(mk('IMPLEMENTING', old(31)))?.stale);
  assert.equal(staleInfo(mk('IMPLEMENTING', old(10))), null);
  assert.equal(staleInfo(mk('VERIFYING', old(30))), null); // 阈值 60min
  const v = staleInfo(mk('VERIFYING', old(61)));
  assert.ok(v?.stale);
  assert.ok(v.reason.includes('停留超过'));
  assert.equal(staleInfo(mk('MERGED', old(999))), null); // 终态不标
  assert.equal(staleInfo(mk('FAILED', old(999))), null);
  assert.equal(staleInfo(mk('ACCEPTED', old(24 * 60 - 1))), null); // 阈值 24h, 未超
  assert.ok(staleInfo(mk('ACCEPTED', old(24 * 60 + 1)))?.stale);
});

test('nextStep: 给出下一步建议', () => {
  assert.equal(nextStep({ status: 'VERIFYING' }), '等待人工: htask accept');
  assert.equal(nextStep({ status: 'ACCEPTED' }), '可继续: htask merge');
  assert.equal(nextStep({ status: 'MERGED' }), '已完成');
  assert.equal(nextStep({ status: 'FAILED' }), '失败: 需人工介入');
  assert.equal(nextStep({ status: 'CANCELLED' }), '已取消');
  assert.equal(nextStep({}), '-');
});

// ---------- 旧 state.json 兼容迁移 ----------

test('旧 state.json 兼容迁移: 首次读取迁移到 tasks/ 并写指针, 幂等', async (t) => {
  const dir = await makeTempDir(t);
  await mkdir(path.join(dir, '.htask'), { recursive: true });
  await writeFile(
    path.join(dir, '.htask', 'state.json'),
    JSON.stringify({
      status: 'done',
      title: '旧任务',
      taskFile: 'TASK.md',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      implementExit: 0,
      implementDurationMs: 100,
      verify: [{ command: 'ls', exitCode: 0, durationMs: 1, output: '' }],
    })
  );
  const task = await currentTask(dir);
  assert.ok(task);
  assert.equal(task.id, 'task-20260101-legacy');
  assert.equal(task.status, 'VERIFYING'); // done → VERIFYING (等人工 accept)
  assert.ok(task.history.length >= 1);
  assert.equal(task.history[0].by, 'migration');
  const ptr = await readState(dir);
  assert.equal(ptr.currentId, task.id);
  assert.equal(ptr.status, undefined); // 旧格式已删除
  const again = await currentTask(dir);
  assert.equal(again.id, task.id); // 幂等
});

// ---------- cmdStart 端到端 ----------

test('cmdStart 端到端: 假 opencode 跑通, 停在 VERIFYING 并生成 REPORT.md', async (t) => {
  const dir = await makeTempDir(t);
  const task = path.join(dir, 'TASK.md');
  await writeFile(
    task,
    `# TASK — 端到端任务

## Goal

验证 htask 全链路

## Verification Commands

\`\`\`bash
# 注释行
node -e "console.log('verify ok')"
\`\`\`
`
  );
  const script = await makeFakeOpencode(dir);
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const res = await cmdStart({ cwd: dir, taskFile: task });
    assert.equal(res.ok, true);

    const id = await currentId(dir);
    assert.ok(id);
    const tsk = await taskById(dir, id);
    assert.equal(tsk.status, 'VERIFYING');
    assert.equal(tsk.implementExit, 0);
    assert.equal(tsk.verify.length, 1);
    assert.equal(tsk.verify[0].exitCode, 0);
    assert.ok(tsk.startedAt);
    assert.equal(tsk.endedAt, null);
    assert.deepEqual(
      tsk.history.map((h) => h.to),
      ['CREATED', 'PLANNING', 'IMPLEMENTING', 'VERIFYING']
    );

    const report = await readFile(path.join(dir, 'REPORT.md'), 'utf8');
    assert.ok(report.includes('验证结果'));
    assert.ok(report.includes('✅ 通过'));
    assert.ok(report.includes('状态: VERIFYING'));

    assert.ok(!existsSync(path.join(dir, '.htask', 'state.lock')));
  });
});

test('cmdStart 验证失败 → FAILED', async (t) => {
  const dir = await makeTempDir(t);
  const task = path.join(dir, 'TASK.md');
  await writeFile(
    task,
    `# TASK — 失败任务

## Goal

x

## Verification Commands

\`\`\`bash
node -e "process.exit(1)"
\`\`\`
`
  );
  const script = await makeFakeOpencode(dir);
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const res = await cmdStart({ cwd: dir, taskFile: task });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'verify-failed');
    const tsk = await taskById(dir, await currentId(dir));
    assert.equal(tsk.status, 'FAILED');
    const report = await readFile(path.join(dir, 'REPORT.md'), 'utf8');
    assert.ok(report.includes('❌ 失败'));
  });
});

test('cmdStart opencode 退出非 0 → FAILED', async (t) => {
  const dir = await makeTempDir(t);
  const task = path.join(dir, 'TASK.md');
  await writeFile(task, '# TASK — 实现失败\n\n## Verification Commands\n\n\`\`\`bash\nnode -e "console.log(1)"\n\`\`\`\n');
  const script = await makeFakeOpencode(dir, { exitCode: 7 });
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const res = await cmdStart({ cwd: dir, taskFile: task });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'implement-failed');
    const tsk = await taskById(dir, await currentId(dir));
    assert.equal(tsk.status, 'FAILED');
    const last = tsk.history[tsk.history.length - 1];
    assert.equal(last.from, 'IMPLEMENTING');
    assert.equal(last.to, 'FAILED');
  });
});

test('cmdStart TASK.md 不存在 (解析失败) → FAILED', async (t) => {
  const dir = await makeTempDir(t);
  const script = await makeFakeOpencode(dir);
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const res = await cmdStart({ cwd: dir, taskFile: path.join(dir, 'missing.md') });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'parse-error');
    const tsk = await taskById(dir, await currentId(dir));
    assert.equal(tsk.status, 'FAILED');
  });
});

test('cmdStart --review: 经过 REVIEWING, 记录 review 结果', async (t) => {
  const dir = await makeTempDir(t);
  const task = path.join(dir, 'TASK.md');
  await writeFile(task, `# TASK — 审查任务\n\n## Verification Commands\n\n\`\`\`bash\nnode -e "console.log('ok')"\n\`\`\`\n`);
  const script = await makeFakeOpencode(dir);
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const res = await cmdStart({ cwd: dir, taskFile: task, review: true });
    assert.equal(res.ok, true);
    const tsk = await taskById(dir, await currentId(dir));
    assert.equal(tsk.status, 'VERIFYING');
    assert.equal(tsk.review, 'passed');
    assert.deepEqual(
      tsk.history.map((h) => h.to),
      ['CREATED', 'PLANNING', 'IMPLEMENTING', 'REVIEWING', 'VERIFYING']
    );
  });
});

test('cmdStart 无 Verification Commands 时告警并使用默认验证, 不 crash', async (t) => {
  const dir = await makeTempDir(t);
  const task = path.join(dir, 'TASK.md');
  await writeFile(task, '# TASK — 无验证\n\n## Goal\nx\n');
  const script = await makeFakeOpencode(dir);
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const res = await cmdStart({ cwd: dir, taskFile: task });
    assert.equal(res.ok, false);
    const tsk = await taskById(dir, await currentId(dir));
    assert.equal(tsk.verify.length, 3);
    assert.ok(tsk.status === 'VERIFYING' || tsk.status === 'FAILED');
    assert.ok(existsSync(path.join(dir, 'REPORT.md')));
  });
});

test('cmdStart 遇到 state.lock 时拒绝并发', async (t) => {
  const dir = await makeTempDir(t);
  await mkdir(path.join(dir, '.htask'), { recursive: true });
  await writeFile(path.join(dir, '.htask', 'state.lock'), '123');
  const res = await cmdStart({ cwd: dir, taskFile: path.join(dir, 'TASK.md') });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'locked');
});

// ---------- 人工闸门: accept ----------

test('人工闸门: 验证全绿仍停在 VERIFYING, 只有 accept 才 ACCEPTED', async (t) => {
  const dir = await makeTempDir(t);
  const task = path.join(dir, 'TASK.md');
  await writeFile(task, `# TASK — 闸门任务\n\n## Verification Commands\n\n\`\`\`bash\nnode -e "console.log('ok')"\n\`\`\`\n`);
  const script = await makeFakeOpencode(dir);
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    await cmdStart({ cwd: dir, taskFile: task });
    let tsk = await taskById(dir, await currentId(dir));
    assert.equal(tsk.status, 'VERIFYING'); // 不自动 ACCEPTED

    const res = await cmdAccept({ cwd: dir });
    assert.equal(res.ok, true);
    tsk = await taskById(dir, await currentId(dir));
    assert.equal(tsk.status, 'ACCEPTED');
    const last = tsk.history[tsk.history.length - 1];
    assert.equal(last.from, 'VERIFYING');
    assert.equal(last.to, 'ACCEPTED');
    assert.equal(last.by, 'human');
  });
});

test('cmdAccept 拒绝: 非 VERIFYING 或验证未全过, 状态不变', async (t) => {
  const dir = await makeTempDir(t);
  const task = await createTask(dir, { title: 'x' }); // CREATED
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    const r1 = await cmdAccept({ cwd: dir });
    assert.equal(r1.ok, false);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;

    await walkTo(dir, task.id, 'VERIFYING');
    let cur = await readTask(dir, task.id);
    cur.verify = [{ command: 'ls', exitCode: 1, durationMs: 1, output: '' }];
    await writeTask(dir, cur);
    const r2 = await cmdAccept({ cwd: dir });
    assert.equal(r2.ok, false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = oldExit;
  }
  assert.equal((await readTask(dir, task.id)).status, 'VERIFYING');
});

// ---------- merge ----------

test('cmdMerge: ACCEPTED → git commit → MERGED (--no-push)', async (t) => {
  const dir = await makeTempDir(t);
  await initGitRepo(dir);
  const task = await createTask(dir, { title: '合并任务' });
  await toAccepted(dir, task.id);

  const res = await cmdMerge({ cwd: dir, noPush: true });
  assert.equal(res.ok, true);
  const merged = await readTask(dir, task.id);
  assert.equal(merged.status, 'MERGED');
  assert.ok(merged.endedAt);
  const last = merged.history[merged.history.length - 1];
  assert.equal(last.from, 'ACCEPTED');
  assert.equal(last.to, 'MERGED');
  assert.equal(last.by, 'human');
  const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf8' });
  assert.ok(log.includes('合并任务'));
});

test('cmdMerge 拒绝: 非 ACCEPTED 状态', async (t) => {
  const dir = await makeTempDir(t);
  await createTask(dir, { title: 'x' }); // CREATED
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    const r = await cmdMerge({ cwd: dir });
    assert.equal(r.ok, false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = oldExit;
  }
});

test('cmdMerge 拒绝: git commit 失败时状态不变', async (t) => {
  const dir = await makeTempDir(t); // 非 git 仓库 → git add 失败
  const task = await createTask(dir, { title: 'x' });
  await toAccepted(dir, task.id);
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    const r = await cmdMerge({ cwd: dir, noPush: true });
    assert.equal(r.ok, false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = oldExit;
  }
  assert.equal((await readTask(dir, task.id)).status, 'ACCEPTED'); // 状态不变
});

// ---------- cancel ----------

test('cmdCancel: 非终态 → CANCELLED, 终态拒绝', async (t) => {
  const dir = await makeTempDir(t);
  const task = await createTask(dir, { title: 'x' });
  const r = await cmdCancel({ cwd: dir });
  assert.equal(r.ok, true);
  assert.equal((await readTask(dir, task.id)).status, 'CANCELLED');
  assert.ok((await readTask(dir, task.id)).endedAt);

  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    const r2 = await cmdCancel({ cwd: dir });
    assert.equal(r2.ok, false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = oldExit;
  }
});

test('cmdAccept/merge/cancel 无当前任务时报错退出码 1', async (t) => {
  const dir = await makeTempDir(t);
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    const r = await cmdAccept({ cwd: dir });
    assert.equal(r.ok, false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = oldExit;
  }
});

// ---------- status / list / report ----------

test('cmdStatus 无任务时 idle; 有任务显示状态+历史+下一步', async (t) => {
  const dir = await makeTempDir(t);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await cmdStatus({ cwd: dir });
    assert.ok(logs.some((l) => l.includes('idle')));
  } finally {
    console.log = orig;
  }

  const task = await createTask(dir, { title: '示例' });
  await walkTo(dir, task.id, 'VERIFYING');
  const logs2 = [];
  console.log = (...a) => logs2.push(a.join(' '));
  try {
    await cmdStatus({ cwd: dir });
    assert.ok(logs2.some((l) => l.includes('状态: VERIFYING')));
    assert.ok(logs2.some((l) => l.includes('等待人工: htask accept')));
    assert.ok(logs2.some((l) => l.includes('迁移历史')));
  } finally {
    console.log = orig;
  }
});

test('cmdList 显示多任务表格 + 卡住标记', async (t) => {
  const dir = await makeTempDir(t);
  await createTask(dir, { title: '任务A' });
  await createTask(dir, { title: '任务B' });
  // 构造一个卡住的任务: IMPLEMENTING 超过 30min
  const staleTask = await createTask(dir, { title: '卡住任务' });
  let cur = await readTask(dir, staleTask.id);
  cur.status = 'IMPLEMENTING';
  cur.updatedAt = new Date(Date.now() - 31 * 60000).toISOString();
  await writeTask(dir, cur);

  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await cmdList({ cwd: dir });
    assert.ok(logs.some((l) => l.includes('任务A')));
    assert.ok(logs.some((l) => l.includes('任务B')));
    assert.ok(logs.some((l) => l.includes('IMPLEMENTING')));
    assert.ok(logs.some((l) => l.includes('⚠️ 卡住')));
  } finally {
    console.log = orig;
  }
  const all = await readAllTasks(dir);
  assert.equal(all.length, 3);
});

test('cmdReport 从当前任务重新生成 REPORT.md; 无任务时报错', async (t) => {
  const dir = await makeTempDir(t);
  await mkdir(path.join(dir, '.htask'), { recursive: true });
  await writeFile(
    path.join(dir, '.htask', 'state.json'),
    JSON.stringify({
      status: 'done',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:10.000Z',
      taskFile: 'TASK.md',
      title: '重生成任务',
      implementExit: 0,
      implementDurationMs: 100,
      verify: [],
    })
  );
  await cmdReport({ cwd: dir });
  const report = await readFile(path.join(dir, 'REPORT.md'), 'utf8');
  assert.ok(report.includes('# REPORT — 重生成任务'));
  assert.ok(report.includes('状态: VERIFYING'));

  const dir2 = await makeTempDir(t);
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    await cmdReport({ cwd: dir2 });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = oldExit;
  }
});

test('main 分发: 未知命令报错, --help 打印用法, list 可用', async (t) => {
  const dir = await makeTempDir(t);
  const logs = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    await main(['--help'], { cwd: dir });
    assert.ok(logs.some((l) => l.includes('用法')));
    logs.length = 0;
    await main(['bogus'], { cwd: dir });
    assert.equal(process.exitCode, 1);
    assert.ok(logs.some((l) => l.includes('未知命令')));
    process.exitCode = 0;
    logs.length = 0;
    await main(['list'], { cwd: dir });
    assert.ok(logs.some((l) => l.includes('无任务记录')));
  } finally {
    console.log = orig;
    console.error = origErr;
    process.exitCode = oldExit;
  }
});
