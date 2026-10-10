# DSH 插件开发 — 任务交接（暂停于调研完成、编码未开始）

> 目标：给 DSH Web GUI **左侧栏「工作区」面板**加拖拽 —— 把会话行拖到别的工作区，真正改变它的归属（workbuddy 那种手感）。
> 状态：**调研 100% 完成，技术路径已锁定并逐条验证过；插件代码尚未落盘。**
> 工作区：`E:\dsh插件开发`（本文件所在目录）

---

## 1. 要实现什么

左侧栏（官方「工作区」浏览器，插槽 `sidebar.workspaces`）当前只支持：

- 同一工作区**内部**用拖拽调整会话顺序
- 拖拽工作区行调整工作区顺序

要加的是：

1. 会话行拖到**另一个工作区的头行** → 该会话归入那个工作区（追加到末尾）
2. 会话行拖到**另一个工作区下的某个会话行**上半/下半 → 归入那个工作区并插到该会话前/后
3. 同工作区内拖拽 → 不拦截，交还官方排序逻辑
4. 拖拽中给源行/目标行视觉反馈

---

## 2. 已确认的事实（带证据，全部为本机实测 / 反汇编 asar 得到）

### 2.1 左侧栏是公开插槽，官方实现可从 asar 提取

`sidebar.workspaces`（single）。官方占用者 `/lib/client.js` 已提取到
[`reference/ui-workspace-client.js`](reference/ui-workspace-client.js)。子洞：
`sidebar.workspaces.directoryFlow`、`sidebar.workspaces.session.menu.item`、
`sidebar.workspaces.session.row.action`、`sidebar.session.row.leading`。

### 2.2 DOM 契约（决定选择器怎么写）

| 元素 | DOM | 证据 |
|---|---|---|
| 工作区头行 | `<div class="<hash>_projectRow" data-row-key="workspace:<workspaceId>" role="treeitem" draggable>` | 提取件 1285-1291 行 |
| 会话行 | `<div class="<hash>_sessionRow" data-row-key="session:<sessionId>" role="treeitem" draggable>` | 提取件 1590-1602 行 |
| 分节容器 | `<div class="<hash>_groupSection">`，头行是它的子节点，会话行也是 | 提取件 2481-2544 行 |

**关键**：`data-row-key="workspace:<X>"` 里的 `X` 就是 `workspaceId`，不是别的 key。
证据：`buildGroup(workspace.workspaceId, workspace.workspaceId, …)` —— key 和 workspaceId 传的是同一个值
（提取件 **434** 行）。

CSS module 的类名带 hash 前缀（当前 `_9lTDKa_`），**会随版本变**；`data-row-key` 是官方自己用于
reveal/滚动定位的语义锚点，更稳。写选择器时优先 `[data-row-key^="session:"]` /
`[data-row-key^="workspace:"]`，`[class*="_groupSection"]` 只作兜底。

### 2.3 官方**不支持**跨工作区移动（这是本插件存在的理由）

`Workspace.insertSessionBefore(sessionId, beforeSessionId)` 会先校验
`record.sessionIds.includes(sessionId)`，不属于该工作区就直接抛
`WorkspaceMoveInvalidError`（→ 线上错误码 `workspace/move-invalid`）。
证据：`reference/workspace-lib.js` **130-133** 行；host 包装见 `reference/ws-controller-host.js` **275-288** 行。

客户端侧也一致：官方拖拽只在 `drag.accountKey === group.key` 时才 `preventDefault`
（提取件 2545-2559 行）。**跨工作区拖拽官方完全不响应，正好留给我们接管。**

### 2.4 会话归属 = session header 里的 `cwd`（核心机制）

```js
// reference/workspace-lib.js:102-104
get sessionIds() {
  return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);
}
// reference/workspace-lib.js:178（mutate 里同一条剪枝）
const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path);
```

- `host.sessionPath(id)` → `WorkspaceRegistry.sessionPaths`（内存 Map）
- 该 Map 在 host 启动时从 `ctx.sessionPersistence.list()` 的每个 header 重建
  （`listStoredHeaders()` = `(await this.ctx.sessionPersistence.list()).map(s => s.header)`，
  `reference/workspace-lib.js` **892-893** 行）
- 所以 **`workspace.json` 里的 `sessionIds` 只是顺序账本，成员资格由 header.cwd 说话**，
  任何不匹配的 id 会在下一次写入时被剪掉

**结论：想让一个会话换工作区，必须改它的 session header 的 `cwd`。**

### 2.5 会话在磁盘上的布局与路径编码

```text
<root>/                                  # root 默认 C:\Users\Admin\.dsh\sessions
  --<projectKey(cwd)>--/                 # 项目目录（cwd 决定）
    <encodeSegment(sessionId)>/          # 会话目录
      session.v4.jsonl.zstd              # 当前 generation，zstd 帧 + jsonl
```

编码函数原样抄自 `reference/jsonl-lib.js` **875-893** 行：

```js
function projectKey(cwd) {
  let readable = '', separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i), ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch; separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0'); separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
```

实测校验（与磁盘目录逐字吻合）：

| cwd | 目录名 |
|---|---|
| `E:\dsh插件开发` | `--E-dsh~63D2~4EF6~5F00~53D1--` |
| `E:\光影逆向开发` | `--E-~5149~5F71~9006~5411~5F00~53D1--` |
| `C:\Users\Admin\Documents\deepseek-harness\default-workspace` | `--C-Users-Admin-Documents-deepseek-harness-default-workspace--` |

`encodeSegment(sessionId)`（**853-865** 行）：`session-<uuid>` 全部是安全字符，**原样不变**。

### 2.6 日志是「独立 zstd 帧拼接」，header 就是第一帧（改动安全的根据）

实测本机 `session-e1897ec2…/session.v4.jsonl.zstd`（565,760 字节）：

```
frame magic offsets: [0, 183, 331, 770, 29812, …]   (共 239 个帧)
header frame = bytes[0 .. 183)
解压后 191 字节：
{"type":"session","version":4,"id":"session-e1897ec2-…","createdAt":1791525422388,
 "cwd":"E:\\dsh插件开发","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}\n
```

- 帧之间彼此独立 → **改 header 只需「新 header 帧 + 原文件第 183 字节之后的字节原样复制」**，
  事件数据一个字节都不碰。这是整个方案风险最低的一环。
- 帧边界用 magic `28 B5 2F FD` 扫第二个出现位置即得；拿解压结果当校验
  （能解出 `type==='session' && id===sessionId` 才算边界正确）——见 `tools/inspect-session.mjs`。
- 会话日志还有一份**投影缓存** `~/.dsh/storages/session_projcache/sessions/<id>.json`，
  里面 `record.identity.cwd` 同样记着 cwd。它是可重建的缓存，但为了一致性也该一起改。

### 2.7 host 侧插件形态与路由注册

- host 半边是 ESM 插件，**命名导出**：`export { Config, apply, inject, name }`
  （见 `dsh-better-sidebar/lib/index.js` 末尾）
- 注册 HTTP 路由（照抄 better-sidebar 的写法，`lib/index.js` 4232-4271 行）：

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',              // 或 'exact'
  path: '/session-drag-move/api',
  handler: async (req, res) => { /* … */ },
}), 'label')
```

`inject` 里要写 `webServer`；另有 `workspaceRegistry`。
（better-sidebar 还套了一层 `fence(req)` 做可信来源校验；局域网部署要放行 `trustedHosts`。）

### 2.8 客户端插件契约（零构建纯 JS）

`dsh-better-workspace/src/client.js` **21-27** 行给出标准形态：

```js
window.__ModuleLoader__.load({
  id: '<包名>',
  factory: (require) => {
    const React = require('react')                       // 纯 DOM 增强就不需要它
    const storeKit = require('@deepseek-ai/dsh-client-store')
    return { name: '<包名>', inject: [...], apply }
  },
})
```

- 客户端插件**不需要构建**：DSH 通过包的 `exports["./client"]` 把它挂进 boot graph，
  用 `/plugins/<id>/client.js` 提供
- 官方 CSS 注入惯例：`document.querySelector('style[data-plugin-css="<包名>/x.css"]')` 判重后再插
- host 半边的改动经 storage domain 变更事件推流到客户端 →
  workspace 的 `sessionIds` 一变，左侧栏（`groupByWorkspace`）就重排，**不用手动刷新**

### 2.9 安装位置与挂载

- profile 根：`C:\Users\Admin\.dsh\profiles\desktop`
- 包要放进 `…\profiles\desktop\node_modules\<包名>\`
- 在 `…\profiles\desktop\cordis.patch.yml` 里加（照抄 better-workspace 的写法）：

```yaml
- insert:
    - id: session-drag-move
      name: 'dsh-session-drag-move'
```

- 参考：`dsh-better-workspace` 自带 `cordis.patch.yml` + `dsh.bundle.patch`，
  装完重启 DSH 生效
- **注意**：该 profile 里 `better-workspace` 与 `workspace-explorer` 当前是 `disabled: true`，
  所以左侧栏现在是**官方原版**——我们的 DOM 增强正好对着官方结构写。若日后启用
  better-workspace（它整区替换 `sidebar.workspaces`），它的自绘 DOM 也用了
  `bw-row`/`bw-drop-*` 另一套结构，需要另加一组适配分支（它的会话行同样可拖拽，
  但它只做「名称分组前缀」改写，不迁移工作区）。

---

## 3. 实现方案（敲定版）

### 3.1 两半边的分工

```
client 半边  ── DOM 增强：捕获会话行的跨工作区拖拽（capture 阶段抢在 React 委托之前）
             └─ drop 时 POST /session-drag-move/api/move { sessionId, targetWorkspaceId, beforeSessionId? }
host 半边    ── 校验 → 改 header.cwd → 搬会话目录 → 更新 registry 三处状态 → 返回
```

### 3.2 客户端拖拽逻辑

```js
// 1) dragstart（capture）
const row = e.target.closest('[data-row-key^="session:"]')
if (!row) return                              // 工作区行的拖拽留给官方
state.sessionId = row.dataset.rowKey.slice('session:'.length)
state.fromWs    = owningWorkspaceId(row)      // 见下

// 2) dragover（capture）
const target = dropTargetOf(e.target)         // { workspaceId, beforeSessionId? }
if (!target || target.workspaceId === state.fromWs) return  // 同组 → 不拦，官方排序
e.preventDefault(); e.stopPropagation()       // 官方在跨组时不 preventDefault，必须自己来
e.dataTransfer.dropEffect = 'move'
highlight(target)

// 3) drop（capture）→ 调 host
await fetch('/session-drag-move/api/move', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) })

// 4) dragend → 清高亮
```

`owningWorkspaceId(rowEl)`：

```js
function owningWorkspaceId(rowEl) {
  let el = rowEl
  while (el) {
    for (const child of el.children) {
      const key = child.dataset?.rowKey
      if (key?.startsWith('workspace:')) return key.slice('workspace:'.length)
      const nested = child.querySelector?.('[data-row-key^="workspace:"]')
      if (nested) return nested.dataset.rowKey.slice('workspace:'.length)
    }
    el = el.parentElement
  }
  return ''
}
```

`dropTargetOf(el)`：

- `el.closest('[data-row-key^="workspace:"]')` → `{ workspaceId }`（追加到末尾）
- 否则 `el.closest('[data-row-key^="session:"]')` → 它所属的 workspaceId + 该 sessionId 作 anchor
  （用 `getBoundingClientRect()` 中点判上半/下半；下半时 anchor 取该组内下一行的 id）
- 未分组分组（`data-row-key="workspace:"`，workspaceId 为空）→ 不当作目标

### 3.3 host 半边 move 流程（顺序很关键）

```js
const registry = ctx.workspaceRegistry
const target = registry.get(targetWorkspaceId)               // 公开：get(id) → WorkspaceEntity
if (!target) → 404 workspace-not-found
const source = registry.list().find(w => w.sessionIds.includes(sessionId))

// 同一工作区 → 只是排序，走官方那条路
if (source?.id === targetWorkspaceId) { await target.insertSessionBefore(sessionId, beforeSessionId); … }

// 1) 读旧 header（registry.host.readSessionHeader 是公开字段上的方法）
const header  = await registry.host.readSessionHeader(sessionId)
const oldCwd  = header.cwd
const newCwd  = target.path

// 2) 定位旧会话目录（先按 projectKey 直接算，失败则扫 root 下一层兜底）
const oldDir = await locateSessionDir(root, oldCwd, sessionId)

// 3) 改 header：解第一帧 → 改 cwd → 重压缩 → 拼回尾部
//    写入新路径 <root>/--projectKey(newCwd)--/<id>/<session.vXX.jsonl[.zstd]>，flag 'wx' 不覆盖
//    写完做一次「重新解压 + JSON 校验 id/cwd」自检

// 4) 旧目录移出 root（默认移到 <dirname(root)>/session-mover-backup/<id>-<ts>，同盘 rename）
//    ⚠ 必须移出 root：留着会被 sessionPersistence.list() 当成重复 id 扫到

// 5) 让 registry 三处内存状态跟上（顺序：先改索引，再动账本）
registry.headers.set(sessionId, newHeader)                    // header 缓存
registry.host.rememberSessionPath(sessionId, newCwd)          // sessionPaths（= host 接口上的方法）
await target.attachSession(sessionId)                         // 会重读 header 校验 cwd === target.path ✓
await target.insertSessionBefore(sessionId, beforeSessionId)  // 排序
if (source) await source.detachSession(sessionId)             // 源账本收尾

// 6) 同步投影缓存 ~/.dsh/storages/session_projcache/sessions/<id>.json 的 record.identity.cwd
```

关于第 5 步：`sessionPaths` / `headers` 是 `WorkspaceRegistry` 上的**普通字段**（不是 `#private`），
JS 里可以直接写；`host.rememberSessionPath` 更是 registry 自己 `host` 对象上的方法。
这属于「碰官方内部结构」，能跑但**版本敏感**——所有访问都要先 feature-probe，
拿不到就返回结构化错误而不是抛栈。

### 3.4 安全阀（必须做）

- 会话正在跑 → 拒绝（`ctx.sessions` 查活跃；拿不到 API 时在客户端按状态灯兜底拦一次）
- 目标是同一工作区 → 交给官方
- 新路径已存在文件 → 拒绝，不动任何东西
- 旧文件先备份不删除；失败可回滚
- 只在 header 帧正确解出 `type==='session'` 且 id 匹配时才写
- host 路由默认只接受 loopback 来源（可配置放开局域网）

---

## 4. 已产出的文件（都在 `E:\dsh插件开发`）

### 可复用工具

| 文件 | 作用 |
|---|---|
| [`tools/asar.mjs`](tools/asar.mjs) | 零依赖 Electron **asar 读取器**：`list` / `cat` / `extract`。注意 header 是双层 Pickle，JSON 从偏移 **16** 开始，文件数据基址 = `8 + headerSize` |
| [`tools/scan.mjs`](tools/scan.mjs) | 大文件字节扫描 / 偏移提取 / asar header hex dump。asar 内文件是明文连续存放，命中即可直接读上下文 |
| [`tools/inspect-session.mjs`](tools/inspect-session.mjs) | 打印会话日志的 header 帧与全部帧边界（改 header 的验证器） |

调用方式（**必须用 DSH 自带 node**，系统 PATH 里没有）：

```powershell
$node='C:\Users\Admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node tools\asar.mjs list 'D:\DeepSeek Harness\resources\app.asar' 'workspace'
& $node tools\inspect-session.mjs '<某个 session.v4.jsonl.zstd>'
```

**坑**：pwsh 里 `& $node script args 2>&1 | ...` 会触发 `NativeCommandError` 并把 stderr 打成
CLIXML 二进制；用 `cmd /c "… > out.txt 2>&1"` 再 `Get-Content` 才干净。

### 从 asar 提取的官方源码（分析底稿）

| 文件 | 内容 |
|---|---|
| `reference/ui-workspace-client.js` | 官方左侧栏实现（DOM 契约、拖拽、分组派生都在这里） |
| `reference/workspace-lib.js` | `@deepseek-ai/dsh-workspace` 领域层 —— **归属机制的真源** |
| `reference/ws-controller-host.js` / `ws-controller-client.js` / `ws-service.js` | workspace 控制器的 host/client/RPC 面 |
| `reference/jsonl-lib.js` | 会话持久化后端 —— **`projectKey` / `encodeSegment` / header 帧的真源** |
| `reference/session-lib.js` | `@deepseek-ai/dsh-session` |
| `reference/persistence-lib.js` + 两份 `*README.zh.md` | 持久化服务契约与磁盘布局说明 |
| `reference/*-README.zh.md` | 官方中文文档（`dsh-workspace` / `ui-workspace` / `persistence`） |

### 尚未创建（下一步要写）

```
package.json            包名建议 dsh-session-drag-move，dsh.bundle.patch + dsh.client 两段
cordis.patch.yml        insert: [{ id: session-drag-move, name: dsh-session-drag-move }]
lib/index.js            host 半边（export { Config, apply, inject, name }）
lib/session-log.js      header 帧读写 + projectKey/encodeSegment + 目录定位（从 §2.5/§2.6 抄）
lib/client.js           client 半边（window.__ModuleLoader__.load）
README.md               功能、原理、安装、风险
icon.svg                可选
```

---

## 5. 下一步（有序）

1. 写 `lib/session-log.js`（纯函数，最容易先写完 + 单测）
   - `projectKey` / `encodeSegment` / `locateSessionDir` / `readHeaderFrame` / `rewriteHeaderCwd`
   - 用 `tools/inspect-session.mjs` 的同一套帧扫描逻辑，保证边界判定一致
2. 写 `lib/index.js`：路由 + move 流程（§3.3），先把「同工作区排序」这条快路径打通
3. 写 `lib/client.js`：capture 阶段拖拽 + 高亮 + 调路由（§3.2）
4. `package.json` / `cordis.patch.yml` / `README.md`
5. 装到 `C:\Users\Admin\.dsh\profiles\desktop\node_modules\` 并在 profile 的
   `cordis.patch.yml` 加 insert 行 → **重启 DSH**
6. 验收（找一个**非当前、非运行中**的会话试）：
   - 拖到别的工作区头行 → 左侧栏立刻重排到目标工作区下
   - 拖到目标工作区某个会话行上下 → 插到正确位置
   - 同工作区内拖拽 → 仍是官方排序，没有二次触发
   - 刷新页面 / 重启 DSH 后归属保持
   - 备份目录里能找到旧会话目录，可回滚

---

## 6. 环境备注（省得下次重新踩）

- **pwsh 在新会话默认沙箱下起不来**：`[exit code: 3221225794]`（`0xC0000142` DLL init failed），
  任何命令都没输出。本会话是把权限切到 `danger-full-access` 后才正常的。
  后续如果又哑火，先确认沙箱模式，而不是怀疑命令写错。
- Node 在 `C:\Users\Admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  （v24.21.0，支持 `node:zlib` 的 `zstdCompressSync` / `zstdDecompressSync`）
- DSH 安装目录：`D:\DeepSeek Harness`；前端与所有 `@deepseek-ai/*` 包都打包在
  `resources/app.asar`（约 121 MB，12967 个条目）里，只有少数二进制在
  `app.asar.unpacked`
- 系统提示里写的 checkout 路径 `resources\app.asar\dsh\` 用 rg 打不开（asar 不是目录），
  必须用 `tools/asar.mjs`
- 权威数据落点：
  - `~/.dsh/storages/workspace.json` —— 工作区表 + `sessionIds` 顺序账本（**不含**成员资格真源）
  - `~/.dsh/sessions/--<projectKey>--/<id>/session.vN.jsonl[.zstd]` —— 会话日志，**归属真源在这**
  - `~/.dsh/storages/session_projcache/sessions/<id>.json` —— 投影缓存（含 `identity.cwd`）
  - `~/.dsh/profiles/desktop/cordis.patch.yml` —— profile 补丁层（插件开关、模型配置都在这）

---

## 7. 风险评估

| 风险 | 缓解 |
|---|---|
| 写坏会话日志 = 丢数据 | 只重写第一帧；尾部原样复制；写完重新解压自检；旧目录只备份不删 |
| 改动 registry 内部字段（`headers` / `sessionPaths`）随版本失效 | 全部 feature-probe，探测失败返回结构化错误；插件包内标注适用版本 |
| 会话正在运行被搬走 | host 端活跃检查 + 客户端按状态灯拦一次 |
| 旧目录留在 root 导致重复 id | 强制移出 root（同盘 rename 到 `session-mover-backup/`） |
| 装了 better-workspace 时 DOM 不同 | 现在它是 disabled（官方原版结构）；若启用需补 `bw-*` 选择器分支 |
| 未分组分组（workspaceId 为空）不是合法目标 | `dropTargetOf` 里直接排除 |
