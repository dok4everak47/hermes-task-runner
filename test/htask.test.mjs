import test from 'node:test';
import assert from 'node:assert/strict';
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
  readState,
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

// ---------- cmdStart 端到端 ----------

test('cmdStart 端到端: 假 opencode 跑通, 状态流转 done 并生成 REPORT.md', async (t) => {
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

    const state = await readState(dir);
    assert.equal(state.status, 'done');
    assert.equal(state.implementExit, 0);
    assert.equal(state.verify.length, 1);
    assert.equal(state.verify[0].exitCode, 0);
    assert.equal(state.verify[0].command, 'node -e "console.log(\'verify ok\')"');
    assert.ok(state.startedAt);
    assert.ok(state.endedAt);

    const report = await readFile(path.join(dir, 'REPORT.md'), 'utf8');
    assert.ok(report.includes('验证结果'));
    assert.ok(report.includes('✅ 通过'));

    assert.ok(!existsSync(path.join(dir, '.htask', 'state.lock')));
  });
});

test('cmdStart 验证失败时状态为 failed', async (t) => {
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
    assert.equal(res.ok, true);
    const state = await readState(dir);
    assert.equal(state.status, 'failed');
    const report = await readFile(path.join(dir, 'REPORT.md'), 'utf8');
    assert.ok(report.includes('❌ 失败'));
  });
});

test('cmdStart 无 Verification Commands 时告警并使用默认验证, 不 crash', async (t) => {
  const dir = await makeTempDir(t);
  const task = path.join(dir, 'TASK.md');
  await writeFile(task, '# TASK — 无验证\n\n## Goal\nx\n');
  const script = await makeFakeOpencode(dir);
  await withEnv('HTASK_OPENCODE_CMD', script, async () => {
    const res = await cmdStart({ cwd: dir, taskFile: task });
    assert.equal(res.ok, true);
    const state = await readState(dir);
    assert.equal(state.verify.length, 3);
    assert.ok(state.status === 'done' || state.status === 'failed');
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

// ---------- status / report / main ----------

test('cmdStatus 无记录时显示 idle, 有记录时显示状态', async (t) => {
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

  const state = {
    status: 'done',
    taskFile: 'TASK.md',
    title: '示例',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    implementExit: 0,
    verify: [{ command: 'ls', exitCode: 0, durationMs: 10, output: '' }],
  };
  await mkdir(path.join(dir, '.htask'), { recursive: true });
  await writeFile(path.join(dir, '.htask', 'state.json'), JSON.stringify(state));
  const logs2 = [];
  console.log = (...a) => logs2.push(a.join(' '));
  try {
    await cmdStatus({ cwd: dir });
    assert.ok(logs2.some((l) => l.includes('状态: done')));
  } finally {
    console.log = orig;
  }
});

test('cmdReport 从已有状态重新生成 REPORT.md; 无状态时报错', async (t) => {
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

test('main 分发: 未知命令报错, --help 打印用法', async (t) => {
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
  } finally {
    console.log = orig;
    console.error = origErr;
    process.exitCode = oldExit;
  }
});
