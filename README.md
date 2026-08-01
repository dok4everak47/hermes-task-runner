# hermes-task-runner (htask)

把「TASK.md → OpenCode 实现 → 完成通知 → 验证 → REPORT」整条链自动化成一条命令,
并给每个任务引入生命周期状态机, 升级为 orchestrator。

## 安装

```bash
npm link          # 或手动软链
ln -s "$(pwd)/bin/htask.mjs" /opt/homebrew/bin/htask
```

依赖: macOS, node ≥ 24, opencode (`/opt/homebrew/bin/opencode`), osascript。

## 状态机

```
CREATED → PLANNING → IMPLEMENTING → REVIEWING → VERIFYING → ACCEPTED → MERGED
   │         │           │             │            │           │
   │         │           │             │            └─(fail)→ FAILED
   │         │           │             └─(review 结果仅记录)→ VERIFYING
   │         │           └─(exit≠0)→ FAILED
   │         └─(解析失败)→ FAILED
   └─(任意非终态可)→ CANCELLED
```

关键设计: **人工闸门**。验证全绿后任务停在 `VERIFYING` (不自动 accept),
需人工 `htask accept` → `ACCEPTED`; 再人工 `htask merge` → `MERGED` (自动 git commit+push)。
`FAILED / MERGED / CANCELLED` 是终态。

每个任务一个文件 `.htask/tasks/<id>.json`, 含 status / history (迁移历史) / verify 结果等;
`.htask/state.json` 只是当前任务指针 `{ currentId }`。旧格式 state.json (含 status)
首次读取时自动迁移到 `tasks/task-<日期>-legacy.json`。

## 用法

```bash
htask start [--model <provider/model>] [--agent <agent>] [--review] [--id <id>] [TASK.md]
htask status [--id <id> | --all]
htask list                          # = status --all 别名
htask accept [--id <id>]
htask merge [--id <id>] [--no-push]
htask cancel [--id <id>]
htask report
htask --help
```

`htask start` 流程 (状态流转):

1. 创建任务 → `CREATED`; 解析 TASK.md (标题 + `## Verification Commands` 下的 bash 命令) → 成功 `PLANNING`, 失败 `FAILED`。
2. `IMPLEMENTING`: spawn `opencode run --pure -m deepseek/deepseek-v4-flash "按 TASK.md 实现，完成后总结"`, 日志到 `.htask/logs/<id>.log`, exit≠0 → `FAILED`。
3. 退出后 osascript 弹窗通知 (✅/❌ + 耗时)。
4. `--review`: `REVIEWING` → 跑 reviewer agent → 记录结果到 state.review → `VERIFYING`。
5. 逐条执行验证命令 (超时 600s/条), 记录 exit code / 耗时 / 输出摘要 (截断 2000 字符)。
6. 全绿 → 停在 `VERIFYING`, 打印 "下一步: htask accept"; 有失败 → `FAILED`。
7. 生成 REPORT.md (状态机状态 + 迁移历史 + 验证结果表)。

`htask status` 显示当前任务状态 + 迁移历史 + 下一步建议 (如 `等待人工: htask accept`)。
`htask list` 表格列出所有任务 (id / 标题 / 状态 / 停留时长 / 卡住标记)。
卡住检测: IMPLEMENTING > 30min、REVIEWING > 15min、VERIFYING > 1h、ACCEPTED > 24h → `⚠️ 卡住`。
`htask accept/merge/cancel` 不带 `--id` 时操作当前任务。

`.htask/state.lock` 防止并发 start (存在即拒绝)。

## 环境变量 (测试注入, 不真调 API)

| 变量 | 默认 | 说明 |
|---|---|---|
| `HTASK_OPENCODE_CMD` | `opencode` | opencode 命令, 测试时换成假脚本 |
| `HTASK_OPENCODE_ARGS_PREFIX` | `run --pure -m deepseek/deepseek-v4-flash` | opencode 参数前缀 |

## 与工作流/模板的关系

- 输入 TASK.md 格式见 `.templates/TASK.md` (固定字段 + Verification Commands bash 代码块)。
- 通知模式复用 `.templates/opencode-run.sh` 的 osascript 弹窗。
- `--review` 生成的 REVIEW.md 基于 `.templates/REVIEW.md` (reviewer agent 只读)。
- htask 只读 TASK.md, 只写 `.htask/` 和 REPORT.md/REVIEW.md, 不改项目源码。

## 测试

```bash
node --check bin/htask.mjs
node --test test/
```

零 npm 依赖, 零构建, node 24 直接跑。
