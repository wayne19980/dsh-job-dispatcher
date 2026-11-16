# dsh-job-dispatcher · 调度台

> 一个只负责调度、不亲自执行的主对话预设 + 后台派发工具 + 实时 Web 调度看板，用于 DeepSeek Harness（DSH）Web profile。

当前版本：**1.2.0**（可寻址控制 + 写租约 + 重启对账 + 实时进度 + 验收分级/预算 + 断点续跑）

主对话自己干活会阻塞你：一条需求没做完，下一条只能排队。调度台把「收件」和「执行」拆开——主对话只做「理解 → 派发 → 回执」，实现和验证交给后台 worker，完成后由 worker 的通知唤醒主对话汇报。

适用于任何需要在同一个对话里连续提交多个独立任务、又不想排队等待的场景。

## 特性

- **主对话只读**：预设里没有 `write` / `edit` / `bash`，结构上不可能自己陷进长任务；
- **`dispatch` 工具**：派发后台 worker 并立即返回回执，worker 固定使用完整能力的 `standard` 预设；
- **`dispatcher_board` 工具**：主对话可随时列出当前调度看板；
- **可寻址/可纠偏**：`dispatch_update` / `dispatch_stop` / `dispatch_workers`，按 dispatch id 直接给运行中 worker 发消息、停当前 turn、查看运行列表；不依赖会被 Agent Teams per-Agent 注册覆盖的 `send_message` / `interrupt_agent`；
- **写租约**：`write_scopes` 不再只是提示，同 workspace 内与 pending/running 任务重叠会在派发时被拒绝（`allow_overlap: true` 可显式绕过）；
- **实时进度**：Host 监听 worker 会话事件，看板与 `dispatch_workers` 显示当前 step、最近工具、活动时间与工具调用数；
- **验收分级 + 预算**：`verification: quick|full`（默认 quick）+ `budget_minutes`，自动写进 brief；超预算先交代码 + 交接清单，看板显示耗时/预算；
- **断点续跑**：`dispatch(resume_of: "dXX")` 自动把上一条结果摘要作为 handoff 拼进新 brief；
- **实时调度看板**：Web 端输入框上方显示每个任务的状态、写域、worker 与结果摘要（2s 轮询）；
- **增量安装**：不改变默认预设、不依赖 Agent Teams 或第三方插件，可随时卸载。

## 环境要求

- DeepSeek Harness，Web profile（`dsh web`）；
- DSH 版本约 **0.2.1-alpha.4**（包内声明 `engines.dsh: >=0.2.1-alpha.4 <0.3.0`，版本不符会在安装/加载时被拦截）。

## 安装

### 方式 1：git（推荐）

```bash
dsh plugin --profile web add "git+https://github.com/wayne19980/dsh-job-dispatcher.git#main"
```

或让 DSH 会话里的 agent 执行：

```
plugin_manager action=install_bundle target=git+https://github.com/wayne19980/dsh-job-dispatcher.git#main
```

安装后 **重启 `dsh web`**。私有 fork 请先配好 git 凭据（SSH key 或 access token）。

升级：用新 tag 重新安装，例如 `git+https://github.com/wayne19980/dsh-job-dispatcher.git#v1.2.0`。

### 方式 2：本地目录

```bash
git clone https://github.com/wayne19980/dsh-job-dispatcher.git ~/dsh-job-dispatcher
dsh plugin --profile web add file:$HOME/dsh-job-dispatcher
```

### 方式 3：npm tarball

```bash
npm pack                     # 在仓库根目录生成 dsh-job-dispatcher-1.2.0.tgz
dsh plugin --profile web add file:/abs/path/dsh-job-dispatcher-1.2.0.tgz
```

安装成功的标志：profile 的 `package.json` 里出现依赖 `dsh-job-dispatcher`，并且 `dsh.profile.bundles` 包含它。

## 使用

1. 重启 `dsh web`；
2. 新建会话 → 预设选择「调度台 Job Dispatcher」（设置 → Agent presets 里也能看到，可设为新会话默认）；
3. 之后连续发需求即可。

自测一句话：

> 派一个 worker，在 /tmp/job-dispatcher-e2e.txt 写入 hello，然后回报。

预期：主对话秒回 `已派发 d1 → ...` 并结束本轮；输入框上方出现「调度看板」；worker 完成后主对话汇报结果、看板变为 done。

## 运行中调度管理

```text
dispatch_workers()                               # 看谁还在跑（dispatch id + worker id + 耗时 + 写域）
dispatch_update("d19", "前置断言已删，改成 ...")  # 纠偏：在 worker 的下一个 step 边界生效
dispatch_stop("d19")                            # 停当前 turn（保留 inbox 与 worker 会话）
dispatch_update("d19", "按新要求继续")           # 之后可再唤醒它继续
```

- 消息在 step 边界生效，**不会打断**正在执行的长工具调用（巡演、截图、长命令）；要硬停用 `dispatch_stop`，但已开始的工具调用按 cancel signal 尽力中止。
- 为什么不用 `send_message` / `interrupt_agent`：在启用 Agent Teams 的 profile 里，它们由团队插件按 teammate 名字注册在 agent 作用域，会盖掉 subagent 版本，对 dispatch worker 报 `active teammate not found`。
- 兄弟 worker 之间没有消息通道；跨 worker 的前提变化需要由调度台用 `dispatch_update` relay。

## 验收分级与预算

```text
dispatch("...", verification: "quick")   # 默认：typecheck/build + 与改动直接相关的最小检查
dispatch("...", verification: "full")    # 完整巡演 / 截图 / 多视口
dispatch("...", budget_minutes: 15)      # 超预算先交代码 + 交接清单
```

- 验收要求与预算由插件自动写进 brief；默认 `quick`，不要每单都跑完整巡演。
- 预算只是强提示，不会硬杀 worker；看板显示「耗时/预算」，超预算变红。
- 硬超时未实现：`interrupt` 需要 live ancestor Agent，父会话空闲时拿不到 authority。

## 断点续跑

```text
dispatch("继续上次的改动", resume_of: "d28")   # 自动把 d28 的结果摘要作为 handoff 拼进 brief
```

- 新 worker 先看到上次 summary 和「不要重复已完成工作」的提示；看板标记 `resumedFrom`。

## 工作原理

- `dispatch` 调用 `ctx.subagents.startActivation({ provider: 'spawn', delivery: 'parent', request: { agentPreset: 'standard', maxDepth: 2 } })`，立即返回任务 id 与 worker 会话 id；
- worker 完成通知作为本会话的新一轮输入唤醒主对话；同时 `activation.result` 把结果写进看板；
- 看板由 Host 路由 `GET /api/dispatcher.board?session=<id>` 提供，数据落在 `~/.dsh/storages/dispatcher/board.json`；
- 看板 UI 注册在 `conversation.input.dock` 插槽，只在该会话有任务时显示，普通会话不受影响；
- `dispatch` 在派发前按 workspace + `write_scopes` 前缀做写租约检查；Host 启动时把 worker 已不存在的 pending/running 条目对账为 `unknown`；
- Host 监听 worker 会话的 `session/event`，把 step、最近工具、最近活动时间与工具调用数写进内存进度（不落 board.json），`dispatch_workers` 与看板实时显示。

## 已知限制

- 只对**新会话**生效（已有会话的 preset 在创建时固定）；
- 不要在调度台里使用 `spawn_teammate` / `subagent_fork`：它们没有 preset 选择，fresh teammate 会继承父会话的只读预设；persona 已明文禁用；
- worker 的 approval 策略继承为 `never`：工作区内读写/命令可以跑，需要人工批准的操作会被自动拒绝；
- Host 重启时会把 worker 已不存在的 pending/running 条目对账为 `unknown`（保留条目，不删除历史）；
- `dispatch_update` 的消息在 worker 的下一个 step 边界生效，不打断正在跑的工具调用；`dispatch_stop` 只停当前 turn，之后可用 `dispatch_update` 续跑。
- `verification: quick` 与 `budget_minutes` 是给 worker 的强提示，不是硬超时；需要立即停止仍用 `dispatch_stop`。
- 修改并重新安装后，替换已安装包的 JS 需要重启 Host 才能加载新模块（client 半可热替换）。

## 卸载

```bash
dsh plugin --profile web remove dsh-job-dispatcher
```

或让 agent 执行 `plugin_manager action=remove_bundle target=dsh-job-dispatcher`，然后重启 `dsh web`。

## 仓库结构

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | 声明 Host 行 `dispatcher-host` 与 agent preset `dispatcher` |
| `index.js` | Host 半：持久化看板 + 认证路由 `/api/dispatcher.board` |
| `tool.js` | preset 半：`dispatch` / `dispatcher_board` 工具 |
| `client.js` | Web 半：`conversation.input.dock` 里的调度看板 |
| `locale/`、`tool-locale/`、`icon.svg` | Plugin Manager 显示元数据与图标 |
| `package.json` | bundle 清单（`dsh.bundle.patch` + `dsh.client`） |

## 开发

```bash
# 把仓库链接安装到当前 profile
dsh plugin --profile web add file:/abs/path/to/dsh-job-dispatcher
# 或让 agent 调 plugin_manager install_bundle target=/abs/path/to/dsh-job-dispatcher

# 改完重新安装一次；Host 半的 JS 需要重启 dsh web 才加载新模块
```

- 看板数据：`~/.dsh/storages/dispatcher/board.json`（按会话分组，删除即清空看板）。
- **改包名时要同步三处**：`package.json` 的 `name`、`client.js` 里 `window.__ModuleLoader__.load({ id })`、`cordis.patch.yml` 里 preset 对 `<name>/tool` 的引用。
- 同一 profile 不要同时安装两个声明相同 preset id（`dispatcher`）的 bundle，否则后加载的声明会失败。

## 实战反馈与路线图

- 2026-11-13 的一次真实使用总结（脱敏）：[docs/field-notes/2026-11-13.md](docs/field-notes/2026-11-13.md)，含 P0/P1/P2 需求与 v1.1–v1.3 路线图。

## 许可证

当前仓库未附开源许可证（`private: true`，仅供学习/内部试用）。如需对外分发或发布 npm，请补充 `LICENSE` 并自行去掉 `private`。
