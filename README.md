# DeepSeek Harness 安装器（`@local/dsh-installer`）

一个 DSH（DeepSeek Harness）Host 插件 bundle：**从 npm registry 下载/安装 dsh 命令行**，
**按功能描述搜索可安装的插件**（也可以直接看最火的那批），并在**当前 profile** 里
安装、查看、启停、卸载**插件组合包**。

零运行时依赖（只用 Node 内置模块），不 import 任何 `@deepseek-ai/*` 包，
因此安装它本身不需要额外下载任何东西。

- 许可证：[MIT](./LICENSE)
- 仓库：<https://github.com/hellogitd/dsh_harness_install>
- 行 id：`dsh-installer`
- 包名：`@local/dsh-installer`

---

## 1. 它提供什么

| 工具 | 作用 | 关键行为 |
|---|---|---|
| `dsh_harness_install` | 下载并安装/升级 `@deepseek-ai/dsh` | 默认 `npm install -g @deepseek-ai/dsh@latest`；也支持 `mode=project` + `dir` 装到指定目录；装完读磁盘上的 `package.json` 确认版本，再用该版本自带的 `dsh --version` 做一次真实校验；`dryRun=true` 只回显命令 |
| `dsh_harness_download` | 只下载发布 tarball，不安装 | 从 registry 解析 `dist.tarball`，下载后用 `dist.integrity`(sha512) / `dist.shasum`(sha1) 校验再落盘；调用方显式传的 `integrity` 是**钉死值**，不匹配就拒绝写入；产物可直接 `npm i -g <文件>` 离线安装 |
| `dsh_plugin_search` | **搜索可安装的插件，让用户挑** | 把用户的功能描述（中英文都行）转成 npm 搜索，只返回确实声明了 `dsh.bundle.patch` 的组合包；`sort="popular"` 按**上月下载量**列出最火的插件；结果带 1 起编号、包名@版本、一句话说明、下载量、license、是否已装 |
| `dsh_plugin_install` | 在当前 profile 安装插件组合包 | 走 `ctx.pluginManager.installBundle()`，与 `dsh plugin` / `plugin_manager` **同一套 pnpm 实现、同一把 profile 写锁**；默认先用 `inspect()` 预检 spec；`fromSearch=<编号>` 可以直接安装搜索结果的第 N 个；返回 `application`/`warnings`/`pendingBuilds` 等落盘与激活结果 |
| `dsh_plugin_manage` | 查看 / 启停 / 卸载 profile 插件 | `action=list` 列出组合包与插件条目（含 `enabled`、`fiberPhase`、只读原因、错误码）；`action=set_enabled` 用 `name` 切组合包、或用 `entryId` 切单个条目；`action=remove` 卸载 profile 自有的组合包 |

典型用法：

```text
dsh_harness_install   { "version": "0.2.0-rc.2", "mode": "project", "dir": "D:\\tools\\dsh" }
dsh_harness_download  { "version": "latest", "outDir": "D:\\pkgs" }
dsh_plugin_search     { "query": "余额看板", "limit": 10 }
dsh_plugin_search     { "sort": "popular", "limit": 10 }
dsh_plugin_install    { "fromSearch": 3 }
dsh_plugin_install    { "spec": "@scope/my-bundle@1.2.3" }
dsh_plugin_install    { "spec": "D:\\work\\my-bundle" }
dsh_plugin_manage     { "action": "list" }
dsh_plugin_manage     { "action": "set_enabled", "entryId": "time-context", "enabled": false }
```

### 搜索 → 用户挑 → 安装

这是推荐的找插件方式，整条链路都在对话里：

1. 用户说「我想装个能看余额的插件」，或「给我看看现在最火的插件」；
2. Agent 调 `dsh_plugin_search`（`{"query":"余额"}` 或 `{"sort":"popular","limit":10}`），
   拿到一份带编号的候选列表，**原样展示给用户**；
3. 用户回「装第 3 个」；
4. Agent 调 `dsh_plugin_install { "fromSearch": 3 }` —— 编号由本插件按**当前会话**解析成
   具体 spec，不靠模型抄包名，所以不会串号。

搜索结果的编号是会话级的：`dsh_plugin_search` 每次调用都会覆盖该会话的记录，
跨会话互不干扰（进程内内存，重启即清空）。编号越界、没搜过就按编号装、
`spec` 与 `fromSearch` 同时给，都会得到能照着改的报错。

---

## 2. 安装到 profile

先把仓库克隆到本地任意目录：

```bash
git clone https://github.com/hellogitd/dsh_harness_install.git
```

再把这个目录的**绝对路径**交给 `plugin_manager`：

```text
plugin_manager { "action": "install_bundle", "target": "<克隆下来的绝对路径，例如 D:\\code\\dsh_harness_install>" }
```

`target` 是**本目录的绝对路径**。安装后：

- 包被写进 profile 的 `package.json` `dependencies`（`link:` 指向本目录），
  并追加到 `dsh.profile.bundles` 列表末尾；profile 目录下会出现 `node_modules/@local/dsh-installer`；
- 真正的插件行由**本包自带的** `cordis.patch.yml` 在组合 profile 时插入，
  所以**不需要也不应该**手改 profile 的 `cordis.patch.yml`；
- 四个工具立刻对使用该 profile 的所有会话生效（返回 `application: applied`）；
- 改动是持久的，重启后依然在。

想改配置时，改本目录 `cordis.patch.yml` 的 `config:` 后重新安装；
或在 profile 的 `cordis.patch.yml` 里加一条同 `id` 的覆盖行（后面的层优先）：

```yaml
- id: dsh-installer
  name: "@local/dsh-installer"
  config:
    manager: pnpm
    registry: https://registry.npmmirror.com/
```

也可以用 CLI：

```bash
dsh plugin --profile <profile-name> add /absolute/path/to/dsh-installer
```

卸载：

```text
plugin_manager { "action": "remove_bundle", "target": "@local/dsh-installer" }
```

> 本插件只注册 Agent 工具，不注册任何 UI 槽位，也不会在启动时做网络或磁盘操作。

---

## 3. 配置

配置写在 `cordis.patch.yml` 里该行的 `config` 字段（本包自带的 `cordis.patch.yml` 已经给出一份可用的默认值）。
本插件不导出 schemastery `Config`，Cordis 会把原始对象直接传进来，插件自己兜底并对非法值告警——**写错一个字段不会导致插件加载失败**。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `manager` | `npm` | 使用的包管理器：`npm` \| `pnpm` |
| `registry` | `null` | 首选 npm registry URL；`null` = 用包管理器自身配置 |
| `fallbackRegistries` | `["https://registry.npmmirror.com/"]` | 首选源不可达/未同步时依次询问的镜像 |
| `defaultMode` | `global` | `dsh_harness_install` 的默认安装位置：`global` \| `project` |
| `downloadDir` | `null` | `dsh_harness_download` 的默认保存目录；`null` = `<cwd>/.dsh-downloads` |
| `verify` | `true` | 安装后是否用 `dsh --version` 做真实校验 |
| `timeoutMs` | `900000` | 单次安装/下载的最长耗时（毫秒），超时终止整棵进程树 |
| `outputBytes` | `32768` | 单次回传给模型的输出上限（字节）；完整输出保存在 spill 文件里，路径会写进结果 |
| `maxTarballBytes` | `134217728` | 单次下载体积上限（字节） |

用到内网源或镜像：

```yaml
- insert:
    - id: dsh-installer
      name: '@local/dsh-installer'
      config:
        manager: pnpm
        registry: https://registry.npmmirror.com/
```

---

## 4. 实现说明（踩过的坑）

这些都是对着当前 DSH 运行时的真实代码/行为核对过的，改代码前请先读这一节。

1. **Windows 上不能直接 spawn `npm.cmd`。** Node 的 `child_process.spawn` 对
   `.cmd` / `.bat` 且 `shell: false` 会直接抛 `EINVAL`（本机实测）。
   所以插件先 `ctx.subprocess.resolveExecutable()` 解析出 shim，再反查它旁边真正的
   JS 入口（`node_modules/npm/bin/npm-cli.js`、`node_modules/pnpm/bin/pnpm.cjs`、
   `corepack/dist/corepack.js`），用**真正的 node 可执行文件**去跑；
   Electron 宿主上用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`。
   只有这两条都不可用时，才退化成 `cmd.exe /d /s /c ""..."`，并且对参数做白名单校验。
   `/\.(cmd|bat)$/` 的直启路径仍保留一次 `try/catch` 兜底重试。

2. **不整包传 `{...process.env}`。** Windows 上 `process.env` 的 `PATH` 键名可能是
   `Path`，而普通对象查找是大小写敏感的，`env.PATH` 会踩空（本机实测）；
   而且 provider 的 `childEnv()` 会先 scrub 父环境（剔除 `DSH_*`、敏感变量），
   整包传等于把它们加回来。插件只在确实需要时传**额外**变量，其余交给
   `ctx.subprocess` 自己清理过的父环境；provider 侧用
   `environmentValue()`（Windows 大小写不敏感）解析 `PATH` / `PATHEXT`。

3. **不改 profile 文件、不自己跑包管理器改 profile。** 插件安装一律走
   `ctx.pluginManager.installBundle()`：它和 `dsh plugin` 共用实现与 profile 写锁，
   失败时会按快照恢复 `package.json` / `pnpm-lock.yaml`，我这边重复实现只会制造不一致。

4. **工具定义直接按原始契约写，不用 `defineTool()`。**
   `ctx.tools.register()` 只校验 `output.schema` 是否落在受支持的 JSON Schema 子集内、
   `parameters` 直接透传给模型。为了零依赖，本插件手写 `parameters`（标准 JSON Schema）
   与 `output: { schema, render }`，因此**模型看到的是 `render()` 生成的文本**——
   所有关键信息（路径、版本、命令、诊断）都必须出现在 `render()` 里。

5. **返回值必须满足自己声明的 `output.schema`。** 结果里可能缺失的字段一律**省略键**
   而不是写 `null`（受支持子集没有 `nullable` / 类型数组）。

---

## 5. 影响范围与安全

- 安装/下载会以**宿主用户权限**真实执行 `npm` / `pnpm`，并在宿主进程里运行已安装的插件代码；
  工作区文件沙箱不覆盖这些行为。请只用它安装你信任的包。
- 所有进入包管理器 argv 的字符串（版本、spec、registry）都经过字符白名单校验；
  走到 `cmd.exe` 兜底路径时还会拒绝 `% ! ^ & | < > ( )` 等字符。
- 下载默认做完整性校验；校验失败时**不写入文件**。
- 建议在需要时用 Agent 预设的 `tools.restrict()` / 工具限制把这五个工具收窄到特定会话。

---

## 6. 运行测试

包内自带一份自检脚本，用「按 provider 契约实现的替身 + 真实 node `child_process` +
真实 npm + 真实 npm 搜索接口」驱动本插件的五个工具（不启动完整 Host）：

```bash
node test/functional-test.mjs               # 快速：dryRun / 参数校验 / 真实搜索 / 真实下载 / 假 pluginManager
node test/functional-test.mjs --install-e2e # 追加：真的用 npm 把 dsh 装进系统临时目录（约 40s）
```

也可以 `npm test` / `npm run test:e2e`。测试文件写在系统临时目录的
`dsh-installer-test/` 下，不污染本包。

---

## 7. 验证记录（本机 Windows / node v24.15.0 / DSH 0.2.0-rc.2）

### 7.1 真实 Host 内验证（安装进 `desktop` profile 后，用工具本身跑出来的）

| 项 | 结果 |
|---|---|
| `plugin_manager install_bundle` 安装本包 | `application: applied`，`changed: true`，`exitCode: 0` |
| 插件行是否真的挂上 | `dsh_plugin_manage list` → `include:dsh-installer (@local/dsh-installer) [启用] active` |
| **`dsh_harness_install`（真实 `ctx.subprocess` + 真实 npm）** | 装出 `@deepseek-ai/dsh@0.2.0-rc.2`，并校验 `dsh --version` → `0.2.0-rc.2` |
| **`dsh_harness_download`（真实 fetch）** | 24 265 字节，sha512 与 registry `dist.integrity` 一致，校验通过 |
| `dsh_plugin_search`（真实 npm 搜索接口） | 中文「语音输入」→ 命中真实语音插件；`sort="popular"` → 按上月下载量排序（dshmarket 596.6k、dsh-skills-manager 209.6k…）；全部候选都通过了 `dsh.bundle.patch` 校验 |
| `dsh_plugin_install { fromSearch: 2 }` | 解析成搜索列表第 2 个的 spec 并安装，`installBundle` 收到的 spec 与列表一致 |
| `dsh_plugin_manage list` | 正确列出 11 个组合包与 198 个插件条目 |

### 7.2 离线自检（`test/functional-test.mjs`，8 组用例全绿）

| 项 | 结果 |
|---|---|
| 四个工具的定义通过**真实的** `assertSupportedJsonSchema`（取自已安装的 `dsh-tools`） | 通过 |
| `parameters` 为标准 JSON Schema，必填项缺失被真实校验器拒绝 | 通过 |
| `dsh_harness_download` 访问 `registry.npmjs.org` 并校验 sha512/sha1 | 通过 |
| 显式传入的错误 `integrity` 被拒绝，且不写入文件 | 通过 |
| `dsh_harness_install --dryRun` 命令拼装 | 通过 |
| 真实 `npm install @deepseek-ai/dsh@0.2.0-rc.2` 到项目目录（41.7s）+ `dsh --version` | 通过 |
| `dsh_plugin_install` 的 inspect 预检 / 拒绝分支 / registry 透传 | 通过 |
| `dsh_plugin_manage` 的 list / set_enabled / remove 与 7 个错误分支 | 通过 |
| `dsh_plugin_search` 的候选编号、`fromSearch` 按编号安装、越界 / 重复指定 / 都不给 | 通过 |
| 非法 `version`（含 shell 元字符）、非 http(s) `registry`、`project` 缺 `dir` | 均按预期报错 |

### 7.3 未覆盖的部分（如实说明）

- 未在 macOS / Linux 上实机跑过；`.cmd` 相关的分支只在 Windows 上生效，
  POSIX 走的是「直接执行解析出的绝对路径」这一条更简单的路径。
- `pnpm` 分支只做了参数拼装与命令构造层面的验证，未实机跑 pnpm 安装。
- 未验证代理（`HTTPS_PROXY`）场景：`dsh_harness_download`、`dsh_plugin_search` 都走
  Node 内置 `fetch`，它不会自动读取环境变量里的代理；本机实测时因为 `github.com`
  直连超时，推送用的是 `git -c http.proxy=... `（与插件无关）。
  需要代理时请给 `dsh_harness_download` 的 `url` 直传可达地址，或让
  `dsh_harness_install` 走包管理器（npm/pnpm 自己会读代理配置）。
- **搜索依赖 registry 的全文搜索接口**（`/-/v1/search`）：npm 官方源与 npmmirror 都支持，
  但私有源不一定实现，那种情况下会退化成「所有 registry 都搜不到」的报错。
- **下载量只有 npm 官方源才有**（`api.npmjs.org/downloads`）：换成私有源时
  `sort="popular"` 会退化成按相关度近似排序，结果里也不再显示下载量。
- 搜索只覆盖**已发布到 registry 的包**；工作区里手写的本地 bundle 搜不到，
  那种情况直接用 `dsh_plugin_install { "spec": "<绝对路径>" }`。

---

## 8. 目录结构

```text
dsh-installer/
├── package.json              # 清单：dsh.bundle.patch、MIT、icon、meta、scripts
├── cordis.patch.yml          # 把插件行插入 profile（含默认配置）
├── index.js                  # 全部实现（五个工具 + 搜索/包管理器/registry 逻辑）
├── test/functional-test.mjs  # 自检脚本（真实 npm / npm 搜索 / registry）
├── locale/en.json            # 英文展示元信息
├── locale/zh.json            # 中文展示元信息
├── icon.svg                  # 插件卡片图标
├── LICENSE                   # MIT
└── README.md
```

`LICENSE` 里的版权署名是 `dsh-installer contributors`，改成你自己的名字即可。

---

## License

MIT © 2026 dsh-installer contributors — 见 [LICENSE](./LICENSE)。
