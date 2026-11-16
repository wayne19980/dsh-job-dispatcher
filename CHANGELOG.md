# Changelog

## 1.2.0 (2026-11-16)

- 结构化进度：Host 监听子会话的 `session/event`（step、tool/call、assistant/message、turn），在 `dispatch_workers`、`dispatcher_board` 与 Web 看板上显示当前 step、最近工具、最近活动时间与工具调用次数；进度是进程内状态，不写入 board.json。
- 验收分级：`dispatch` 新增 `verification: quick|full`（默认 `quick`），自动把验收要求写进 brief；`quick` 只要求类型检查/构建与改动直接相关的最小检查，`full` 才跑完整巡演/截图/多视口。
- 时间预算：`dispatch` 新增 `budget_minutes`，注入 brief 并要求 worker 超预算时先交代码 + 交接清单；看板显示耗时/预算并在超预算时变色。硬超时未实现（受 interrupt 需要 live ancestor Agent 限制），预算属于强提示。
- 断点续跑：`dispatch(resume_of: "dXX")` 自动把上一条 dispatch 的结果摘要作为 handoff 拼进新 brief，并在看板标记 `resumedFrom`。
- 看板展示进度、验收级别与预算。

## 1.1.0 (2026-11-16)

- 新增 `dispatch_update` / `dispatch_stop` / `dispatch_workers`：按 dispatch id 直接纠偏、停止或查看运行中的 worker。这三个工具使用独立名字，不依赖会被 Agent Teams per-Agent 注册覆盖的 `send_message` / `interrupt_agent`（后者按 teammate 名字寻址，对 dispatch worker 报 `active teammate not found`）。
- `write_scopes` 从提示升级为强制的写租约：同 workspace 内与 pending/running 任务重叠时，`dispatch` 直接拒绝并列出冲突单；确实需要重叠时用 `allow_overlap: true` 显式绕过。
- Host 启动时对账：持久化的 pending/running 条目如果对应的 worker 已不存在，标记为 `unknown`，不再永久停留在 running。
- 看板增加 `unknown` 状态展示；`dispatch_workers` 显示运行中 worker 的耗时与写域。

## 1.0.0

- 首个公开发布：dispatcher 预设（只读主对话 + `dispatch` / `dispatcher_board` 工具 + 实时调度看板）。
- Host 侧持久化看板与认证路由 `/api/dispatcher.board`；数据落在 `~/.dsh/storages/dispatcher/board.json`。
- 支持 git / 本地目录 / npm tarball 三种安装方式；`engines.dsh` 限定 DSH 兼容区间。
