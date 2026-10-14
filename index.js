/**
 * @local/dsh-installer — 下载/安装 DeepSeek Harness CLI（`@deepseek-ai/dsh`），
 * 并在当前 DSH profile 中安装、查看、启停与卸载插件组合包（bundle）。
 *
 * 设计约束（都来自对当前 DSH 运行时的实测，改动前请先读 README「实现说明」）：
 * 1. 零依赖：只使用 Node 内置模块，不 import 任何 `@deepseek-ai/*` 包。tool 定义
 *    直接按 `ctx.tools.register()` 的原始契约书写（`output: { schema, render }`），
 *    所以安装本插件不需要额外下载任何依赖。
 * 2. 不拼 shell 字符串：Windows 上 `npm`/`pnpm` 是 `.cmd` shim，用 shell:false
 *    spawn 会直接 EINVAL（已实测）。因此优先解析出真正的 node 可执行文件去跑
 *    `npm-cli.js` / `pnpm.cjs`，只有万不得已才退化为 `cmd.exe /d /s /c` 包装。
 * 3. 插件安装走 `ctx.pluginManager.installBundle()`（与 `dsh plugin` 同一套
 *    pnpm 实现、同一把 profile 写锁），不自己跑包管理器改 profile 文件。
 * 4. 下载的 tarball 用 registry 的 `dist.integrity`(sha512) / `dist.shasum`(sha1) 校验。
 *
 * @license MIT
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

/** Cordis 插件名。 */
export const name = 'dsh-installer'

/** 只硬依赖 `tools`；`subprocess` / `pluginManager` 在调用时惰性获取。 */
export const inject = ['tools']

/** 本插件安装与下载的目标包。 */
const HARNESS_PACKAGE = '@deepseek-ai/dsh'
/** 未配置 registry 时的首选源。 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
/** 官方源不可达/未同步时依次询问的镜像。 */
const DEFAULT_FALLBACKS = ['https://registry.npmmirror.com/']
/** 单次子进程输出保留的字节上限（超出部分落在 spill 文件里）。 */
const DEFAULT_OUTPUT_BYTES = 32768
/** 子进程 spill 文件上限。 */
const SPILL_BYTES = 16 * 1024 * 1024
/** 子进程被杀前的宽限毫秒数。 */
const GRACE_MS = 10000
/** 一次安装/下载的默认最长耗时。 */
const DEFAULT_TIMEOUT_MS = 900000
/** 单次下载 tarball 的体积上限。 */
const DEFAULT_MAX_TARBALL_BYTES = 128 * 1024 * 1024
/** 包管理器 spec 允许的字符集：足够覆盖 registry spec / dist-tag / 简单 URL，
 * 且不含任何在 cmd.exe 下有特殊含义的字符（`& | < > ^ % !` 与空白、引号）。 */
const SAFE_SPEC = /^[@a-zA-Z0-9][a-zA-Z0-9@/._~:+-]*$/
/** 版本 / dist-tag 允许的字符集。 */
const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/**
 * 归一化插件配置。本插件不导出 `Config`（schemastery）schema，Cordis 会把
 * patch 里的原始 `config` 对象原样传入，所以这里自行兜底与告警。
 * @param ctx - 插件上下文，仅用于打日志。
 * @param config - cordis.patch.yml 中该行声明的 config。
 * @returns 归一化后的设置。
 */
function normalizeSettings (ctx, config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const settings = {
    manager: pickEnum(ctx, raw.manager, ['npm', 'pnpm'], 'npm', 'manager'),
    registry: pickRegistry(ctx, raw.registry, null, 'registry'),
    fallbackRegistries: Array.isArray(raw.fallbackRegistries)
      ? raw.fallbackRegistries.map((entry) => pickRegistry(ctx, entry, null, 'fallbackRegistries')).filter(Boolean)
      : [...DEFAULT_FALLBACKS],
    defaultMode: pickEnum(ctx, raw.defaultMode, ['global', 'project'], 'global', 'defaultMode'),
    downloadDir: typeof raw.downloadDir === 'string' && raw.downloadDir.length > 0 ? raw.downloadDir : null,
    verify: raw.verify !== false,
    timeoutMs: positiveNumber(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    outputBytes: positiveNumber(raw.outputBytes, DEFAULT_OUTPUT_BYTES),
    maxTarballBytes: positiveNumber(raw.maxTarballBytes, DEFAULT_MAX_TARBALL_BYTES)
  }
  return settings
}

/** 读取一个枚举配置项，非法值回退默认并告警（不因此让插件挂掉）。 */
function pickEnum (ctx, value, allowed, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && allowed.includes(value)) return value
  warn(ctx, `配置 ${field}=${JSON.stringify(value)} 不是 ${allowed.join('/')} 之一，已回退为 ${fallback}`)
  return fallback
}

/** 校验一个 registry URL；非法值告警并回退。 */
function pickRegistry (ctx, value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && isHttpUrl(value)) return value
  warn(ctx, `配置 ${field}=${JSON.stringify(value)} 不是 http(s) URL，已忽略`)
  return fallback
}

/** 正整数兜底。 */
function positiveNumber (value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 只在 logger 可用时告警。 */
function warn (ctx, message) {
  try {
    ctx.logger?.warn?.(`dsh-installer: ${message}`)
  } catch {
    /* 日志失败绝不影响功能 */
  }
}

/** http(s) URL 判定。 */
function isHttpUrl (value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 组装询问顺序：显式 registry → 配置 registry → 内置默认源 → 备选镜像（去重）。 */
function registryOrder (settings, explicit) {
  const order = []
  for (const entry of [explicit, settings.registry, ...(explicit ? [] : [DEFAULT_REGISTRY]), ...settings.fallbackRegistries]) {
    if (typeof entry === 'string' && !order.includes(entry)) order.push(entry)
  }
  return order
}

/** 带结尾斜杠的 registry base。 */
function registryBase (registry) {
  return registry.endsWith('/') ? registry : `${registry}/`
}

/* ------------------------------------------------------------------ *
 * 参数校验与断言
 * ------------------------------------------------------------------ */

/** 断言一段文本可以安全地作为 argv 元素（不经过 shell 也不会被 cmd 解释）。 */
function assertSafeArg (value, label) {
  if (typeof value !== 'string' || !SAFE_SPEC.test(value)) {
    throw new Error(`${label} 含有不支持的字符：${JSON.stringify(value)}（只允许字母、数字与 @ / . _ ~ : + -）`)
  }
  return value
}

/** 断言版本号 / dist-tag。 */
function assertSafeVersion (value) {
  if (typeof value !== 'string' || !SAFE_VERSION.test(value)) {
    throw new Error(`version 不是合法的版本号或 dist-tag：${JSON.stringify(value)}`)
  }
  return value
}

/** 断言 registry URL。 */
function assertRegistry (value) {
  if (typeof value !== 'string' || !isHttpUrl(value)) {
    throw new Error(`registry 必须是 http(s) URL：${JSON.stringify(value)}`)
  }
  return value
}

/** 取一个必填的字符串参数。 */
function requireString (args, key) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`缺少必填参数 ${key}`)
  }
  return value.trim()
}

/* ------------------------------------------------------------------ *
 * 服务获取
 * ------------------------------------------------------------------ */

/** 取子进程服务；缺失时给出可操作的错误。 */
function requireSubprocess (ctx) {
  const subprocess = ctx.get('subprocess')
  if (!subprocess) {
    throw new Error('当前 profile 没有加载 ctx.subprocess（@deepseek-ai/dsh-subprocess-local），无法执行安装命令')
  }
  return subprocess
}

/** 取插件管理服务；缺失时给出可操作的错误。 */
function requirePluginManager (ctx) {
  const pluginManager = ctx.get('pluginManager')
  if (!pluginManager) {
    throw new Error('当前 profile 没有加载 ctx.pluginManager（@deepseek-ai/dsh-plugin-manager），无法管理 profile 插件')
  }
  return pluginManager
}

/* ------------------------------------------------------------------ *
 * 可执行文件解析（Windows .cmd 问题的完整处理）
 * ------------------------------------------------------------------ */

/**
 * 找一个真正可执行的 node：Electron 宿主用自身可执行文件 + ELECTRON_RUN_AS_NODE，
 * 纯 node 宿主直接用 `process.execPath`。
 * @returns `{ path, env }`，找不到时返回 null。
 */
function findNodeExecutable () {
  if (process.execPath && existsSync(process.execPath)) {
    return process.versions.electron
      ? { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { path: process.execPath, env: {} }
  }
  const candidate = join(dirname(process.execPath ?? ''), process.platform === 'win32' ? 'node.exe' : 'node')
  return existsSync(candidate) ? { path: candidate, env: {} } : null
}

/**
 * 从一个包管理器 shim（`npm.cmd` / `pnpm.cmd` / `corepack.cmd`）反查出它的 JS 入口。
 * @param shimPath - `subprocess.resolveExecutable()` 解析出的绝对路径。
 * @returns JS 入口绝对路径，查不到时返回 null。
 */
function findPackageManagerEntry (shimPath) {
  const dir = dirname(shimPath)
  const base = basename(shimPath).replace(/\.(cmd|bat|ps1|exe)$/i, '').toLowerCase()
  const candidates = [
    join(dir, 'node_modules', base, 'bin', `${base}-cli.js`),
    join(dir, 'node_modules', base, 'bin', `${base}.cjs`),
    join(dir, 'node_modules', base, 'bin', `${base}.js`),
    join(dir, 'node_modules', base, 'bin', `${base}-cli.cjs`),
    join(dir, `${base}.cjs`),
    join(dir, 'node_modules', 'corepack', 'dist', 'corepack.js')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** cmd.exe 里给单个 token 加引号；内部引号按 cmd 规则双写。 */
function quoteForCmd (token) {
  if (/[%!^&|<>()"']/.test(token)) {
    throw new Error(`拒绝把含 cmd 特殊字符的参数交给 shell：${JSON.stringify(token)}`)
  }
  return `"${token}"`
}

/** 最后手段：`cmd.exe /d /s /c "...` 包装（仅 Windows 且找不到 node 时使用）。 */
function cmdWrapper (executable, args) {
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
  const command = `"${[executable, ...args].map(quoteForCmd).join(' ')}"`
  return [comspec, '/d', '/s', '/c', command]
}

/**
 * 决定怎样启动一个包管理器命令。
 * @param executable - 已解析的绝对可执行文件路径。
 * @param args - 包管理器参数。
 * @returns `{ argv, env, how }`；`how` 是给用户看的一句话。
 */
function buildLaunch (executable, args) {
  if (process.platform !== 'win32') {
    return { argv: [executable, ...args], env: {}, how: executable }
  }
  if (!/\.(cmd|bat)$/i.test(executable)) {
    return { argv: [executable, ...args], env: {}, how: executable }
  }
  const entry = findPackageManagerEntry(executable)
  const node = entry ? findNodeExecutable() : null
  if (entry && node) {
    return {
      argv: [node.path, entry, ...args],
      env: node.env,
      how: `${node.path} ${entry} ${args.join(' ')}`
    }
  }
  const argv = cmdWrapper(executable, args)
  return { argv, env: {}, how: argv[argv.length - 1] }
}

/* ------------------------------------------------------------------ *
 * 子进程执行
 * ------------------------------------------------------------------ */

/**
 * 组装 provider 需要的 spawn spec。`env` 为空时整个字段省略，让 provider 用
 * 它自己清理过的父环境（见 runCommand 的说明）。
 */
function spawnSpec (argv, cwd, env, signal, outputBytes) {
  const spec = {
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: outputBytes, spill: { maxBytes: SPILL_BYTES } },
      stderr: { maxBytes: outputBytes, spill: { maxBytes: SPILL_BYTES } }
    },
    graceMs: GRACE_MS,
    signal
  }
  if (Object.keys(env).length > 0) spec.env = env
  return spec
}

/** 读取 collect 模式的输出。 */
function readCollected (reader) {
  if (!reader) return { text: '', lossy: false, spillPath: undefined }
  try {
    const read = reader.readFrom(0)
    return { text: typeof read?.text === 'string' ? read.text : '', lossy: read?.lossy === true, spillPath: read?.spillPath }
  } catch {
    return { text: '', lossy: false, spillPath: undefined }
  }
}

/**
 * 跑一次命令并回收输出。
 *
 * 环境变量只传「额外项」，绝不整包传 `{...process.env}`：
 * 1. Windows 上 `{...process.env}` 会把 `PATH` 复制成 `Path`，而普通对象查找是
 *    大小写敏感的，`env.PATH` 会直接踩空（实测）；
 * 2. provider 的 `childEnv()` 会先 scrub 父环境（剔除 `DSH_SUBPROCESS_RUNNER`
 *    等私有变量），整包传等于把它们加回来。
 * 不传 `env` 时 provider 用自己清理过的父环境，这正是我们想要的。
 * @returns 结果对象；`how` 是实际执行的命令描述。
 */
async function runCommand (ctx, options) {
  const subprocess = requireSubprocess(ctx)
  const { executable, args, cwd, timeoutMs, outputBytes, signal } = options
  const extraEnv = options.env && Object.keys(options.env).length > 0 ? { ...options.env } : undefined
  let resolved
  try {
    resolved = await subprocess.resolveExecutable(executable, extraEnv, signal)
  } catch (error) {
    throw new Error(`找不到可执行文件 ${JSON.stringify(executable)}：${error?.message ?? error}。请确认已安装 Node.js 并让其 bin 目录在 PATH 中`)
  }
  const launch = buildLaunch(resolved, args)
  const budget = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  const childEnv = { ...(extraEnv ?? {}), ...launch.env }
  let handle
  try {
    handle = subprocess.spawn(spawnSpec(launch.argv, cwd, childEnv, budget, outputBytes))
  } catch (error) {
    // 极少数情况下 .cmd 直启会在这一步失败：换成 cmd.exe 包装再试一次。
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
      launch.argv = cmdWrapper(resolved, args)
      launch.how = launch.argv[launch.argv.length - 1]
      handle = subprocess.spawn(spawnSpec(launch.argv, cwd, childEnv, budget, outputBytes))
    } else {
      throw error
    }
  }
  let outcome = null
  let failure = null
  try {
    outcome = await handle.done
  } catch (error) {
    failure = error
  }
  const stdout = readCollected(handle.collected?.stdout)
  const stderr = readCollected(handle.collected?.stderr)
  const cancelled = Boolean(signal?.aborted)
  return {
    command: `${launch.argv[0]} ${launch.argv.slice(1).join(' ')}`,
    how: launch.how,
    executable: resolved,
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    timedOut: !cancelled && budget.aborted,
    cancelled,
    stdout: stdout.text,
    stderr: stderr.text,
    spillPath: stdout.spillPath ?? stderr.spillPath,
    lossy: stdout.lossy || stderr.lossy,
    failure: failure ? (failure?.message ?? String(failure)) : null
  }
}

/* ------------------------------------------------------------------ *
 * registry 元数据与下载
 * ------------------------------------------------------------------ */

/**
 * 依次询问 registry，取某个版本（或 dist-tag）的元数据。
 * @returns `{ registry, manifest }`。
 */
async function fetchManifest (registries, version, signal, timeoutMs) {
  const problems = []
  for (const registry of registries) {
    const url = `${registryBase(registry)}${HARNESS_PACKAGE}/${encodeURIComponent(version)}`
    const budget = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/vnd.npm.install-v1+json, application/json',
          'user-agent': 'dsh-installer (+https://github.com/deepseek-ai/deepseek-harness)'
        },
        signal: budget
      })
      if (!response.ok) {
        problems.push(`${registry} → HTTP ${response.status}`)
        continue
      }
      const manifest = await response.json()
      if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
        problems.push(`${registry} → 返回的元数据缺少 version`)
        continue
      }
      return { registry, manifest }
    } catch (error) {
      problems.push(`${registry} → ${error?.message ?? String(error)}`)
    }
  }
  throw new Error(`所有 registry 都取不到 ${HARNESS_PACKAGE}@${version}：${problems.join('；')}`)
}

/** 下载字节流，带体积上限。 */
async function downloadBytes (url, signal, timeoutMs, maxBytes) {
  const budget = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, { signal: budget, redirect: 'follow' })
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status} ${response.statusText}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`远端声明 ${declared} 字节，超过上限 ${maxBytes}`)
  }
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error(`下载体积超过上限 ${maxBytes} 字节，已中止`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

/** 计算 sha512(base64) 与 sha1(hex)。 */
function digest (buffer) {
  return {
    sha512: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
    sha1: createHash('sha1').update(buffer).digest('hex'),
    bytes: buffer.byteLength
  }
}

/** 一个 integrity 字符串是否等于实测摘要。 */
function integrityMatches (actual, entry) {
  return entry === actual.sha512 || entry === actual.sha1 || entry === `sha1-${actual.sha1}`
}

/**
 * 校验下载结果。调用方显式给出的 integrity 是**钉死值**：它必须匹配，不允许被
 * registry 元数据里的另一个值“救回来”；只有没给显式值时，才回落到
 * `dist.integrity`（sha512）/ `dist.shasum`（sha1）。
 * @returns `{ verified, expected, actual, reason }`。
 */
function verifyIntegrity (buffer, manifest, expected) {
  const actual = digest(buffer)
  if (typeof expected === 'string' && expected.length > 0) {
    return integrityMatches(actual, expected)
      ? { verified: true, expected, actual, reason: null }
      : { verified: false, expected, actual, reason: `调用方指定的 integrity 不匹配：期望 ${expected}，实际 ${actual.sha512}` }
  }
  const dist = manifest?.dist
  const wanted = []
  if (dist && typeof dist.integrity === 'string') wanted.push(dist.integrity)
  if (dist && typeof dist.shasum === 'string') wanted.push(`sha1-${dist.shasum}`)
  if (wanted.length === 0) {
    return { verified: null, expected: null, actual, reason: '元数据没有提供 integrity/shasum，无法校验' }
  }
  for (const entry of wanted) {
    if (integrityMatches(actual, entry)) return { verified: true, expected: entry, actual, reason: null }
  }
  return { verified: false, expected: wanted[0], actual, reason: `完整性校验失败：期望 ${wanted[0]}，实际 ${actual.sha512}` }
}

/* ------------------------------------------------------------------ *
 * 安装位置解析
 * ------------------------------------------------------------------ */

/** 取包管理器的全局 node_modules 根目录。 */
async function resolveGlobalRoot (ctx, settings, manager, signal) {
  try {
    const run = await runCommand(ctx, {
      executable: manager,
      args: ['root', '-g'],
      cwd: homedir(),
      timeoutMs: Math.min(settings.timeoutMs, 120000),
      outputBytes: settings.outputBytes,
      signal
    })
    const root = run.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
    if (root && isAbsolute(root)) return { root, note: null }
  } catch (error) {
    /* 落到下面的兜底 */
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return { root: join(appData, 'npm', 'node_modules'), note: `${manager} root -g 不可用，按默认位置推断` }
  }
  return { root: join('/usr/local/lib/node_modules'), note: `${manager} root -g 不可用，按默认位置推断` }
}

/** 读已安装包的 package.json。 */
async function readInstalledPackage (packageDir) {
  try {
    const parsed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 计算 dsh 命令 shim 的候选路径。 */
function binShimCandidates (mode, installRoot, dir) {
  if (mode === 'project') {
    const bin = join(dir, 'node_modules', '.bin', 'dsh')
    return process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.ps1`, bin] : [bin]
  }
  const prefix = dirname(installRoot)
  return process.platform === 'win32'
    ? [join(prefix, 'dsh.cmd'), join(prefix, 'dsh.ps1'), join(prefix, 'dsh')]
    : [join(prefix, 'bin', 'dsh'), join(prefix, 'dsh')]
}

/** project 模式：确保目标目录与一个最小 package.json 存在（pnpm add 需要）。 */
async function prepareProjectDir (dir) {
  await mkdir(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    await writeFile(manifestPath, `${JSON.stringify({ name: 'dsh-harness-install', private: true }, null, 2)}\n`, 'utf8')
    return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 工具 1：安装 dsh CLI
 * ------------------------------------------------------------------ */

function harnessInstallTool (ctx, settings) {
  return {
    name: 'dsh_harness_install',
    description:
      '下载并安装（或升级）DeepSeek Harness 命令行 @deepseek-ai/dsh。' +
      '默认用 npm 装到全局 prefix（等价于 npm i -g @deepseek-ai/dsh@latest），' +
      '也可以用 mode=project + dir 装到指定目录。安装完成后读取已装包的版本，' +
      '并用该版本自带的 dsh --version 做一次真实校验。' +
      'dryRun=true 时只返回将要执行的命令，不做任何改动。',
    timeoutMs: 1800000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'string', description: "要安装的版本或 dist-tag，例如 '0.2.0-rc.2'、'latest'。默认 latest。" },
        mode: { type: 'string', enum: ['global', 'project'], description: "global 装到包管理器全局 prefix；project 装到 dir 指定的目录。默认取插件配置（global）。" },
        dir: { type: 'string', description: 'project 模式的安装目录，必须是绝对路径。' },
        manager: { type: 'string', enum: ['npm', 'pnpm'], description: '使用哪个包管理器，默认 npm。' },
        registry: { type: 'string', description: '首选 npm registry URL（会作为 --registry 传给包管理器）。默认用包管理器自身配置。' },
        verify: { type: 'boolean', description: '安装后运行 dsh --version 校验，默认 true。' },
        dryRun: { type: 'boolean', description: '只打印将执行的命令，不真正安装。' }
      }
    },
    output: {
      schema: outputEnvelope({
        mode: { type: 'string' },
        manager: { type: 'string' },
        spec: { type: 'string' },
        version: { type: 'string' },
        packageDir: { type: 'string' },
        binPath: { type: 'string' },
        command: { type: 'string' },
        exitCode: { type: 'integer' },
        verified: { type: 'boolean' },
        stdout: { type: 'string' },
        stderr: { type: 'string' }
      }),
      render: (args, value) => [{ type: 'text', text: value.summary }]
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: `安装 DeepSeek Harness ${args?.version ? `@${args.version}` : '@latest'}`,
      description: args?.mode === 'project' ? `project → ${args?.dir ?? '(缺少 dir)'}` : 'global'
    }),
    async execute (args, exec) {
      const requested = typeof args.version === 'string' && args.version.length > 0 ? args.version : 'latest'
      assertSafeVersion(requested)
      const mode = args.mode === 'global' || args.mode === 'project' ? args.mode : settings.defaultMode
      const manager = args.manager === 'npm' || args.manager === 'pnpm' ? args.manager : settings.manager
      const registry = args.registry ? assertRegistry(args.registry) : null
      const shouldVerify = args.verify !== false && settings.verify
      const spec = `${HARNESS_PACKAGE}@${requested}`
      const notes = []

      let dir = null
      if (mode === 'project') {
        if (typeof args.dir !== 'string' || args.dir.trim().length === 0) throw new Error('mode=project 时必须提供 dir')
        dir = isAbsolute(args.dir) ? args.dir : resolvePath(args.dir)
      }

      const cwd = mode === 'project' ? dir : homedir()
      const pmArgs = mode === 'global'
        ? (manager === 'pnpm' ? ['add', '-g', spec] : ['install', '-g', spec, '--no-audit', '--no-fund'])
        : (manager === 'pnpm' ? ['add', spec] : ['install', spec, '--no-audit', '--no-fund'])
      if (registry) pmArgs.push(`--registry=${registry}`)

      if (args.dryRun === true) {
        return {
          ok: true,
          summary: `[dry-run] 将在 ${cwd} 执行：${manager} ${pmArgs.join(' ')}`,
          mode,
          manager,
          spec,
          command: `${manager} ${pmArgs.join(' ')}`,
          notes: [`安装位置：${mode === 'project' ? dir : '包管理器全局 prefix'}`]
        }
      }

      if (mode === 'project') {
        const created = await prepareProjectDir(dir)
        if (created) notes.push(`已创建最小 package.json：${join(dir, 'package.json')}`)
      } else {
        await mkdir(homedir(), { recursive: true })
      }

      const run = await runCommand(ctx, {
        executable: manager,
        args: pmArgs,
        cwd,
        timeoutMs: settings.timeoutMs,
        outputBytes: settings.outputBytes,
        signal: exec.signal
      })
      if (run.spillPath) notes.push(`完整输出保留在：${run.spillPath}`)
      if (run.lossy) notes.push('子进程输出被截断，result.stdout/stderr 不是全部内容')
      if (run.timedOut) notes.push(`命令超过 ${settings.timeoutMs}ms 被终止`)
      if (run.cancelled) notes.push('命令被调用方取消')
      if (run.failure) notes.push(`子进程错误：${run.failure}`)

      const succeeded = run.exitCode === 0 && !run.failure
      if (!succeeded) {
        return withOptional({
          ok: false,
          summary:
            `安装失败（exit=${run.timedOut ? 'timeout' : run.exitCode ?? run.failure}）。` +
            `命令：${run.how}\n` +
            `stderr：${tail(run.stderr, 1200) || '(空)'}\n` +
            `stdout：${tail(run.stdout, 800) || '(空)'}`,
          mode,
          manager,
          spec,
          command: run.how,
          stdout: run.stdout,
          stderr: run.stderr,
          notes
        }, { exitCode: run.exitCode })
      }

      // 安装成功：定位包目录并读出真实版本。
      let installRoot
      if (mode === 'project') {
        installRoot = join(dir, 'node_modules')
      } else {
        const global = await resolveGlobalRoot(ctx, settings, manager, exec.signal)
        installRoot = global.root
        if (global.note) notes.push(global.note)
      }
      const packageDir = join(installRoot, '@deepseek-ai', 'dsh')
      const manifest = await readInstalledPackage(packageDir)
      if (!manifest) {
        return withOptional({
          ok: false,
          summary: `${manager} 已退出 0，但在 ${packageDir} 找不到 @deepseek-ai/dsh 的 package.json；安装结果无法确认。`,
          mode,
          manager,
          spec,
          command: run.how,
          packageDir,
          stdout: run.stdout,
          stderr: run.stderr,
          notes
        }, { exitCode: run.exitCode })
      }

      const shim = binShimCandidates(mode, installRoot, dir).find((candidate) => existsSync(candidate)) ?? null
      let verified = null
      let verifyOutput = ''
      const binEntry = typeof manifest.bin === 'string'
        ? manifest.bin
        : (manifest.bin && typeof manifest.bin === 'object' ? manifest.bin.dsh : null)
      if (shouldVerify && typeof binEntry === 'string') {
        const node = findNodeExecutable()
        if (!node) {
          notes.push('找不到可执行的 node，跳过 dsh --version 校验')
        } else {
          try {
            const check = await runCommand(ctx, {
              executable: node.path,
              args: [join(packageDir, binEntry), '--version'],
              cwd: mode === 'project' ? dir : homedir(),
              timeoutMs: 120000,
              outputBytes: settings.outputBytes,
              env: node.env,
              signal: exec.signal
            })
            verifyOutput = `${check.stdout}${check.stderr}`.trim()
            verified = check.exitCode === 0 && verifyOutput.includes(manifest.version)
            if (!verified) notes.push(`dsh --version 未确认版本：exit=${check.exitCode}，输出 ${JSON.stringify(tail(verifyOutput, 300))}`)
          } catch (error) {
            verified = false
            notes.push(`dsh --version 校验执行失败：${error?.message ?? error}`)
          }
        }
      }

      const lines = [
        `已安装 ${manifest.name}@${manifest.version}（${manager}，${mode}）`,
        `包目录：${packageDir}`,
        shim ? `命令：${shim}` : '未找到 dsh 命令 shim（请确认全局 prefix 的 bin 目录在 PATH 中）'
      ]
      if (verified === true) lines.push(`校验：dsh --version → ${verifyOutput}`)
      if (verified === false) lines.push('校验：dsh --version 未通过（见 notes）')
      if (notes.length > 0) lines.push(...notes.map((note) => `· ${note}`))

      return withOptional({
        ok: true,
        summary: lines.join('\n'),
        mode,
        manager,
        spec,
        version: manifest.version,
        packageDir,
        command: run.how,
        stdout: run.stdout,
        stderr: run.stderr,
        notes
      }, {
        binPath: shim,
        verified,
        exitCode: run.exitCode
      })
    }
  }
}

/* ------------------------------------------------------------------ *
 * 工具 2：下载 tarball
 * ------------------------------------------------------------------ */

function harnessDownloadTool (ctx, settings) {
  return {
    name: 'dsh_harness_download',
    description:
      '只下载 DeepSeek Harness 的发布 tarball（@deepseek-ai/dsh），不安装。' +
      '默认从 npm registry 解析版本与 dist.tarball，下载后用 dist.integrity（sha512）' +
      '或 dist.shasum（sha1）校验，再写入 outDir。' +
      '产物可以直接离线安装：npm i -g <文件>，也可以用 dsh_harness_install 的 registry 参数指向内网源。',
    timeoutMs: 900000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'string', description: "版本或 dist-tag，默认 latest。" },
        outDir: { type: 'string', description: '保存目录，默认 <当前工作目录>/.dsh-downloads（可用插件配置 downloadDir 覆盖）。' },
        url: { type: 'string', description: '直接指定 tarball URL，跳过 registry 解析。' },
        registry: { type: 'string', description: '用于解析版本的 registry URL。' },
        integrity: { type: 'string', description: '期望的 integrity，例如 sha512-... 或 sha1-...；与 registry 元数据一起校验。' },
        verify: { type: 'boolean', description: '是否校验完整性，默认 true。' },
        overwrite: { type: 'boolean', description: '文件已存在时是否覆盖，默认 false（返回已有文件信息）。' }
      }
    },
    output: {
      schema: outputEnvelope({
        version: { type: 'string' },
        file: { type: 'string' },
        bytes: { type: 'integer' },
        url: { type: 'string' },
        registry: { type: 'string' },
        sha512: { type: 'string' },
        sha1: { type: 'string' },
        verified: { type: 'boolean' }
      }),
      render: (args, value) => [{ type: 'text', text: value.summary }]
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `下载 DeepSeek Harness ${args?.version ? `@${args.version}` : '@latest'}`,
      kind: 'fetch',
      rawInput: { version: args?.version ?? 'latest', outDir: args?.outDir ?? null }
    }),
    async execute (args, exec) {
      const requested = typeof args.version === 'string' && args.version.length > 0 ? args.version : 'latest'
      assertSafeVersion(requested)
      const notes = []
      const outDir = typeof args.outDir === 'string' && args.outDir.trim().length > 0
        ? (isAbsolute(args.outDir) ? args.outDir : resolvePath(args.outDir))
        : (settings.downloadDir ?? join(process.cwd(), '.dsh-downloads'))
      const explicitRegistry = args.registry ? assertRegistry(args.registry) : null
      const shouldVerify = args.verify !== false

      let manifest = null
      let registry = null
      let tarballUrl = null
      if (typeof args.url === 'string' && args.url.length > 0) {
        if (!isHttpUrl(args.url)) throw new Error(`url 必须是 http(s) URL：${JSON.stringify(args.url)}`)
        tarballUrl = args.url
        notes.push('使用调用方直接给出的 url，未向 registry 解析版本')
      } else {
        const found = await fetchManifest(registryOrder(settings, explicitRegistry), requested, exec.signal, Math.min(settings.timeoutMs, 120000))
        manifest = found.manifest
        registry = found.registry
        tarballUrl = manifest?.dist?.tarball
        if (typeof tarballUrl !== 'string' || !isHttpUrl(tarballUrl)) {
          throw new Error(`${registry} 的元数据没有可用的 dist.tarball`)
        }
      }

      const version = typeof manifest?.version === 'string' ? manifest.version : requested
      const file = join(outDir, `dsh-${version}.tgz`)
      await mkdir(outDir, { recursive: true })

      if (existsSync(file) && args.overwrite !== true) {
        const existing = await readFile(file)
        const check = digest(existing)
        const verdict = shouldVerify ? verifyIntegrity(existing, manifest, args.integrity) : { verified: null, reason: null }
        return withOptional({
          ok: verdict.verified !== false,
          summary: `文件已存在，未重新下载：${file}（${check.bytes} 字节，sha512 ${check.sha512}）${verdict.verified === false ? `\n注意：${verdict.reason}` : ''}`,
          version,
          file,
          bytes: check.bytes,
          url: tarballUrl,
          sha512: check.sha512,
          sha1: check.sha1,
          notes: [...notes, '如需重新下载请传 overwrite=true']
        }, { registry, verified: verdict.verified })
      }

      const buffer = await downloadBytes(tarballUrl, exec.signal, settings.timeoutMs, settings.maxTarballBytes)
      const verdict = shouldVerify
        ? verifyIntegrity(buffer, manifest, args.integrity)
        : { verified: null, reason: 'verify=false，跳过完整性校验' }
      if (verdict.verified === false) {
        return withOptional({
          ok: false,
          summary: `下载完成但完整性校验失败，未写入文件。\n${verdict.reason}\nURL：${tarballUrl}`,
          version,
          url: tarballUrl,
          sha512: verdict.actual.sha512,
          sha1: verdict.actual.sha1,
          bytes: verdict.actual.bytes,
          verified: false,
          notes
        }, { registry })
      }

      await writeFile(file, buffer)
      const check = digest(buffer)
      if (verdict.reason) notes.push(verdict.reason)
      if (verdict.verified === true) notes.push(`完整性校验通过（${verdict.expected}）`)
      const lines = [
        `已下载 ${HARNESS_PACKAGE}@${version}`,
        `文件：${file}（${check.bytes} 字节）`,
        `sha512：${check.sha512}`,
        `sha1：${check.sha1}`,
        `来源：${tarballUrl}`,
        `校验：${verdict.verified === true ? '通过' : verdict.verified === false ? '失败' : '未执行'}`,
        '离线安装：npm i -g "' + file + '"',
        ...notes.map((note) => `· ${note}`)
      ]
      return withOptional({
        ok: true,
        summary: lines.join('\n'),
        version,
        file,
        bytes: check.bytes,
        url: tarballUrl,
        sha512: check.sha512,
        sha1: check.sha1,
        notes
      }, { registry, verified: verdict.verified })
    }
  }
}

/* ------------------------------------------------------------------ *
 * 工具 3：安装 profile 插件
 * ------------------------------------------------------------------ */

function pluginInstallTool (ctx, settings) {
  return {
    name: 'dsh_plugin_install',
    description:
      '在当前 DSH profile 中安装一个插件组合包（bundle），与 dsh plugin / plugin_manager 的 install_bundle ' +
      '走同一套 pnpm 实现与同一把 profile 写锁，因此落盘状态一致。' +
      '安装前默认先用 pluginManager.inspect() 预检 spec（能否解析、是不是组合包、是否已装）。' +
      '改动影响使用该 profile 的全部会话，并且已经装好的 Host 代码在宿主进程内运行、不受工作区沙箱限制。',
    timeoutMs: 1800000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        spec: { type: 'string', description: '包 spec：registry 包名（可带 @version）、绝对路径、git 地址或 tarball 路径/URL。' },
        registry: { type: 'string', description: '首选 registry URL；缺省用 profile 配置的源与备选源。' },
        enabled: { type: 'boolean', description: '安装后是否立即选入组合包层，默认 true。' },
        preflight: { type: 'boolean', description: '安装前是否做 inspect 预检，默认 true。' },
        approvedBuilds: { type: 'array', items: { type: 'string' }, description: '仅当用户在对话中明确批准了这些依赖构建脚本时才传；名字来自上一次失败的 pendingBuilds。' }
      },
      required: ['spec']
    },
    output: {
      schema: outputEnvelope({
        spec: { type: 'string' },
        application: { type: 'string' },
        stage: { type: 'string' },
        changed: { type: 'boolean' },
        bundle: { type: 'string' },
        pendingBuilds: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } }
      }),
      render: (args, value) => [{ type: 'text', text: value.summary }]
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `安装插件 ${args?.spec ?? ''}`,
      kind: 'other',
      rawInput: { spec: args?.spec, registry: args?.registry ?? null }
    }),
    async execute (args, exec) {
      const spec = requireString(args, 'spec')
      const registry = args.registry ? assertRegistry(args.registry) : null
      const pluginManager = requirePluginManager(ctx)
      const notes = []

      if (args.preflight !== false) {
        try {
          const inspection = await pluginManager.inspect(spec, registry ? { registry } : undefined, exec.signal)
          if (inspection?.status === 'refused') {
            return {
              ok: false,
              summary: `预检拒绝：${inspection.problem} — ${inspection.reason}`,
              spec,
              application: 'refused',
              stage: 'install',
              changed: false,
              notes
            }
          }
          if (inspection?.bundle === false) {
            notes.push('该包没有声明 dsh.bundle.patch，安装后不会贡献任何插件行')
          } else if (inspection?.name) {
            notes.push(`预检通过：${inspection.name}${inspection.version ? `@${inspection.version}` : ''}，kind=${inspection.kind}`)
          }
        } catch (error) {
          notes.push(`预检未完成（继续安装）：${error?.message ?? error}`)
        }
      }

      const options = { enabled: args.enabled !== false }
      if (registry) options.registry = registry
      if (Array.isArray(args.approvedBuilds) && args.approvedBuilds.length > 0) {
        options.approvedBuilds = args.approvedBuilds.filter((entry) => typeof entry === 'string' && entry.length > 0)
      }
      const result = await pluginManager.installBundle(spec, options)
      const described = describeChange(result)
      const lines = [
        `install_bundle(${spec}) → ${described.application ?? '未知结果'}${described.changed ? '（已落盘）' : ''}`,
        described.bundle ? `组合包：${described.bundle}` : null,
        described.warnings.length > 0 ? `警告：\n${described.warnings.map((entry) => `· ${entry}`).join('\n')}` : null,
        described.error ? `错误：${described.error.code}${described.error.diagnostic ? ` — ${described.error.diagnostic}` : ''}` : null,
        described.pendingBuilds.length > 0
          ? `待批准的构建脚本：${described.pendingBuilds.join(', ')}（经用户在对话中明确批准后，用 approvedBuilds 重试）`
          : null,
        ...notes.map((note) => `· ${note}`),
        described.packageResult?.output ? `包管理器输出（末尾）：\n${described.packageResult.output}` : null
      ].filter(Boolean)

      return withOptional({
        ok: described.application === 'applied' && !described.error,
        summary: lines.join('\n'),
        spec,
        pendingBuilds: described.pendingBuilds,
        warnings: described.warnings,
        notes
      }, {
        application: described.application,
        stage: described.stage,
        changed: described.changed,
        bundle: described.bundle
      })
    }
  }
}

/* ------------------------------------------------------------------ *
 * 工具 4：查看 / 启停 / 卸载 profile 插件
 * ------------------------------------------------------------------ */

function pluginManageTool (ctx, settings) {
  return {
    name: 'dsh_plugin_manage',
    description:
      '查看、启停或卸载当前 profile 的插件：' +
      "action='list' 列出已安装组合包与插件条目（含 enabled / fiberPhase / 只读原因 / 错误）；" +
      "action='set_enabled' 用 name 切换组合包、或用 entryId 切换单个插件条目；" +
      "action='remove' 用 name 卸载一个 profile 自有的组合包。" +
      '改动影响使用该 profile 的全部会话；替换已装包需要重启才能加载新的 JS 模块代。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'set_enabled', 'remove'], description: '要执行的操作。' },
        name: { type: 'string', description: "组合包包名（set_enabled / remove 用）。" },
        entryId: { type: 'string', description: "要切换的插件条目 id（set_enabled 用；与 name 二选一）。" },
        enabled: { type: 'boolean', description: 'set_enabled 时的目标状态。' },
        includePlugins: { type: 'boolean', description: 'list 时是否同时返回插件条目，默认 true。' }
      },
      required: ['action']
    },
    output: {
      schema: outputEnvelope({
        action: { type: 'string' },
        bundles: { type: 'array', items: { type: 'object', additionalProperties: true } },
        plugins: { type: 'array', items: { type: 'object', additionalProperties: true } },
        application: { type: 'string' },
        changed: { type: 'boolean' },
        target: { type: 'string' }
      }),
      render: (args, value) => [{ type: 'text', text: value.summary }]
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `插件管理：${args?.action ?? ''}`,
      kind: 'other',
      rawInput: { action: args?.action, name: args?.name ?? null, entryId: args?.entryId ?? null }
    }),
    async execute (args, exec) {
      const action = requireString(args, 'action')
      const pluginManager = requirePluginManager(ctx)

      if (action === 'list') {
        const bundles = await pluginManager.listBundles()
        const plugins = args.includePlugins === false ? [] : await pluginManager.listPlugins()
        const bundleRows = (bundles ?? []).map((bundle) => ({
          name: bundle.name,
          version: bundle.version ?? null,
          enabled: bundle.enabled === true,
          installed: bundle.installed === true,
          optional: bundle.optional === true,
          removable: bundle.removable === true,
          rows: Array.isArray(bundle.rows) ? bundle.rows.length : 0,
          problem: bundle.error?.code ?? null,
          readOnlyReason: bundle.readOnlyReason ?? null
        }))
        const pluginRows = (plugins ?? []).map((plugin) => ({
          entryId: String(plugin.entryId),
          moduleName: plugin.moduleName,
          enabled: plugin.enabled === true,
          fiberPhase: plugin.fiberPhase ?? null,
          readOnlyReason: plugin.readOnlyReason ?? null
        }))
        const lines = [
          `组合包 ${bundleRows.length} 个：`,
          ...bundleRows.map((row) => `· ${row.name}${row.version ? `@${row.version}` : ''} ${row.enabled ? '[已选入]' : '[未选入]'}${row.problem ? ` 问题=${row.problem}` : ''}${row.rows ? ` 行=${row.rows}` : ''}`),
          args.includePlugins === false ? null : `插件条目 ${pluginRows.length} 个：`,
          ...(args.includePlugins === false ? [] : pluginRows.map((row) => `· ${row.entryId} (${row.moduleName}) ${row.enabled ? '[启用]' : '[禁用]'} ${row.fiberPhase ?? ''}`))
        ].filter(Boolean)
        return {
          ok: true,
          summary: lines.join('\n'),
          action,
          bundles: bundleRows,
          plugins: pluginRows,
          notes: []
        }
      }

      if (action === 'remove') {
        const target = requireString(args, 'name')
        const result = describeChange(await pluginManager.removeBundle(target))
        return withOptional({
          ok: result.application === 'applied' && !result.error,
          summary: [
            `removeBundle(${target}) → ${result.application ?? '未知结果'}`,
            result.error ? `错误：${result.error.code}${result.error.diagnostic ? ` — ${result.error.diagnostic}` : ''}` : null,
            ...result.warnings.map((entry) => `警告：${entry}`)
          ].filter(Boolean).join('\n'),
          action,
          target,
          notes: result.warnings
        }, { application: result.application, changed: result.changed })
      }

      if (action === 'set_enabled') {
        if (typeof args.enabled !== 'boolean') throw new Error('set_enabled 需要 enabled=true/false')
        const hasName = typeof args.name === 'string' && args.name.length > 0
        const hasEntry = typeof args.entryId === 'string' && args.entryId.length > 0
        if (hasName === hasEntry) throw new Error('set_enabled 需要在 name（组合包）与 entryId（插件条目）中恰好提供一个')
        const target = hasName ? args.name : args.entryId
        const result = describeChange(
          hasName
            ? await pluginManager.setBundleEnabled(target, args.enabled)
            : await pluginManager.setPluginEnabled(target, args.enabled)
        )
        return withOptional({
          ok: result.application === 'applied' && !result.error,
          summary: [
            `${hasName ? 'setBundleEnabled' : 'setPluginEnabled'}(${target}, ${args.enabled}) → ${result.application ?? '未知结果'}`,
            result.application === 'restart-required' ? '该 profile 是启动型组合，重启后生效' : null,
            result.error ? `错误：${result.error.code}${result.error.diagnostic ? ` — ${result.error.diagnostic}` : ''}` : null,
            ...result.warnings.map((entry) => `警告：${entry}`)
          ].filter(Boolean).join('\n'),
          action,
          target,
          notes: result.warnings
        }, { application: result.application, changed: result.changed })
      }

      throw new Error(`未知 action：${JSON.stringify(action)}（可用：list / set_enabled / remove）`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 公共小工具
 * ------------------------------------------------------------------ */

/** 输出 schema 的统一外壳：`{ ok, summary, notes, ...extra }`。 */
function outputEnvelope (extra) {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean', description: '操作是否成功。' },
      summary: { type: 'string', description: '给人看的单段结果摘要。' },
      notes: { type: 'array', items: { type: 'string' }, description: '补充说明、警告与后续动作。' },
      ...extra
    },
    required: ['ok', 'summary']
  }
}

/** 把 ChangeResult 压成可读结构，避免把内部对象整包塞回模型。 */
function describeChange (result) {
  const error = result?.error && typeof result.error === 'object'
    ? { code: result.error.code ?? 'unknown', diagnostic: result.error.diagnostic ?? null }
    : null
  const packageResult = result?.packageResult && typeof result.packageResult === 'object'
    ? {
        exitCode: result.packageResult.exitCode ?? null,
        timedOut: result.packageResult.timedOut === true,
        kind: result.packageResult.kind ?? null,
        truncated: result.packageResult.truncated === true,
        logPath: result.packageResult.logPath ?? null,
        output: tail(result.packageResult.output ?? '', 1600)
      }
    : null
  return {
    changed: result?.changed === true,
    application: result?.application ?? null,
    stage: result?.stage ?? null,
    target: result?.target ?? null,
    bundle: result?.bundle ?? null,
    warnings: Array.isArray(result?.warnings) ? result.warnings.map(String) : [],
    pendingBuilds: Array.isArray(result?.pendingBuilds) ? result.pendingBuilds.map(String) : [],
    error,
    packageResult
  }
}

/** 取字符串末尾若干字符。 */
function tail (text, max) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= max ? value : `…${value.slice(value.length - max)}`
}

/**
 * 只在值确实存在时挂上可选键。
 *
 * **不要写成 `字段: value ?? undefined`**：那样键依然存在、值为 `undefined`，
 * 而 `undefined` 不是合法 JSON 值，注册表的 `INVALID_TOOL_OUTPUT` 校验会直接
 * 把这次工具调用判为失败（实测踩过）。缺失就整键省略。
 * @param base - 必需字段。
 * @param optional - 可选字段；`undefined` / `null` 会被丢弃。
 */
function withOptional (base, optional) {
  const result = { ...base }
  for (const [key, value] of Object.entries(optional ?? {})) {
    if (value !== undefined && value !== null) result[key] = value
  }
  return result
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/**
 * 注册四个工具。Cordis 的 fiber 会自动回收 `ctx.tools.register()` 的返回值
 * （与第一方 dsh-tool-todo 的写法一致），所以这里不再手工包 effect。
 * @param ctx - 插件上下文（`inject: ['tools']` 保证 `ctx.tools` 存在）。
 * @param config - cordis.patch.yml 中该行的 config。
 */
export function apply (ctx, config) {
  const settings = normalizeSettings(ctx, config)
  ctx.tools.register(harnessInstallTool(ctx, settings))
  ctx.tools.register(harnessDownloadTool(ctx, settings))
  ctx.tools.register(pluginInstallTool(ctx, settings))
  ctx.tools.register(pluginManageTool(ctx, settings))
  ctx.logger?.info?.(`dsh-installer: 已注册 4 个工具（manager=${settings.manager}, defaultMode=${settings.defaultMode}）`)
}
