#!/usr/bin/env node
/**
 * ref-integrity-check.mjs — 交付件引用完整性 + 交付自包含
 *
 * ## 它守的两个不变量
 *
 * **不变量一：契约/skill 引用的 `.dsh/` 路径必须真实存在。**
 * 契约说"跑 `node .dsh/tools/xxx.mjs`"而那个文件不在交付件里时，
 * **没有任何东西会报错**——角色照着做，得到 `Cannot find module`，
 * 然后要么跳过检查、要么自己编一个判据。这条不变量把这个缺口堵上。
 *
 * **不变量二：交付单位是 `.dsh/` + `.env`，所以模式资产不得留在仓库根。**
 * 曾经 `tools/`、`tests/` 躺在仓库根：`.dsh/` 拷给别的项目后，
 * 契约引用的测试**在交付件里根本不存在**。搬家之后这条不变量防止它回流。
 *
 * **`dev/`、`docs/`、`baseline/` 是例外，不是残留**：它们是模式仓库自己的开发工作区，
 * 按设计就不交付（`dev/` 里的 4 支探的是本机 harness 预设与兄弟项目，换个环境即失效）。
 * 所以本检查**只管 `tools/` `tests/` 这两个"曾经放错位置的名字"**，
 * 而不是"仓库根不许有任何目录"——后者会把合法的开发工作区一起判死。
 *
 * ## 三种判定的区别（关键）
 *
 * | 情况 | 判定 | 理由 |
 * |---|---|---|
 * | `.dsh/` 下的**文件**引用不存在 | **FAIL** | 契约指向了一个拿不到的东西 |
 * | `{{a.b}}` 在 `profile.yaml` 里解析不了 | **FAIL** | 契约会带着原样的占位符继续跑并照常出判定 |
 * | `baseline/` 溯源指针未标注"模式仓库" | **FAIL** | 消费项目会去找一个不存在的目录 |
 * | 契约写了 `.mjs` 但该脚本不存在 | **FAIL** | 幽灵引用：读者去找它，找不到 |
 * | 契约里同行提到真实脚本的裸名不存在 | WARN | 裸名可能是普通英文词，需人判断 |
 * | `.dsh/tmp/**`、`.dsh/reports/**` 不存在 | 忽略 | 临时产物目录，闭环删除后为空是正常的 |
 * | 仓库根还有 `tools/`、`tests/` | **FAIL** | 交付件外还留着模式资产 |
 * | 仓库根有 `dev/`、`docs/`、`baseline/` | 忽略 | **按设计不交付的开发工作区**，非残留 |
 *
 * ## 用法
 *
 *   node .dsh/tests/ref-integrity-check.mjs [--root <仓库根>]
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const ROOT = resolve(argOf('--root', process.cwd()))

// ── profile.yaml 扁平解析（缩进栈）──────────────────────────────────────────
function parseFlatYaml(text) {
  const out = {}
  const stack = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.length - raw.replace(/^\s*/, '').length
    const m = raw.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const [, key, rest] = m
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key })
    const path = stack.map((s) => s.key).join('.')
    const val = rest.replace(/\s+#.*$/, '').trim()
    if (val !== '') out[path] = val.replace(/^['"]|['"]$/g, '')
    else out[path] = ''
  }
  return out
}

const profilePath = join(ROOT, '.dsh/profile.yaml')
const profile = existsSync(profilePath) ? parseFlatYaml(readFileSync(profilePath, 'utf8')) : {}

// ── 遍历契约与 skill ───────────────────────────────────────────────────────
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.md')) acc.push(p)
  }
  return acc
}
const TARGETS = [
  ...walk(join(ROOT, '.dsh/contracts')),
  ...walk(join(ROOT, '.dsh/contracts-research')),
  ...walk(join(ROOT, '.dsh/skills')), // skill 也是交付件，其引用同样必须在交付集内
]

const INLINE = /`([^`\n]+)`/g
const PLACEHOLDER = /\{\{\s*([a-z_][a-z0-9_.]*)\s*\}\}/gi
// 不该当成"路径"的：含通配、花括号枚举、尖括号占位、竖线、或明显是命令/正则的
const NOT_A_PATH = /[*<>|\\^$()[\],{}]|\s-\w|::/
// 临时产物目录：闭环删除后为空是正常的，不参与存在性判定
const WORK_DIRS = ['.dsh/tmp', '.dsh/reports']

/**
 * 允许出现的"故意不存在"的 `.dsh/` 路径，每条都必须写明**为什么不算悬空**。
 *
 * **这不是绕过检查，而是把"历史叙述"与"可执行指令"分开**：
 * `.dsh/README.md` 和契约 README 需要**解释归档曾被删除**，正文里必然出现
 * `.dsh/archive/` 这个词；它出现在"当时"的叙述句里，不是任何角色要跑的路径。
 * 判据是**语义**（这句是历史还是在叫人去跑），正则做不到，所以只能显式登记。
 *
 * **登记纪律**：新增一条前，先回到那行确认它是叙述句。任何"去跑这个路径"的
 * 引用**一律不得登记**——那正是本检查要抓的东西。
 */
const INTENTIONAL_ABSENT = [
  { tok: '.dsh/archive/', why: 'README 里解释"归档已被删除"的叙述句，非可执行引用' },
]
function isIntentional(tok) {
  return INTENTIONAL_ABSENT.find((e) => tok.startsWith(e.tok))
}

const failures = []
const notes = []
const warnings = []

// ── 幽灵脚本引用：契约点名了一个已不存在的脚本 ─────────────────────────────
//
// **这条检查是踩出来的**：2026-09-18 删掉 9 支一次性脚本后，`gate-standard.md`
// 里一句"度量类仅作诊断"仍写着 `numeric-density` / `progress-final`。
// 当时只按完整文件名（`xxx.mjs`）扫描，**没匹配到裸名写法**，于是漏掉。
// 在交付件里点名一个不存在的脚本，后果和悬空路径一样：读者去找它，找不到。
//
// **只对契约生效，不对 skill 生效**——这不是偷懒，是两类文件的语义不同：
//   契约是**当下的指令**（"你要跑 X"），点名一个不存在的 X 就是坏指令；
//   skill 是**战史兼手册**（`doc-rewrite-a-class.md` 通篇在复述当时的做法），
//   复述里必然出现**当时存在、现已删除**的脚本名，那是历史事实，不是幽灵引用。
//   对 skill 强加这条检查，只会产出几十条必须逐条豁免的噪音。
const REAL_SCRIPTS = new Set()
for (const d of ['.dsh/tools', '.dsh/tests']) {
  const abs = join(ROOT, d)
  if (!existsSync(abs)) continue
  for (const e of readdirSync(abs)) if (e.endsWith('.mjs')) REAL_SCRIPTS.add(e.replace(/\.mjs$/, ''))
}
// 形如 `foo-bar` 的脚本名（含连字符，避免把普通英文词全抓进来）
const SCRIPT_STEM = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/
const knownGhosts = new Map()
// 与 knownGhosts 同理：同一个未声明的键只报一次。
// 一个键会在契约里出现几十次（`{{paths.changelog}}` 在 4 份契约里都有），
// 不去重就会用同一句话把真正的发现淹掉。
const knownKeyGaps = new Map()

/**
 * 这个顶层段是不是**已被显式声明为不适用**？
 *
 * **为什么要单独判这一档**：契约里的 `{{deploy.registry}}` / `{{deploy.arch}}` 写在
 * `deploy-standard.md` 的 Makefile 模板块里，而该契约开头就写着
 * 「**`profile.yaml` 未声明 `deploy` 的项目（如本仓库 agent-mode），本契约整体不适用**」。
 *
 * agent-mode 声明的是 `deploy: { platform: none, orchestration: none }` —— **段在，但声明为"不适用"**。
 * 若不判这一档，模式仓库自己会永久挂着 3 条 `deploy.*` 的 WARN。
 * **永久噪音会训练人忽略警告**（`workspace-env-check` 踩过同样的坑：
 * 把"测不了"报成"失败"，结果没人再看那个检查器）。所以这一档必须加。
 *
 * 判据：**该段的全部子键都取值为 `none`** ⇒ 整段声明为不适用 ⇒ 其子键不必解析。
 *
 * **注意是"全部"而不是"任一"**：第一版写成"任一子键为 none 即整段不适用"，
 * 结果探针（把 `platform: none` 改成 `platform: docker`，保留 `orchestration: none`）
 * **依然静默**——判据被一个无关子键劫持了。
 * 语义上也只有"整段都是 none"才等于"我明确不需要这段"；
 * 只要有一项有实质取值，这段就是在用的，缺的子键就该报。
 */
function sectionInert(top) {
  // 整段写成一个标量 `deploy: none` 的情形
  if (String(profile[top] ?? '').trim().toLowerCase() === 'none') return true
  // **只看真正的子键**（`top + '.'` 前缀）。第一版把 `top` 自己也算了进来，
  // 而父行（`deploy:` 后面没有内联值）解析出来的值是**空串**，
  // 空串 ≠ "none" ⇒ `every` 永远为 false ⇒ 这一档**从未生效过**。
  // 又一次"看着在防、其实没防"——所以下面两条探针必须双向验证，不能只验一个方向。
  const sub = Object.keys(profile).filter((k) => k.startsWith(top + '.'))
  if (!sub.length) return false
  return sub.every((k) => String(profile[k]).trim().toLowerCase() === 'none')
}
// 剥掉 `{{paths.tools}}` / `${PROJ}` / `{PROJ}` 之类前缀，只留文件名
const stripPrefix = (s) =>
  s.replace(/\{\{[^}]*\}\}/g, '').replace(/\$\{[^}]*\}/g, '').replace(/\{[A-Z_]+\}/g, '')
const basenameOf = (s) => stripPrefix(s).trim().split(/\s+/).filter(Boolean).pop()?.split(/[/\\]/).pop() ?? ''

/**
 * 从一段内联代码里挑出**脚本名**。
 *
 * **为什么不能直接用 `basenameOf`**：它取的是空格分隔的**最后一个** token（这样能剥掉
 * `node` 前缀）。但代码片段常写作 `` `<脚本>.mjs <参数>` ``，此时最后一个 token 是**参数**：
 *
 * - `` `batch-swap-docs.mjs --dry-run` `` → `basenameOf` 得 `--dry-run`
 * - `--dry-run` 不以 `.mjs` 结尾 ⇒ `isMjsMention` 为 false
 * - 又因它以 `-` 开头，`SCRIPT_STEM` 也不匹配 ⇒ **整个 token 不受任何检查**
 *
 * 后果不是误报，是**漏报**：2026-09-18 第八轮实测——`gate-standard.md` 里那句
 * "原含「→ `batch-swap-docs.mjs --dry-run`」一行"**真的躲过了本闸门**，
 * 而同一批里写成裸名的 5 处都被抓到了。**带参数的写法比裸名更常见，却更不被检查。**
 *
 * 修法：**优先取带 `.mjs` 的那个 token**，取不到才退回最后一个。
 * 这样两类写法都进检查，且不需要改动路径分支（那里确实需要"取最后一个"来剥 `node`）。
 */
const scriptTokenOf = (s) => {
  const toks = stripPrefix(s).trim().split(/\s+/).filter(Boolean)
  if (!toks.length) return ''
  const mjs = toks.find((t) => /\.mjs[,.;:）)】]*$/.test(t))
  const pick = mjs ?? toks[toks.length - 1]
  return pick.split(/[/\\]/).pop().replace(/[,.;:）)】]+$/, '')
}

for (const file of TARGETS) {
  const rel = file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '')
  // 契约 = 当下指令；skill = 战史兼手册（见上方"只对契约生效"的说明）
  const isContract = /^\.dsh\/contracts(-research)?\//.test(rel)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((ln, idx) => {
    const where = `${rel}:${idx + 1}`

    // ── 占位符 ──────────────────────────────────────────────────────────
    //
    // **两档判定，因为"没解析"有两种截然不同的成因**：
    //
    // - **顶层段都没声明** ⇒ FAIL。`{{foo.bar}}` 而 profile 里根本没有 `foo:`，
    //   那这个占位符**任何项目下都解析不了**，是契约写错了。
    // - **段声明了、子键缺** ⇒ WARN。这大多是**合法的条件分支**——
    //   `deploy-standard.md` 自己写着「`profile.yaml` 未声明 `deploy` 的项目，
    //   本契约整体不适用」，而 `{{deploy.arch}}` 就写在一个 Makefile 模板块里。
    //   判 FAIL 会把这类**声明了但整体不适用**的项目全部误杀。
    //
    // 为什么要加这一档（2026-09-18 第八轮核检 4 个消费项目时发现）：
    // 原判据只有 FAIL 一档，于是**只要 `paths:` 段存在，任何 `{{paths.随便什么}}` 都静默通过**。
    // 而消费项目最常缺的恰恰是 `paths:` 段内的子键（4 个项目里有 2 个连段都没有）。
    // 加 WARN 不改变 FAIL 语义，只是把"可能有问题"从**沉默**变成**发声**——
    // 这与 `basenameOf` 那个漏洞同一类：**判据比它要防的问题松，就等于没防**。
    for (const m of ln.matchAll(PLACEHOLDER)) {
      const key = m[1]
      const top = key.split('.')[0]
      if (!(key in profile)) {
        if (!(top in profile)) {
          failures.push(`${where}  {{${key}}} 在 profile.yaml 里解析不了（顶层段「${top}」也没有声明）`)
        } else if (!sectionInert(top) && !knownKeyGaps.has(key)) {
          knownKeyGaps.set(key, where)
          warnings.push(`${where}  {{${key}}} 未声明（「${top}」段已声明，可能是条件分支，也可能是漏项）`)
        }
      }
    }

    // ── 内联代码里的路径 ─────────────────────────────────────────────────
    for (const m of ln.matchAll(INLINE)) {
      let tok = m[1].trim()

      // 脚本名核对：**只对契约**（见上方说明）
      if (isContract) {
        const base = scriptTokenOf(tok)
        const bare = base.replace(/\.mjs$/, '')
        const isMjsMention = base.endsWith('.mjs')
        if (isMjsMention && !REAL_SCRIPTS.has(bare)) {
          failures.push(`${where}  \`${base}\` 不指向任何现存脚本（契约写了 .mjs，是明确的脚本引用）`)
        } else if (!isMjsMention && SCRIPT_STEM.test(base) && !REAL_SCRIPTS.has(base)) {
          // 裸名太容易与普通英文词/项目名/skill 名混淆，**只在同一行也提到真实脚本时**才提醒。
          // 这条共现启发式正是为 `gate-standard.md` 那句"度量类仅作诊断：`numeric-density` /
          // `value-retention` / …"设计的——同行有真实脚本，那么同行的裸名理应也是脚本名。
          //
          // **注意：判"同行有真实脚本"时，裸名也算**。第一版只认带 `.mjs` 的写法，
          // 而那句里全是裸名 ⇒ 共现条件永不成立 ⇒ 埋进去的幽灵引用**抓不到**（实测确认过）。
          // 一个永远通过的闸门比没有闸门更糟：它让人以为查过了。
          const lineMentionsReal = [...ln.matchAll(INLINE)].some((x) => {
            const b2 = scriptTokenOf(x[1]).replace(/\.mjs$/, '')
            return REAL_SCRIPTS.has(b2)
          })
          if (lineMentionsReal && !knownGhosts.has(base)) {
            knownGhosts.set(base, where)
            warnings.push(`${where}  \`${base}\` 不指向任何现存脚本（同行提到了真实脚本，它很可能也是脚本名）`)
          }
        }
      }
      if (basenameOf(tok).endsWith('.mjs')) continue

      tok = tok.replace(/^node\s+/, '').replace(/^(cd|cat|ls|pwsh|bash)\s+/, '').trim()
      tok = tok.split(/\s+/)[0]
      tok = tok.replace(/#.*$/, '') // 去掉 markdown 锚点：.md#D8 → .md
      if (!tok.startsWith('.dsh/')) continue
      if (NOT_A_PATH.test(tok)) continue
      tok = tok.replace(/[.,;:）)】]+$/, '')

      const abs = join(ROOT, tok)
      if (existsSync(abs)) continue
      if (WORK_DIRS.some((d) => tok === d || tok.startsWith(d + '/'))) continue
      if (isIntentional(tok)) continue
      failures.push(`${where}  \`${tok}\` 不存在——契约引用了交付件里没有的东西`)
    }

    // ── 来源基线的作用域 ─────────────────────────────────────────────────
    if (/^>\s*来源基线/.test(ln) && ln.includes('baseline/')) {
      if (!ln.includes('模式仓库')) {
        failures.push(`${where}  来源基线未标注"模式仓库"——消费项目会去找不存在的 baseline/`)
      }
    }
  })
}

// ── 不变量二：仓库根不得残留**模式资产** ───────────────────────────────────
//
// **2026-09-18 第八轮修订。原判据在消费项目里结构性不可能成立。**
//
// 原实现是"仓库根存在 `tools/` 或 `tests/` 目录 ⇒ FAIL"。它在本仓库（模式载体）
// 成立——那两个目录确实是早期放错位置的能力脚本与自检。但**本检查随 `.dsh/` 交付到每一个项目**，
// 而在**真实项目里**：`tools/` 是项目自己的工具（如 `ssh_remote.py`、`deploy/`），
// `tests/` 是项目自己的测试用例。**要让原判据通过，就得删掉项目真实的代码与用例。**
//
// teamcodingknowledge 与 HelpDocToolkit 两个项目实测都撞上这条：
// 前者根 `tests/` 有 6 项永久回归用例、根 `tools/` 有 18 项契约写域工具。
// **判据把"不适用"报成了"失败"，这正是本模式反复要治的那类病。**
//
// **修法：判据从"目录名"改为"目录内容"。** 残留的定义是
// "**模式的能力脚本/自检脚本**躺在仓库根"，而不是"仓库根有个叫 tools 的目录"。
// 只有当一个根目录里真的装着**本模式交付的那些脚本名**时，它才是错放的模式资产。
// 项目的 `ssh_remote.py`、`cases/` 不会命中，模式脚本的副本一定会命中。
//
// 这与 L18 原本就写明的自省一致：「**只管 `tools/` `tests/` 这两个"曾经放错位置的名字"**，
// 而不是"仓库根不许有任何目录"」——只是上一版把这个自省**实现成了它本想避免的样子**。
const MODE_ASSET_NAMES = new Set()
for (const d of ['.dsh/tools', '.dsh/tests']) {
  const abs = join(ROOT, d)
  if (!existsSync(abs)) continue
  for (const f of readdirSync(abs)) if (f.endsWith('.mjs')) MODE_ASSET_NAMES.add(f)
}
for (const d of ['tools', 'tests']) {
  const p = join(ROOT, d)
  if (!existsSync(p) || !statSync(p).isDirectory()) continue
  const hits = readdirSync(p).filter((e) => MODE_ASSET_NAMES.has(e))
  if (hits.length) {
    failures.push(
      `仓库根 ${d}/ 里有本模式的能力脚本（${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` 等 ${hits.length} 项` : ''}）` +
        '——交付单位是 .dsh/ + .env，模式资产应在其内',
    )
  }
}

// ── 不变量三：A/B/C 不得被当作**层内形态**的标签（2026-09-20 新增）────────────
//
// **这条是踩出来的，而且踩了两次。** A/B/C 在本模式里只应指三层部署架构
// （A 通用引擎 / B 入口预设 / C workspace = `.dsh/` + `.env`）。但设计稿早期有一处内部命名
// 把 C 层**内部**的 profile / contracts / skills 也叫 A/B/C，随交付件扩散到了
// `.dsh/README.md`、两份 `contracts/README.md`、`design-standard.md`、`design-doc-writing.md`
// 与两个预设，共 **23 处**。
//
// 危害不是洁癖：`.dsh/README.md` 说 `profile.yaml` 是「A 形态」，而按"只有 C 层随项目走"去读，
// 读者会怀疑 `profile.yaml` 算哪一层——**它明明在 `.dsh/` 里，当然是 C**。
//
// **为什么必须机器查**：两轮人工扫描都漏了同一处——搜的是 `A 形态` / `A profile`，
// 而这两份 README 用的是**表格单元格 `| **A** |` 与目录树注释 `# A：`**。人眼按措辞搜
// 必然漏掉"同一概念的另一种排版"。所以判据按**结构**写，不按措辞写。
//
// **判据必须精确，否则会误杀正确的那张表**：`.dsh/README.md` 新写的三层表里
// `| **A** | 通用引擎 | ...` 是**对的**。所以只认两种过载签名：
//   ① 字母单元格**紧跟一个 `.dsh/` 路径**：`| **A** | \`.dsh/profile.yaml\` |`（三层表的第二格是中文名，不会命中）
//   ② 目录树注释 `# A：` / `# B：` / `# C：`（带全角冒号，正常行文不会这样写）
const OVERLOAD = [
  { re: /\|\s*\*\*[ABC]\*\*\s*\|\s*`\.dsh\//, why: '表格里用 A/B/C 给 `.dsh/` 内的文件当形态标签' },
  { re: /#\s*[ABC]：/, why: '目录树注释里用 `# A：`/`# B：`/`# C：` 给层内资产当标签' },
]
// 注意：`TARGETS` 只覆盖 contracts / contracts-research / skills，**不含 `.dsh/README.md`**，
// 而它恰恰是这套记号的主叙述处（三层表就写在那里）。所以这里额外把它并进来。
const ABC_SCAN = [...TARGETS, join(ROOT, '.dsh/README.md')]
for (const abs of ABC_SCAN) {
  if (!existsSync(abs)) continue
  const rel = abs.slice(ROOT.length + 1).replaceAll('\\', '/')
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const { re, why } of OVERLOAD) {
      if (re.test(line)) {
        failures.push(
          `${rel}:${i + 1}  A/B/C 被当作**层内形态**标签（${why}）——` +
            'A/B/C 只指三层部署架构，层内三样称「技术骨架 / 角色契约 / skill」',
        )
      }
    }
  })
}

// ── 输出 ───────────────────────────────────────────────────────────────────
console.log(`[ref-integrity] ${ROOT}`)
console.log(`  受检文件 ${TARGETS.length} 份；profile 解析出 ${Object.keys(profile).length} 个键`)

if (notes.length) {
  console.log('\n  说明（非失败）：')
  for (const n of notes) console.log('    - ' + n)
}
if (warnings.length) {
  console.log(`\n  ⚠ WARN ${warnings.length} 处（不阻断；裸名可能是普通英文词，需人判断）：`)
  for (const w of warnings.slice(0, 20)) console.log('    ' + w)
}
if (failures.length) {
  console.log(`\n  ❌ FAIL ${failures.length} 处：`)
  for (const f of failures.slice(0, 60)) console.log('    ' + f)
  if (failures.length > 60) console.log(`    …另有 ${failures.length - 60} 处`)
  console.log('\n[ref-integrity] FAIL')
  process.exit(1)
}

console.log('\n[ref-integrity] PASS：无悬空输入引用，且交付自包含')
