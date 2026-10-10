# dsh-session-drag-move

左侧栏「工作区」面板里，把**会话拖到别的工作区**——真正改归属，不只是改个名字分组。

官方只支持同一工作区内部拖排序；跨工作区拖拽是**完全不响应**的（`onDrop` 只在
`drag.accountKey === group.key` 时生效，`insertSessionBefore` 也拒绝不属于本工作区的会话）。
这个插件只接管这段本来就是空的行为，同工作区拖拽照旧交给官方。

## 它到底做了什么

DSH 里会话的归属是**派生的，不是存出来的**：

```
工作区拥有「会话日志 header 的 cwd 等于本工作区路径」的那些会话
```

`~/.dsh/storages/workspace.json` 里的 `sessionIds` 只是顺序账本，path 不匹配的 id
会在下次写入时被剪掉。所以换工作区必须改**会话日志 header 里的 cwd**。

会话日志是独立 Zstandard 帧的拼接，第一帧就是 header：

```
<root>/--<projectKey(cwd)>--/<sessionId>/session.v4.jsonl.zstd
         └ 项目目录由 cwd 决定               └ 首帧 = header，其后每帧 = 一个追加批次
```

帧彼此独立，所以移动 = **重新压缩新的第一帧 + 原文件第二个 magic 之后的字节原样复制**，
事件数据一个字节都不动。写完再自行解压校验一遍，然后把旧目录移到备份区。

最后同步正在运行的进程（否则要重启才生效）：更新 registry 的 header 缓存与
session-path 索引，再走官方的 `attachSession` / `insertSessionBefore` / `detachSession`。
`attachSession` 会重新读 header 并校验 cwd，它成功就证明存储层改动真的落盘了。

## 安装

```powershell
# 1. 放进 profile 的 node_modules
Copy-Item 'E:\dsh插件开发' "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-drag-move" -Recurse -Force

# 2. 在 profile 的 cordis.patch.yml 里加一行
#   - insert:
#       - id: session-drag-move
#         name: 'dsh-session-drag-move'

# 3. 重启 DSH
```

也可以用官方 CLI：

```bash
dsh plugin --profile desktop add dsh-session-drag-move
```

## 配置（host 半边）

| 字段 | 默认 | 含义 |
|---|---|---|
| `root` | `~/.dsh/sessions` | 会话存储根目录 |
| `backupRoot` | `<root>/../session-drag-move-backup` | 移动前的会话目录停放处 |
| `allowRemote` | `false` | 默认只接受 loopback 请求；局域网部署需显式打开 |

## 使用

- 拖会话行到**另一个工作区的头行** → 归入该工作区（追加到末尾）
- 拖会话行到**另一个工作区的某个会话行**上半 → 插到它前面；下半 → 插到它后面
- 同工作区内拖拽 → 不拦截，仍是官方排序
- 运行中 / 当前会话会被拒绝

## 安全边界

- 只重写第一帧；尾部原样复制；写完重新解压自检（id + cwd + 能解出 session header）
- 旧目录**移出** sessions 根（留着会被扫到重复 id），停在备份区，可回滚
- 目标文件已存在则整体拒绝，不做半截写入
- 跨区移动前检查会话是否在运行

## 已知限制

- 依赖 `workspaceRegistry` 的内部字段（`headers` / `sessionPaths` / `host.rememberSessionPath`）
  同步运行状态。这些是普通字段不是 `#private`，能用，但**版本敏感**——所有访问都做了
  feature-probe，探测不到会返回结构化错误而不是抛栈。
- 目标针对官方原版左侧栏。若启用 `dsh-better-workspace`（它会整区替换
  `sidebar.workspaces`，且不迁移工作区），其自绘 DOM 是另一套结构，需要另加适配分支。
- 投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json` 里的
  `record.identity.cwd` 目前未改写（可重建缓存，不影响归属）。

## 开发

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --test tests\smoke.mjs
```

测试覆盖路径编码（与本机磁盘目录逐字比对）、header 帧定位与校验、
真实会话日志的 cwd 改写 round-trip（含尾部字节完全一致断言）。

## 许可证

MIT
