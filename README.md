# hermes-task-runner (htask)

把「TASK.md → OpenCode 实现 → 完成通知 → 验证 → REPORT」整条链自动化成一条命令。

```
htask start TASK.md
```

## 安装

```bash
npm link          # 或手动软链
ln -s "$(pwd)/bin/htask.mjs" /opt/homebrew/bin/htask
```

依赖: macOS, node ≥ 24, opencode (`/opt/homebrew/bin/opencode`), osascript。

## 用法

```bash
htask start [--model <provider/model>] [--agent <agent>] [--review] [TASK.md]
htask status
htask report
htask --help
```

`htask start` 流程:

1. 解析 TASK.md: 标题 + `## Verification Commands` 下的 bash 命令 (忽略注释/空行)。
2. spawn `opencode run --pure -m deepseek/deepseek-v4-flash "按 TASK.md 实现，完成后总结"`, stdout/stderr 追加到 `.htask/implement.log`, 后台运行。
3. 退出后 osascript 弹窗通知 (✅/❌ + 耗时)。
4. 逐条执行验证命令 (超时 600s/条), 记录 exit code / 耗时 / 输出摘要 (截断 2000 字符)。
5. 生成 REPORT.md (状态 + 验证结果表 + 输出摘要)。
6. `--review`: 验证通过后自动跑 reviewer agent (`--agent reviewer`) 生成 REVIEW.md。

`htask status` 读取 `.htask/state.json` 显示当前状态 (`idle/running/implementing/verifying/done/failed`)。
`htask report` 只根据已有 `.htask/state.json` 重新生成 REPORT.md, 不重跑实现。

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
