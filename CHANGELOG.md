# Changelog

## 1.1.0 (2026-11-16)

- 新增 `dispatch_update` / `dispatch_stop` / `dispatch_workers`：按 dispatch id 直接纠偏、停止或查看运行中的 worker。这三个工具使用独立名字，不依赖会被 Agent Teams per-Agent 注册覆盖的 `send_message` / `interrupt_agent`（后者按 teammate 名字寻址，对 dispatch worker 报 `active teammate not found`）。
- `write_scopes` 从提示升级为强制的写租约：同 workspace 内与 pending/running 任务重叠时，`dispatch` 直接拒绝并列出冲突单；确实需要重叠时用 `allow_overlap: true` 显式绕过。
- Host 启动时对账：持久化的 pending/running 条目如果对应的 worker 已不存在，标记为 `unknown`，不再永久停留在 running。
- 看板增加 `unknown` 状态展示；`dispatch_workers` 显示运行中 worker 的耗时与写域。

## 1.0.0

- 首个公开发布：dispatcher 预设（只读主对话 + `dispatch` / `dispatcher_board` 工具 + 实时调度看板）。
- Host 侧持久化看板与认证路由 `/api/dispatcher.board`；数据落在 `~/.dsh/storages/dispatcher/board.json`。
- 支持 git / 本地目录 / npm tarball 三种安装方式；`engines.dsh` 限定 DSH 兼容区间。
