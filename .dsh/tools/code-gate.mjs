#!/usr/bin/env node
/**
 * code-gate.mjs — 把可形式化的代码判据下沉为脚本（P1b，对应 QA C2–C6）
 *
 *   node .dsh/tools/code-gate.mjs --scope <文件...>
 *   node .dsh/tools/code-gate.mjs --scope-file .dsh/tmp/changed.txt
 *   node .dsh/tools/code-gate.mjs --scope <文件...> --json
 *
 * 退出码：0 = 全部 PASS 或 N/A；1 = 有 FAIL；2 = 用法/环境错误。
 *
 * ## 「不适用（N/A）」是合法结论，不是 FAIL
 *
 * 这是本工具**最重要的一条设计**。契约里的 C2–C6 原先硬编码了 compute-core 的 Java 取值
 * （`application.yaml` / `@Slf4j` / `gradlew build` / Mapper XML）。一个 `javascript` 项目
 * 接入后，C2–C6 **五条全都不适用，却被写成必须通过——项目永远过不了关卡**。
 *
 * 所以本工具**一切以 `.dsh/profile.yaml` 为准**：profile 没声明的东西，报告 `N/A`，
 * **不扣分、不阻断**。只有"声明了却没做到"才 FAIL。
 *
 * ## 脚本通过 ≠ 质量合格
 *
 * C1（变更范围与实施清单一致）**判不了形式**，保留人工。本工具**不覆盖 C1**，
 * 也不做 QA 抽检。把代码质量做成"过脚本就算过"，是把手段当成了目的。
 *
 * ## 各项怎么判
 *
 * | 项 | 判法 | N/A 条件 |
 * |---|---|---|
 * | C2 分层 | 文件路径是否落在 `tech_stack.package_layout` 声明的前缀内 | 未声明 `package_layout` |
 * | C3 硬编码 | 静态扫描：明文密钥赋值、字符串拼接 SQL | 永不 N/A（通用） |
 * | C4 错误处理 | 扫描异常类型与日志调用；按 profile 声明的异常包/日志库 | 未声明 `package_layout.exception` 且未声明日志库 |
 * | C5 构建 | 跑 `tech_stack.build` 声明的命令 | `build` 为 `none` 或未声明 |
 * | C6 数据访问 | 参数化查询 + ORM 映射文件与接口一致性 | 项目未用 ORM |
 *
 * 只扫描 `--scope` 给出的文件——**这不是全仓库审计工具**，是"变更检查"。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = resolve(HERE, '..', '..')

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const jsonOut = argv.includes('--json')
const sIdx = argv.indexOf('--scope')
const fIdx = argv.indexOf('--scope-file')
let files = []
if (sIdx >= 0) files = argv.slice(sIdx + 1).filter((a) => !a.startsWith('--'))
else if (fIdx >= 0 && argv[fIdx + 1]) {
  const p = resolve(ROOT, argv[fIdx + 1])
  if (!existsSync(p)) { console.error('--scope-file 不存在：' + p); process.exit(2) }
  files = readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}
if (!files.length) {
  console.error('用法：code-gate.mjs --scope <文件...> | --scope-file <清单> [--json]')
  console.error('说明：本工具只审计 --scope 给出的变更文件，不是全仓库审计工具。')
  process.exit(2)
}
files = files.map((f) => f.replace(/\\/g, '/'))

// ── 极简 YAML 取值（只支持缩进层级的标量与列表，够读 profile 的 tech_stack / paths）──
function readProfile() {
  const p = join(ROOT, '.dsh', 'profile.yaml')
  if (!existsSync(p)) return { raw: '', val: () => undefined, list: () => [] }
  const raw = readFileSync(p, 'utf8')
  const lines = raw.split('\n')
  const val = (dotted) => {
    const parts = dotted.split('.')
    let depth = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*#/.test(line) || !line.trim()) continue
      const indent = line.match(/^\s*/)[0].length
      const key = line.trim().split(':')[0]
      if (key === parts[depth] && indent === depth * 2) {
        depth++
        if (depth === parts.length) {
          const inline = line.trim().slice(key.length + 1).trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
          // ── YAML 块标量（`>-` / `>` / `|` / `|-` / `|+`）──────────────────────
          //
          // 2026-09-19 第九轮补。原实现只取冒号后的**行内**文本，于是
          //   `build: >-` + 随后两行缩进的 powershell 命令
          // 解析出来是**字面量 `>-`**。实测 HelpDocToolkit 就撞上这一条，
          // C5 的提示变成「构建命令 `>-` 无法安全自动执行」——
          // **结论（REVIEW）碰巧没错，但给出的命令是垃圾**，读者根本没法照跑。
          //
          // 为什么必须修：`>-` 是**多行命令的自然写法**，profile 里到处都是
          // （`build_command`、`package`、`checks.*`）。解析器不支持块标量，
          // 等于所有多行取值都读到一串折叠符号。
          if (/^[|>][-+]?$/.test(inline)) {
            const folded = inline.startsWith('>')
            const body = []
            for (let j = i + 1; j < lines.length; j++) {
              const l2 = lines[j]
              if (!l2.trim()) { body.push(''); continue }
              if (l2.match(/^\s*/)[0].length <= indent) break
              body.push(l2.trim())
            }
            // 折叠式（`>`）把换行折成空格；字面式（`|`）保留换行。两者都去掉首尾空白。
            const v = (folded ? body.join(' ') : body.join('\n')).replace(/[ \t]+/g, ' ').trim()
            return v === '' ? undefined : v
          }
          return inline === '' ? undefined : inline
        }
      } else if (depth > 0 && indent <= (depth - 1) * 2) depth = 0
    }
    return undefined
  }
  const list = (dotted) => {
    const parts = dotted.split('.')
    let depth = 0
    const out = []
    let collecting = false
    for (const line of lines) {
      if (/^\s*#/.test(line) || !line.trim()) continue
      const indent = line.match(/^\s*/)[0].length
      const key = line.trim().split(':')[0]
      if (!collecting && key === parts[depth] && indent === depth * 2) {
        depth++
        if (depth === parts.length) { collecting = true; continue }
      } else if (collecting) {
        if (indent === depth * 2 && line.trim().startsWith('- ')) {
          // **必须与标量分支（上面的 `val`）同口径剥掉行尾注释**，2026-09-20 第十轮修。
          //
          // 原先这里只做 `.trim()`，于是 `- packages/ide/src/   # 唯一源码树` 解析出来的
          // 前缀**带着注释文本**，`packages/ide/src/index.ts` 一个都匹配不上 ——
          // C2 于是落到「变更文件不在声明的 package_layout 前缀内」这一条，
          // 判**「不适用（N/A）」**。而 N/A 在本模式里**不阻断**，
          // 所以它的表现是「检查通过、结论看起来正常」，缺陷被静默吞掉。
          //
          // deepseek-harness-UI 接入时实测复现：作者给 `package_layout` 列表项加了行尾注释，
          // C2 静默降级成 N/A；把注释移到列表上方才恢复 PASS。
          // 这是「静默降级」那一类缺陷，按本模式自己的原则必须堵住，
          // 而不是要求每个接入者都记得「列表项不许写注释」。
          const item = line.trim().slice(2).trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
          if (item) out.push(item)
        } else if (indent <= (depth - 1) * 2) break
      }
    }
    return out
  }
  return { raw, val, list }
}
const prof = readProfile()

// ── 扫描器 ──────────────────────────────────────────────────────────────────
const results = []
const add = (id, name, status, detail) => results.push({ id, name, status, detail })

function readAll() {
  const map = new Map()
  for (const f of files) {
    const abs = resolve(ROOT, f)
    if (!existsSync(abs)) { map.set(f, null); continue }
    try { map.set(f, readFileSync(abs, 'utf8')) } catch { map.set(f, null) }
  }
  return map
}
const contents = readAll()

// C2 分层
function checkC2() {
  const layout = prof.val('tech_stack.package_layout')
  const prefixes = prof.list('tech_stack.package_layout')
  const declared = layout !== undefined || prefixes.length > 0
  if (!declared) {
    add('C2', '包/模块分层', 'N/A', 'profile 未声明 tech_stack.package_layout —— 按「不适用」处理，不判 FAIL')
    return
  }
  const ok = [], bad = []
  for (const f of files) {
    const inPrefix = prefixes.some((p) => f.startsWith(p.replace(/\/$/, '') + '/') || f === p)
    ;(inPrefix ? ok : bad).push(f)
  }
  // 无一命中前缀 = 该项目的 layout 声明与本变更无关，仍算 N/A（避免误伤）
  if (ok.length === 0) {
    add('C2', '包/模块分层', 'N/A', '变更文件不在声明的 package_layout 前缀内（布局：' + prefixes.join(', ') + '）——不判 FAIL')
    return
  }
  add('C2', '包/模块分层', 'PASS', ok.length + ' 个文件落在声明的前缀内' + (bad.length ? '；另有 ' + bad.length + ' 个在外（未声明为受管路径，不计失败）' : ''))
}

// C3 硬编码
const SQL_CONCAT = /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)[^;'"\n]*["'`]\s*\+/i
const SECRET_ASSIGN = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*["'`][^"'`\n]{6,}["'`]/i
const SECRET_SKIP = /(placeholder|example|dummy|changeme|xxx+|\*{3,}|<[^>]+>|process\.env|os\.environ|getenv|System\.getenv|\$\{)/i
function checkC3() {
  const hits = []
  for (const [f, t] of contents) {
    if (t === null) continue
    if (!/\.(js|mjs|cjs|ts|tsx|java|py|go|rb|php|cs|kt|scala|xml|yaml|yml|json|properties)$/i.test(f)) continue
    t.split('\n').forEach((line, i) => {
      if (SECRET_ASSIGN.test(line) && !SECRET_SKIP.test(line)) hits.push(f + ':' + (i + 1) + ' 疑似明文密钥赋值')
      if (SQL_CONCAT.test(line)) hits.push(f + ':' + (i + 1) + ' 疑似字符串拼接 SQL')
    })
  }
  if (!hits.length) add('C3', '无硬编码 / 参数化查询', 'PASS', '未发现明文密钥赋值或字符串拼接 SQL')
  else add('C3', '无硬编码 / 参数化查询', 'FAIL', hits.slice(0, 12).join('\n      ') + (hits.length > 12 ? '\n      …另有 ' + (hits.length - 12) + ' 处' : ''))
}

// C4 错误处理与日志
//
// **2026-09-20 第十二轮续：筛选方向从"正向白名单"反转为"负向黑名单"。**
//
// 原先写的是正向白名单 `/\.(js|mjs|cjs|ts|tsx|java|py|go|rb|php|cs|kt|scala)$/`——
// **没列进去的语言，这一项检查就静默地一条都不查**。实测：Rust 项目（`.rs`）不在表内，
// 于是 C4 在**任何** Rust 项目上都只输出"符合 profile 声明的异常包与日志库"（因为 notes 恒为空），
// **看起来是 PASS，实际是没查**。
//
// **这正是下面 C5 那段教训的同族缺陷**（"N/A / PASS 在本模式里是合法且不阻断的结论，
// 所以判据失效时的表现是静默通过，而不是报错"）。正向白名单的**失效方向朝漏检**，
// 每加一门语言都要有人记得回来补表——**依赖记忆的判据迟早会漏**。
//
// 反转后：**未知语言默认被检查**，只有明确"不是代码"的扩展名才排除。
// 失效方向因此朝"多查几个文件"——而 C4 的结论本来就是 REVIEW（**非阻断**），
// 多报几个待人工确认的文件，代价远小于静默漏检。
const NOT_SOURCE = /\.(md|markdown|mdx|txt|rst|json|json5|jsonc|ya?ml|toml|ini|cfg|conf|properties|lock|log|csv|tsv|xml|html?|xhtml|css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|tar|jar|war|ear|exe|dll|so|dylib|class|pyc|pyo|o|a|lib|bin|dat|db|sqlite|woff2?|ttf|eot|mp[34]|wav|avi|mp4|mov|map|snap|patch|diff|min\.js|min\.css)$/i

function checkC4() {
  const excPkg = prof.val('tech_stack.package_layout.exception') ?? prof.val('package_layout.exception')
  const logLib = prof.val('tech_stack.logging') ?? prof.val('tech_stack.log_library')
  if (!excPkg && !logLib) {
    add('C4', '错误处理与日志', 'N/A', 'profile 未声明异常包，也未声明日志库——按「不适用」处理。**不得据此判「无错误处理」**')
    return
  }
  const notes = []
  for (const [f, t] of contents) {
    if (t === null || NOT_SOURCE.test(f)) continue
    if (excPkg && !t.includes(excPkg)) notes.push(f + ' 未出现声明的异常包 ' + excPkg + '（若本文件不处理异常可忽略）')
    if (logLib && !t.toLowerCase().includes(logLib.toLowerCase())) notes.push(f + ' 未出现声明的日志库 ' + logLib + '（若本文件不记日志可忽略）')
  }
  add('C4', '错误处理与日志', notes.length ? 'REVIEW' : 'PASS',
    notes.length ? '需人工确认（**不是自动 FAIL**）：\n      ' + notes.slice(0, 8).join('\n      ') : '符合 profile 声明的异常包与日志库')
}

// C5 构建
function checkC5() {
  // **有效命令要先把两种写法都取到，再判"不适用"。**
  //
  // 2026-09-19 第九轮修正。原实现先看标量 `tech_stack.build`、为空就返回 N/A，
  // 而 `build.compile` **在这之后才被使用**——于是嵌套写法
  // （`build:` 下挂 `compile:`）永远拿不到那条命令：
  // YAML 里 `build` 是"有子键的父行"，扁平解析对它返回**空串**，`!build` 成立 ⇒ **N/A**。
  //
  // **为什么这条特别危险**：N/A 在本模式里是**合法且不阻断**的结论
  // （「不适用」不等于「没查」），所以"项目明明有构建、闸门却说不适用"
  // 会**静默通过**，而不是报错。实测三种写法：
  //   `build: none` → N/A ✓　`build: msbuild` → REVIEW ✓　`build: {compile: npm …}` → N/A ✗
  // 工具本来就**想**支持嵌套写法（它读了这个键），是判断顺序把它废掉了。
  const build = prof.val('tech_stack.build')
  const nested = prof.val('tech_stack.build.compile')
  const run = nested || build
  if (!run || run === 'none' || run === '无') {
    const shown = run === '' || run === undefined ? (build ? '未声明 compile' : '未声明') : run
    add('C5', '编译/构建验证', 'N/A', 'profile 的 tech_stack.build = ' + shown + ' —— 无构建步骤，按「不适用」处理')
    return
  }
  if (/^(gradlew|gradle|mvn|npm|pnpm|yarn|make|cargo|go|dotnet|python|tsc)\b/.test(run)) {
    const r = spawnSync(run, { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 600000 })
    const tail = String(r.stdout || '').split('\n').slice(-6).join('\n      ') + String(r.stderr || '').split('\n').slice(-6).join('\n      ')
    add('C5', '编译/构建验证', r.status === 0 ? 'PASS' : 'FAIL', '命令 `' + run + '` 退出码 ' + r.status + (tail.trim() ? '\n      ' + tail.trim() : ''))
  } else {
    add('C5', '编译/构建验证', 'REVIEW', 'profile 声明的构建命令 `' + run + '` 无法安全自动执行——请人工执行并附输出')
  }
}

// C6 数据访问
const ORM_HINT = /(mapper|dao|repository|entity)\b/i
function checkC6() {
  const ormFiles = files.filter((f) => ORM_HINT.test(f) || /\.xml$/i.test(f))
  if (!ormFiles.length) {
    add('C6', '数据访问参数化', 'N/A', '本次变更无 ORM/DAO/Mapper 文件——按「不适用」处理')
    return
  }
  const problems = []
  for (const f of ormFiles) {
    const t = contents.get(f)
    if (t === null) { problems.push(f + ' 不可读'); continue }
    // XML namespace 与文件路径一致性（MyBatis 惯例）
    if (/\.xml$/i.test(f)) {
      const ns = t.match(/namespace\s*=\s*["']([^"']+)["']/)
      if (ns) {
        const lastSeg = ns[1].split('.').pop()
        if (!f.toLowerCase().includes(lastSeg.toLowerCase())) problems.push(f + ' 的 namespace(`' + ns[1] + '`) 末段与文件路径不一致')
      } else problems.push(f + ' 是 XML 但未找到 namespace —— 若非 MyBatis 映射文件可忽略')
    }
  }
  add('C6', '数据访问参数化', problems.length ? 'REVIEW' : 'PASS',
    problems.length ? '需人工确认（**不是自动 FAIL**）：\n      ' + problems.join('\n      ') : ormFiles.length + ' 个 ORM/映射文件已核对')
}

checkC2(); checkC3(); checkC4(); checkC5(); checkC6()

// C1 明确排除
add('C1', '变更范围与实施清单一致', 'MANUAL', '**判不了形式，保留人工**——本工具不覆盖 C1，也不做 QA 抽检')

// ── 输出 ────────────────────────────────────────────────────────────────────
const ICON = { PASS: '✓', FAIL: '✗', 'N/A': '–', REVIEW: '?', MANUAL: '人' }
const fails = results.filter((r) => r.status === 'FAIL')
const reviews = results.filter((r) => r.status === 'REVIEW')
const nas = results.filter((r) => r.status === 'N/A')

if (jsonOut) {
  // **--json 必须只吐 JSON**：尾部摘要会污染 stdout，让消费方（CI、其他脚本）解析失败。
  console.log(JSON.stringify({ scope: files, results, fail: fails.length, review: reviews.length, na: nas.length }, null, 2))
  process.exit(fails.length ? 1 : 0)
} else {
  console.log('[code-gate] 审计 ' + files.length + ' 个变更文件（profile: ' + (prof.val('meta.project') ?? '?') + '，language: ' + (prof.val('tech_stack.language') ?? '?') + '，build: ' + (prof.val('tech_stack.build') ?? '?') + '）\n')
  for (const r of results) {
    console.log('  ' + (ICON[r.status] ?? '?') + ' ' + r.id + ' ' + r.name.padEnd(22) + r.status)
    if (r.detail && r.status !== 'PASS') console.log('      ' + r.detail)
    else if (r.detail) console.log('      ' + r.detail)
  }
  const nPass = results.filter((r) => r.status === 'PASS').length
  const nManual = results.filter((r) => r.status === 'MANUAL').length
  console.log('\n  汇总：PASS ' + nPass + ' ｜ FAIL ' + fails.length + ' ｜ 待人工确认 ' + reviews.length + ' ｜ 不适用 ' + nas.length + ' ｜ 人工 ' + nManual)
  if (nas.length) console.log('  「不适用」是本工具的**合法结论**，不是失败——项目未声明该技术栈时不该被它的判据卡住。')
  console.log('\n  ⚠️  **脚本通过 ≠ 质量合格**：本工具只证明可形式化的那部分成立，**C1 与 QA 抽检判断不可省**。')
}

if (fails.length) { console.log('\n[code-gate] FAIL：' + fails.length + ' 项'); process.exit(1) }
console.log('\n[code-gate] PASS：无自动判定的失败项' + (reviews.length ? '（另有 ' + reviews.length + ' 项待人工确认）' : ''))
process.exit(0)
