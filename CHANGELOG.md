# Changelog

## 1.0.0

- 首个公开发布：dispatcher 预设（只读主对话 + `dispatch` / `dispatcher_board` 工具 + 实时调度看板）。
- Host 侧持久化看板与认证路由 `/api/dispatcher.board`；数据落在 `~/.dsh/storages/dispatcher/board.json`。
- 支持 git / 本地目录 / npm tarball 三种安装方式；`engines.dsh` 限定 DSH 兼容区间。
