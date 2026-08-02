# Hermes Task Runner 下一阶段演进建议

## 当前定位

根据当前版本的 Hermes Task Runner：

-   Task Lifecycle 管理
-   状态机
-   Human Approval Gate
-   OpenCode 调度
-   Review 流程
-   Verify 流程
-   JSON API
-   History / Log

项目已经从简单脚本升级为：

> AI Software Agent Orchestrator v0.1

下一阶段重点不是增加更多 Agent，而是增强 Orchestration 能力。

------------------------------------------------------------------------

# v0.2 Adaptive Workflow Orchestrator

目标：

让 Hermes 不只是执行固定流程，而是能够：

-   分析任务
-   选择 Agent
-   动态生成 Pipeline
-   管理失败恢复
-   沉淀开发知识

------------------------------------------------------------------------

# 1. Task Planner（任务规划器）

## 目标

在执行任务之前增加分析阶段。

当前：

    TASK.md
     |
    OpenCode

升级：

    TASK.md
     |
    Task Planner
     |
    Pipeline
     |
    Agents

------------------------------------------------------------------------

## 示例

输入：

    实现 MCP OAuth 登录

输出：

``` json
{
  "complexity": "high",
  "risk": [
    "security",
    "database"
  ],
  "pipeline": [
    "architect",
    "developer",
    "security-reviewer",
    "tester"
  ]
}
```

------------------------------------------------------------------------

# 2. Dynamic Pipeline（动态流程）

目前流程：

    Developer
     |
    Review
     |
    Verify

升级为根据任务类型决定流程。

------------------------------------------------------------------------

## Bug 修复

    Developer
     |
    Test
     |
    Verify

------------------------------------------------------------------------

## 架构修改

    Architect
     |
    Developer
     |
    Reviewer
     |
    Security Review
     |
    Verify

------------------------------------------------------------------------

## 文档任务

    Writer
     |
    Proofread

------------------------------------------------------------------------

# 3. Agent Adapter Layer（Agent 抽象层）

当前如果绑定 OpenCode：

    Hermes
     |
    OpenCode

建议：

    Hermes
     |
    Agent Interface
     |
    ----------------
    |      |       |
    OpenCode Codex Claude

统一接口：

    agent.run({
     task,
     context,
     model
    })

未来可以根据任务自动选择模型。

------------------------------------------------------------------------

# 4. Event System（事件系统）

将状态变化事件化。

例如：

    CREATED
     |
    event
     |
    notification

------------------------------------------------------------------------

事件：

-   task.created
-   task.started
-   task.review_failed
-   task.completed
-   task.waiting_human

用途：

-   Telegram 通知
-   Web Dashboard
-   自动恢复
-   Metrics 收集

------------------------------------------------------------------------

# 5. Artifact Bundle（任务产物归档）

建议每个任务独立目录：

    .htask/

    tasks/

     task-id/

       TASK.md
       PLAN.md
       REVIEW.md
       REPORT.md
       diff.patch
       metrics.json
       timeline.json

优势：

-   可复盘
-   可审计
-   可训练未来 Agent

------------------------------------------------------------------------

# 6. Failure Recovery（失败恢复）

当前：

    FAILED
     |
    人工处理

升级：

    FAILED
     |
    Failure Analyzer
     |
    Fix Agent
     |
    Verify

例如：

测试失败：

    npm test failed

    Expected 401 got 500

自动：

1.  分析错误
2.  修改代码
3.  重新验证

------------------------------------------------------------------------

# 7. Human Approval Policy（人工审批策略）

增加规则：

``` yaml
approval:
  required:
    - database_change
    - dependency_add
    - architecture_change
```

例如：

Agent 添加依赖：

    composer require xxx

    暂停

    需要人工确认

------------------------------------------------------------------------

# 8. Git Worktree 并行任务

支持：

    main

    ├── task/auth
    ├── task/api
    └── task/docs

每个 Agent 独立工作区。

收益：

-   多任务并行
-   避免代码污染
-   支持多个 Agent 同时运行

------------------------------------------------------------------------

# 9. Metrics System（指标系统）

结合 TokenTracker：

记录：

``` json
{
  "task": "mcp-auth",
  "tokens": 45000,
  "duration": "38m",
  "iterations": 3,
  "success": true
}
```

长期分析：

-   哪种任务适合哪个模型
-   哪些 Prompt 效果最好
-   Token 消耗优化

------------------------------------------------------------------------

# 推荐开发顺序

## 第一阶段（最高价值）

1.  Task Planner
2.  Event System
3.  Artifact Bundle

## 第二阶段

4.  Agent Adapter
5.  Failure Recovery

## 第三阶段

6.  Worktree Parallel
7.  Metrics Dashboard

------------------------------------------------------------------------

# 最终目标

Hermes Task Runner:

从：

    Task Runner

升级为：

    AI Software Delivery Orchestrator

最终架构：

                     Hermes Orchestrator

                             |
                  Task Intelligence Layer

            +----------------+----------------+

         Planner          Router          Policy

            |                |              |

        Developer       Reviewer       Human Gate

                             |

                        Verification

                             |

                        Git / Release

                             |

                        Memory System
