/**
 * @hellogitd/dsh-installer 功能测试。
 *
 * 用「真实 node child_process + 真实 npm + 真实 npm registry」替换 DSH 的
 * ctx.subprocess / ctx.pluginManager（按已核对的 provider 契约实现），
 * 从而在不启动完整 Host 的情况下验证工具的真实行为。
 *
 * 用法（在包目录里跑）：
 *   node test/functional-test.mjs               # 快速路径（dryRun / 下载 / 假 pluginManager）
 *   node test/functional-test.mjs --install-e2e # 追加：真的用 npm 把 dsh 装进临时目录
 *
 * 会真实访问 registry.npmjs.org，并在系统临时目录下读写测试文件。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, extname, join, resolve as resolvePath } from 'node:path'
import { apply } from '../index.js'

const runInstallE2E = process.argv.includes('--install-e2e')
const ROOT = join(tmpdir(), 'dsh-installer-test')
const failures = []
const check = (condition, label) => {
  if (condition) console.log(`  ✓ ${label}`)
  else { failures.push(label); console.log(`  ✗ ${label}`) }
}

/* ---------- 按 provider 契约实现的假 subprocess ---------- */

/**
 * 模拟 provider 的 childEnv()：清理后的父环境 + 显式覆盖；Windows 上按名字
 * 大小写不敏感地替换（这正是真实现的行为，也是插件不该整包传 env 的原因）。
 */
function childEnv (extra) {
  const merged = { ...process.env }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) continue
    for (const existing of Object.keys(merged)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete merged[existing]
    }
    merged[key] = value
  }
  return merged
}

/** 与 provider 的 environmentValue() 同语义：Windows 上按大小写不敏感读取。 */
function environmentValue (env, name) {
  const exact = env[name]
  if (exact !== undefined || process.platform !== 'win32') return exact
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value
  return undefined
}

function resolveExecutable (command, env) {
  const environment = childEnv(env)
  const pathValue = environmentValue(environment, 'PATH') ?? ''
  const extensions = process.platform === 'win32' && extname(command) === ''
    ? (environmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolvePath(process.cwd(), directory, command + extension)
      if (existsSync(candidate)) return Promise.resolve(candidate)
    }
  }
  return Promise.reject(new Error(`not found on PATH: ${command}`))
}

function spawn (spec) {
  const [program, ...args] = spec.argv
  console.log(`    $ ${program} ${args.join(' ')}`.slice(0, 300))
  const child = nodeSpawn(program, args, {
    cwd: spec.cwd,
    env: childEnv(spec.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  const reader = (get) => ({ readFrom: () => ({ text: get(), nextOffset: get().length, lossy: false }) })
  return {
    stdin: undefined,
    stdout: child.stdout,
    stderr: child.stderr,
    control: undefined,
    collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
    done,
    terminate: () => child.kill(),
    waitForExit: () => done.then(() => true)
  }
}

/* ---------- 假 pluginManager（记录调用参数） ---------- */

const pluginCalls = []
const pluginManager = {
  async inspect (spec, options, signal) {
    pluginCalls.push({ method: 'inspect', spec, options })
    if (spec === '@local/not-a-bundle') return { status: 'accepted', kind: 'path', name: 'not-a-bundle', version: '0.0.1', bundle: false, registry: null }
    if (spec === 'missing-package') return { status: 'refused', problem: 'not-found', reason: 'registry 里没有这个包', registries: ['https://registry.npmjs.org/'] }
    return { status: 'accepted', kind: 'registry', name: spec, version: '9.9.9', bundle: true, registry: 'https://registry.npmjs.org/' }
  },
  async installBundle (spec, options) {
    pluginCalls.push({ method: 'installBundle', spec, options })
    // 真实服务对「同一个本地路径重复安装」的实际返回（pnpm 报 Already up to date）：
    if (spec === '@local/already-there') {
      return {
        changed: false,
        application: 'failed',
        stage: 'install',
        target: spec,
        error: { code: 'ambiguous-install', diagnostic: 'pnpm 没有加入任何包' },
        warnings: [],
        pendingBuilds: [],
        packageResult: { exitCode: 0, output: 'Already up to date', truncated: false, logPath: '/tmp/log' }
      }
    }
    return {
      changed: true,
      application: 'applied',
      stage: 'install',
      target: spec,
      bundle: spec,
      enabled: options.enabled !== false,
      warnings: ['已有无关故障：x'],
      pendingBuilds: [],
      registries: [null, 'https://registry.npmmirror.com/'],
      packageResult: { exitCode: 0, output: 'added 1 package', truncated: false, logPath: '/tmp/log' }
    }
  },
  async listBundles () {
    return [
      { name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2', enabled: true, installed: true, optional: false, removable: false, rows: [{}, {}], overrides: [] },
      { name: '@hellogitd/dsh-installer', version: '1.0.0', enabled: true, installed: true, optional: false, removable: true, rows: [{}], overrides: [] }
    ]
  },
  async listPlugins () {
    return [
      { entryId: 'dsh-installer', moduleName: '@hellogitd/dsh-installer', enabled: true, fiberPhase: 'active' },
      { entryId: 'tool-plugin-manager', moduleName: '@deepseek-ai/dsh-plugin-manager', enabled: false, fiberPhase: null }
    ]
  },
  async setBundleEnabled (name, enabled) {
    pluginCalls.push({ method: 'setBundleEnabled', name, enabled })
    return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
  },
  async setPluginEnabled (id, enabled) {
    pluginCalls.push({ method: 'setPluginEnabled', id, enabled })
    return { changed: true, application: 'restart-required', stage: 'enable', target: id, enabled }
  },
  async removeBundle (name) {
    pluginCalls.push({ method: 'removeBundle', name })
    return { changed: true, application: 'applied', stage: 'remove', target: name, warnings: [] }
  }
}

/* ---------- 装载插件 ---------- */

const definitions = new Map()
const services = { subprocess: { resolveExecutable, spawn }, pluginManager }
const ctx = {
  tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {} } },
  get: (key) => services[key],
  logger: { info: () => {}, warn: (message) => console.log(`  [warn] ${message}`) }
}
apply(ctx, { manager: 'npm', defaultMode: 'project', verify: true, timeoutMs: 600000 })

/**
 * 找出第一个不是合法 JSON 的值（undefined / 函数 / Symbol / 非有限数字 / 自定义原型）。
 *
 * 注册表在工具返回后会先做 `snapshotToolValue`：值里只要有一个 `undefined`
 * （例如误写成 `字段: value ?? undefined`），整次调用就会以
 * `value is not lossless JSON` 失败——这个函数就是那条规则的本地实现。
 */
function findNonJson (value, path = 'value') {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return null
  if (type === 'number') return Number.isFinite(value) ? null : `${path} 不是有限数字`
  if (type === 'undefined') return `${path} 是 undefined`
  if (type !== 'object') return `${path} 的类型是 ${type}`
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const bad = findNonJson(item, `${path}[${index}]`)
      if (bad !== null) return bad
    }
    return null
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return `${path} 的原型不是普通对象`
  for (const [key, item] of Object.entries(value)) {
    const bad = findNonJson(item, `${path}.${key}`)
    if (bad !== null) return bad
  }
  return null
}

/** 校验值是否满足本插件用到的 JSON Schema 子集。 */
function validateValue (schema, value, path = 'value') {
  const violations = []
  if (Array.isArray(schema.oneOf)) {
    if (!schema.oneOf.some((branch) => validateValue(branch, value, path).length === 0)) {
      violations.push(`${path} 不匹配任何 oneOf 分支`)
    }
    return violations
  }
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const typeOk = schema.type === 'integer' ? actual === 'number' && Number.isInteger(value) : actual === schema.type
  if (!typeOk) {
    violations.push(`${path} 应为 ${schema.type}，实际是 ${actual}`)
    return violations
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path} 不在 enum 内`)
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} 缺失`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`${path}.${key} 是未声明的属性`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) violations.push(...validateValue(child, value[key], `${path}.${key}`))
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    for (const [index, item] of value.entries()) violations.push(...validateValue(schema.items, item, `${path}[${index}]`))
  }
  return violations
}

/** 每个工具返回值都要过这两关，否则真实 Host 里会变成 INVALID_TOOL_OUTPUT。 */
function assertOutput (definition, value) {
  const bad = findNonJson(value)
  check(bad === null, `${definition.name} 返回值是无损 JSON${bad === null ? '' : `（${bad}）`}`)
  if (bad !== null) return
  const violations = validateValue(definition.output.schema, value)
  check(violations.length === 0, `${definition.name} 返回值满足 output.schema${violations.length === 0 ? '' : `（${violations.join('; ')}）`}`)
}

// 检测器自检：必须能抓到 `字段: value ?? undefined`，否则上面的检查没有意义。
if (findNonJson({ ok: true, bundle: undefined }) === null) {
  failures.push('自检失败：findNonJson 没抓到值为 undefined 的属性')
}
if (findNonJson({ ok: true, notes: ['a'], n: 1 }) !== null) {
  failures.push('自检失败：findNonJson 误报了正常的无损 JSON 对象')
}

const tool = (name) => {
  const definition = definitions.get(name)
  if (!definition) throw new Error(`未注册的工具：${name}`)
  return {
    ...definition,
    async execute (args, exec) {
      const value = await definition.execute(args, exec)
      assertOutput(definition, value)
      return value
    }
  }
}
const exec = (signal) => ({ signal: signal ?? new AbortController().signal, args: {} })

/* ---------- 用例 ---------- */

console.log('\n[1] dsh_harness_install --dryRun')
{
  const result = await tool('dsh_harness_install').execute(
    { version: '0.2.0-rc.2', mode: 'global', dryRun: true },
    exec()
  )
  console.log(`    ${result.summary}`)
  check(result.ok === true, 'dryRun 返回 ok')
  check(result.command.includes('install -g @deepseek-ai/dsh@0.2.0-rc.2'), '命令包含 npm install -g 与目标 spec')
}

console.log('\n[2] 参数校验：非法 version / registry 必须直接报错')
{
  for (const [args, label] of [
    [{ version: '0.2.0; rm -rf /' }, '拒绝含 shell 元字符的 version'],
    [{ version: 'latest', registry: 'file:///etc/passwd' }, '拒绝非 http(s) registry'],
    [{ version: 'latest', mode: 'project' }, 'project 模式缺少 dir 时报错']
  ]) {
    let threw = null
    try { await tool('dsh_harness_install').execute(args, exec()) } catch (error) { threw = error }
    check(threw !== null, label)
    if (threw) console.log(`    → ${threw.message}`)
  }
}

console.log('\n[3] dsh_harness_download：真实访问 npm registry，校验 sha512')
{
  const outDir = join(ROOT, 'downloads')
  await rm(outDir, { recursive: true, force: true })
  const result = await tool('dsh_harness_download').execute(
    { version: '0.2.0-rc.2', outDir, verify: true, overwrite: true },
    exec()
  )
  console.log(result.summary.split('\n').map((line) => `    ${line}`).join('\n'))
  check(result.ok === true, '下载成功')
  check(result.verified === true, 'sha512/sha1 完整性校验通过')
  check(existsSync(result.file), '文件已落盘')
  check(result.bytes > 5000, `tarball 体积合理（${result.bytes} 字节）`)
  const again = await tool('dsh_harness_download').execute({ version: '0.2.0-rc.2', outDir, verify: true }, exec())
  check(again.ok === true && again.summary.includes('已存在'), 'outDir 已有文件时不重复下载')
}

console.log('\n[4] dsh_plugin_install：走 pluginManager.installBundle')
{
  const result = await tool('dsh_plugin_install').execute({ spec: '@local/demo-bundle', registry: 'https://registry.npmmirror.com/' }, exec())
  console.log(result.summary.split('\n').map((line) => `    ${line}`).join('\n'))
  check(result.ok === true && result.application === 'applied', '安装返回 applied')
  const install = pluginCalls.findLast((call) => call.method === 'installBundle')
  check(install?.options?.registry === 'https://registry.npmmirror.com/', 'registry 透传给 installBundle')
  check(install?.options?.enabled === true, 'enabled 默认 true')
  check(pluginCalls.some((call) => call.method === 'inspect'), '默认做 inspect 预检')
}

console.log('\n[5] dsh_plugin_install：预检拒绝 / 非 bundle 提示')
{
  const refused = await tool('dsh_plugin_install').execute({ spec: 'missing-package' }, exec())
  check(refused.ok === false && refused.summary.includes('not-found'), 'registry 找不到包时返回结构化失败')
  const notBundle = await tool('dsh_plugin_install').execute({ spec: '@local/not-a-bundle', preflight: true }, exec())
  check(notBundle.ok === true && notBundle.summary.includes('dsh.bundle.patch'), '非组合包给出提示但仍然安装')
  const skipped = await tool('dsh_plugin_install').execute({ spec: '@local/plain', preflight: false }, exec())
  check(skipped.ok === true, 'preflight=false 时跳过 inspect')
  const ambiguous = await tool('dsh_plugin_install').execute({ spec: '@local/already-there', preflight: false }, exec())
  console.log(ambiguous.summary.split('\n').map((line) => `    ${line}`).join('\n'))
  check(ambiguous.ok === false && ambiguous.application === 'failed', '重装已有包时如实报告 failed（不吞掉失败）')
  check(ambiguous.summary.includes('ambiguous-install'), '保留服务的原始错误码')
  check(ambiguous.summary.includes('已经装过'), 'ambiguous-install 翻译成人话提示')
}

console.log('\n[6] dsh_plugin_manage：list / set_enabled / remove')
{
  const list = await tool('dsh_plugin_manage').execute({ action: 'list' }, exec())
  console.log(list.summary.split('\n').map((line) => `    ${line}`).join('\n'))
  check(list.ok === true && list.bundles.length === 2 && list.plugins.length === 2, 'list 返回组合包与插件条目')

  const bundleToggle = await tool('dsh_plugin_manage').execute({ action: 'set_enabled', name: '@hellogitd/dsh-installer', enabled: false }, exec())
  check(bundleToggle.ok === true && bundleToggle.application === 'applied', 'set_enabled 切换组合包')
  const entryToggle = await tool('dsh_plugin_manage').execute({ action: 'set_enabled', entryId: 'tool-plugin-manager', enabled: true }, exec())
  check(entryToggle.application === 'restart-required' && entryToggle.summary.includes('重启'), '启动型 profile 提示重启')
  const removed = await tool('dsh_plugin_manage').execute({ action: 'remove', name: '@hellogitd/dsh-installer' }, exec())
  check(removed.ok === true && removed.application === 'applied', 'remove 卸载组合包')

  for (const [args, label] of [
    [{ action: 'set_enabled', enabled: true }, 'set_enabled 未提供 name/entryId 时报错'],
    [{ action: 'set_enabled', name: 'a', entryId: 'b', enabled: true }, 'set_enabled 同时提供两者时报错'],
    [{ action: 'set_enabled', name: 'a' }, 'set_enabled 缺少 enabled 时报错'],
    [{ action: 'bogus' }, '未知 action 报错']
  ]) {
    let threw = null
    try { await tool('dsh_plugin_manage').execute(args, exec()) } catch (error) { threw = error }
    check(threw !== null, label)
  }
}

console.log('\n[7] 真实 curl 级下载：bad integrity 必须拒绝并落盘失败')
{
  const outDir = join(ROOT, 'integrity')
  await rm(outDir, { recursive: true, force: true })
  const result = await tool('dsh_harness_download').execute(
    { version: '0.2.0-rc.2', outDir, integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', overwrite: true },
    exec()
  )
  check(result.ok === false && result.verified === false, '错误的 integrity 被拒绝')
  check(!existsSync(join(outDir, 'dsh-0.2.0-rc.2.tgz')), '校验失败时不写入文件')
}

console.log('\n[8] dsh_plugin_search：真实访问 npm 搜索接口')
{
  const result = await tool('dsh_plugin_search').execute({ query: '语音输入', limit: 5 }, exec())
  console.log(result.summary.split('\n').slice(0, 14).map((line) => `    ${line}`).join('\n'))
  check(result.ok === true && result.results.length > 0, '中文功能描述能搜到候选')
  check(result.results.every((item) => item.bundle === true), '默认只返回声明了 dsh.bundle.patch 的组合包')
  check(result.results.every((item) => typeof item.spec === 'string' && item.spec.startsWith(item.name)), '每个候选都带可直接安装的 spec')
  check(result.results.every((item) => item.index >= 1 && item.index <= result.results.length), '候选带 1 起连续编号')
  check(result.summary.includes('fromSearch'), '结果里告诉模型用 fromSearch 按编号安装')

  const popular = await tool('dsh_plugin_search').execute({ sort: 'popular', limit: 5 }, exec())
  console.log(popular.summary.split('\n').slice(0, 10).map((line) => `    ${line}`).join('\n'))
  const counts = popular.results.map((item) => item.downloads).filter((value) => typeof value === 'number')
  check(popular.ok === true && popular.results.length > 0, '不给关键词时列出最火的插件')
  check(counts.length === popular.results.length, '每个候选都带回上月下载量')
  check(counts.every((value, index) => index === 0 || counts[index - 1] >= value), 'popular 按下载量降序')
  check(popular.summary.includes('最火'), '摘要说明了这是"最火"榜')

  const english = await tool('dsh_plugin_search').execute({ query: 'archive sessions', limit: 3 }, exec())
  check(english.ok === true && english.results.length > 0, '英文功能描述也能搜到')
}

console.log('\n[9] 按编号安装（fromSearch）')
{
  const search = await tool('dsh_plugin_search').execute({ query: '余额', limit: 3 }, exec())
  const pick = search.results[1]
  const result = await tool('dsh_plugin_install').execute({ fromSearch: 2, preflight: false }, exec())
  console.log(result.summary.split('\n').map((line) => `    ${line}`).join('\n'))
  check(result.ok === true, '按编号安装成功')
  check(result.summary.includes(pick.spec), `装的就是第 2 个（${pick.spec}）`)
  const install = pluginCalls.findLast((call) => call.method === 'installBundle')
  check(install?.spec === pick.spec, 'installBundle 收到的 spec 与列表里的一致')

  for (const [args, label] of [
    [{ fromSearch: 999, preflight: false }, '编号越界时报错'],
    [{ spec: 'x', fromSearch: 1 }, 'spec 与 fromSearch 同时给时报错'],
    [{}, '两者都不给时报错']
  ]) {
    let threw = null
    try { await tool('dsh_plugin_install').execute(args, exec()) } catch (error) { threw = error }
    check(threw !== null, label)
    if (threw) console.log(`    → ${threw.message}`)
  }
}

if (runInstallE2E) {
  console.log('\n[10] dsh_harness_install：真实 npm 项目内安装 + dsh --version 校验')
  const dir = join(ROOT, 'dsh-project')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const started = Date.now()
  const result = await tool('dsh_harness_install').execute(
    { version: '0.2.0-rc.2', mode: 'project', dir, verify: true },
    exec()
  )
  console.log(result.summary.split('\n').map((line) => `    ${line}`).join('\n'))
  check(result.ok === true, '安装成功')
  check(result.version === '0.2.0-rc.2', `已装版本正确（${result.version}）`)
  check(result.verified === true, 'dsh --version 校验通过')
  check(existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), 'CLI 入口存在')
  const manifest = JSON.parse(await readFile(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  check(manifest.version === '0.2.0-rc.2', '磁盘上的 package.json 版本一致')
  console.log(`    耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

console.log(`\n${failures.length === 0 ? '全部用例通过' : `失败 ${failures.length} 项`}`)
for (const failure of failures) console.log(` - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
