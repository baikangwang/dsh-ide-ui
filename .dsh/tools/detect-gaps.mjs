// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/detect-gaps.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/detect-gaps.mjs。
// 副本生成时间：2026-09-20T09:07:20.327Z
/**
 * detect-gaps.mjs — B 类「结论缺失型」检测（零模型参与）
 *
 * 治的是清洗的**另一个极端**：文档被压缩到只剩结论，读者看不到依据——
 * 「简练到'没头没尾'结论……看了文档又感觉什么都没看到」。
 *
 * 判据来自 .dsh/contracts/architect/design-standard.md 的「结论三问」与 QA D8：
 *   ① 是什么  —— 结论本身（含置信度）
 *   ② 凭什么  —— 可核验的依据：命令、`文件:行号`、URL、代码块、探针编号、采样时刻
 *   ③ 为什么不选别的 —— 被排除的竞争性解释 + 一句排除理由（取舍理由）
 *
 * 本工具只**报告可疑段落**，不做判断也不改动文档。命中不等于有问题：
 * 一句话的过渡段、纯定义段不需要三问齐全。真正的判据是"读者能否据此下判断"。
 *
 * 用法：
 *   node tools/detect-gaps.mjs --project <路径> [--min-lines 3] [--out <报告>]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, relative } from 'node:path'

const NON_DESIGN_FILE_RE = /^(CHANGELOG|README|docs-map|INDEX)/i

/** 结论性表述的检出词（判断句，而非陈述事实的中性句） */
const CONCLUSION_RE = /(因此|所以|结论是|判定为|可以确定|已证实|已实证|确定为|应(?:当)?采用|建议采用|决定(?:采用|使用)|根因是|主因是|根本原因|最终方案|采用.{0,12}方案|定为|确认(?:为|是)|不再|禁止|必须|应改为|改为)/

/**
 * 外部归档原文的判定：这类文件是"我们归档的别人的原文"（如第三方安全报告的中译），
 * 不是架构师自己写的设计结论，**不得用结论三问去要求它**。
 * 证据：contracts 里"归档外部原文时逐字保真…但本条不适用于架构师自己撰写的设计文档正文"。
 */
const EXTERNAL_ARCHIVE_RE = /(anthropic-ai-misuse|misuse-report|evidence-compilation|外部|归档|译文|翻译)/i

/**
 * 边界/缺口/局限类段落：它们**的本来目的就是声明"还没有依据"**，
 * 报"结论无依据"是范畴错误。
 */
const BOUNDARY_HEADING_RE = /(边界|缺口|局限|未证实|未验证|不确定|待验证|风险|范围外|不适用|存疑|已知问题|限制)/

/**
 * 单节内至少出现这么多次结论词，才视作"该节在给结论"。
 * 只看 1 次命中会把"背景里带个『必须』"的叙述段误判成结论段——
 * 实测误报率过高（deepseek-websearch-config-audit 的「边界与缺口」节即此类）。
 */
const MIN_CONCLUSION_HITS = 2

/**
 * 依据的检出特征。
 * **关键修正**：证据不必与结论同段，所以光"整节有没有证据"判不准——
 * 实测同一节里"结论在开头、依据在下方的表格里"会被误报。
 * 真正可靠的信号是**结构**：有表格/列表/代码块/命令/文件行号的节，
 * 几乎都承载了依据；而**纯散文 + 下结论**才是"头重脚轻"的病灶。
 */
const EVIDENCE_PATTERNS = [
  { key: '表格', re: /^\s*\|/m },
  { key: '列表', re: /^\s*(?:[-*+]|\d+[.)])\s+\S/m },
  { key: '命令', re: /`[^`]*\b(grep|journalctl|docker|psql|curl|ssh|python3?|node|npm|pnpm|systemctl|cat|ls|ss|netstat|sha256sum|stat|find|awk|sed|git)\b[^`]*`/ },
  { key: '文件行号', re: /[\w./-]+\.(py|js|ts|tsx|json|ya?ml|md|sh|conf|ini|env|toml|sql|go|rs|java):\d+(-\d+)?/ },
  { key: 'URL', re: /https?:\/\/[^\s)\]>]+/ },
  { key: '代码块', re: /^```/m },
  { key: '探针编号', re: /\b(P|P-|P-\d|探针)\s*[-#]?\s*\d|[A-Z]-\d+[a-z]?\b/ },
  { key: '采样时刻', re: /\d{2,4}-\d{2}-\d{2}[ T]?\d{0,2}:?\d{0,2}|采样(?:于|时刻)|实测(?:于|时刻)|\+\d{4}/ },
  { key: '数值', re: /\b\d+(?:\.\d+)?\s*(?:%|ms|s|秒|分钟|小时|B|KB|MB|GB|次|行|条|个|台|端口)\b|\b\d{3,}\b/ }
]

/** 承载依据的强结构标记（出现任一即认为该节有可核验抓手） */
const STRUCTURE_KEYS = ['表格', '列表', '命令', '代码块']

/**
 * 规范/模板/契约类节：它们是"规则的陈述"，不是"我们下的设计结论"，
 * 不需要、也不应该要求它们贴证据。
 * 证据：把「每个结论必须答得出三问」判成"结论无依据"是范畴错误——
 * 那句话本身就是规则。
 */
const NORMATIVE_HEADING_RE = /(准则|规则|规范|契约|模板|写法|指南|标准|纪律|约定|禁令|红线|检查项|自查|定义|术语|纪律|应当|注意事项|处置建议|判据说明|使用说明|示例|样例)/

/** 模板占位（`（此处放…）`）不是结论 */
const PLACEHOLDER_RE = /^[（(]\s*此处|[（(]\s*待补|TODO|TBD|XXX/i


/** 排除理由的检出词（第三问） */
const ALTERNATIVE_RE = /(未选|不选|排除|不采用|否决|放弃|而非|而不是|对比(?:后|之下)|相较之下|权衡|取舍|另两个方案|备选|候选方案|其他方案|同行做法|业界做法|理由(?:是|：)|原因是)/

/** 不需要三问齐全的段落（结构件） */
const SKIP_HEADING_RE = /^#{1,6}\s*(目录|索引|术语|名词|缩略语|参考|附件|附录|变更台账|修订|版本|背景|范围|需求复述|目标)/
const BOILERPLATE_RE = /^(---|\|\s*[-:|\s]+\||\s*$)/
const SHORT_LINE_MAX = 60

function parseArgs(argv) {
  const a = { project: process.cwd(), minLines: 3, out: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') a.project = argv[++i]
    else if (argv[i] === '--min-lines') a.minLines = parseInt(argv[++i], 10)
    else if (argv[i] === '--out') a.out = argv[++i]
  }
  return a
}

function listDocs(docsDir) {
  if (!existsSync(docsDir)) return []
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
      else if (e.name.toLowerCase().endsWith('.md') && !NON_DESIGN_FILE_RE.test(e.name)) out.push(p)
    }
  }
  walk(docsDir)
  return out
}

/**
 * 读文档并归一化换行。
 * **必须归一化**：这批文档多为 CRLF，行尾的 `\r` 会让 `/^\s*\|/m` 这类
 * 行首正则失配——实测导致"明明有表格"被judged成"无依据"（482 §1.0 即此类）。
 */
function readDoc(p) {
  return readFileSync(p, 'utf8').replace(/\r\n?/g, '\n')
}

/** 把文档切成"节"，逐节判定 */
function splitSections(text) {
  const lines = text.split('\n')
  const sections = []
  let cur = { heading: '(文首)', startLine: 1, level: 0, lines: [] }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^#{2,4}\s/.test(l)) {
      sections.push(cur)
      const lv = (l.match(/^#+/) || [''])[0].length
      cur = { heading: l.replace(/^#+\s*/, ''), startLine: i + 1, level: lv, lines: [] }
    } else cur.lines.push({ no: i + 1, text: l })
  }
  sections.push(cur)
  return sections.filter((s) => s.lines.length > 0)
}

/**
 * 给每个节附上"子树范围"（自身 + 所有 level 更深的后续节），
 * 用于判定：结论本身没有就地依据，但**子节里有**——这不是缺陷。
 * 证据：482 §1.0「核心策略」被判"结论无依据"，实际依据就在紧邻的
 *      §1.1 表格里（`auth_db.py:260` 的函数行号清单）。
 */
function attachSubtree(sections) {
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]
    if (s.level === 0) { s.subtree = [s]; continue }
    const sub = [s]
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= s.level) break
      sub.push(sections[j])
    }
    s.subtree = sub
  }
  return sections
}

function analyseSection(sec) {
  const body = sec.lines.map((l) => l.text)
  const text = body.join('\n')

  // 结论词出现总次数（一个节里只说一次，多半是背景叙述而非在下结论）
  const conclHitCount = body.reduce((n, l) => n + (l.match(CONCLUSION_RE) || []).length, 0)
  const conclLines = sec.lines.filter((l) => CONCLUSION_RE.test(l.text))

  // 豁免：边界/缺口类段落（本来目的就是声明"还没有依据"）
  const isBoundary = BOUNDARY_HEADING_RE.test(sec.heading)
  // 豁免：规范/模板/指南类节（陈述规则，不是下设计结论）
  const isNormative = NORMATIVE_HEADING_RE.test(sec.heading)
  // 豁免：整节基本是模板占位
  const isPlaceholder = body.filter((l) => l.trim()).length > 0 &&
    body.filter((l) => PLACEHOLDER_RE.test(l.trim())).length / body.filter((l) => l.trim()).length > 0.5

  // 结构标记：表格/列表/命令/代码块 —— 承载依据的抓手
  const ev = []
  for (const p of EVIDENCE_PATTERNS) if (p.re.test(text)) ev.push(p.key)
  const strongStructure = ev.filter((k) => STRUCTURE_KEYS.includes(k))

  const hasAlternative = ALTERNATIVE_RE.test(text)

  // 子树（含子节）是否有可核验抓手——有则不算缺陷，结论的依据在下方子节里
  const subtreeText = (sec.subtree || [sec]).map((x) => x.lines.map((l) => l.text).join('\n')).join('\n')
  const childStructure = []
  for (const p of EVIDENCE_PATTERNS) {
    if (!STRUCTURE_KEYS.includes(p.key)) continue
    if (p.re.test(subtreeText) && !p.re.test(text)) childStructure.push(p.key)
  }

  // 只对"在下结论、且**本节**没有任何可核验抓手"的节报缺。
  // 实测 482 的 §1.0/§2.1/§3.1 标题下只有 1–2 行正文就下结论（依据在平级的下一节里），
  // 这**正是"简练到没头没尾"的病灶**，应当报出——门限因此按**非空内容行**算，
  // 而"结论与依据分开在不同节"这一点由 contentLines 如实呈现，供人判断是否可接受。
  const contentLines = body.filter((l) => l.trim()).length
  const substantive = contentLines >= 1 && !isBoundary && !isNormative && !isPlaceholder &&
    conclHitCount >= MIN_CONCLUSION_HITS && strongStructure.length === 0

  return {
    heading: sec.heading,
    startLine: sec.startLine,
    lineCount: contentLines,
    conclusionCount: conclHitCount,
    conclusionSamples: conclLines.slice(0, 2).map((l) => `L${l.no}: ${l.text.slice(0, 100)}`),
    evidence: ev,
    childStructure,
    hasAlternative,
    isBoundary,
    isNormative,
    // 标签如实描述检出的东西：**就地**没有可核验抓手，不是"结论是错的"
    problem: substantive ? '结论段无就地依据' : null,
    noAlternative: substantive && !hasAlternative &&
      conclLines.filter((l) => /(采用|方案|选|根因|主因)/.test(l.text)).length > 0 ? '未见取舍理由' : null,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const projectRoot = args.project
  const docs = listDocs(join(projectRoot, 'docs'))

  const findings = []
  const externalSkipped = []
  for (const d of docs) {
    const name = basename(d)
    // 外部归档原文不受结论三问约束（照抄别人的报告，不是我们的设计结论）
    if (EXTERNAL_ARCHIVE_RE.test(name)) { externalSkipped.push(name); continue }
    const text = readDoc(d)
    const secs = attachSubtree(splitSections(text))
    const bad = []
    for (const s of secs) {
      if (SKIP_HEADING_RE.test('## ' + s.heading)) continue
      const r = analyseSection(s)
      if (r.problem || r.noAlternative) bad.push(r)
    }
    if (bad.length) {
      findings.push({
        doc: name,
        path: relative(projectRoot, d).replace(/\\/g, '/'),
        sections: bad.length,
        noEvidence: bad.filter((b) => b.problem).length,
        noAlternative: bad.filter((b) => b.noAlternative).length,
        details: bad,
      })
    }
  }

  const totalNoEv = findings.reduce((s, f) => s + f.noEvidence, 0)
  const totalNoAlt = findings.reduce((s, f) => s + f.noAlternative, 0)

  console.log(`\n项目：${projectRoot}`)
  console.log(`扫描 ${docs.length} 份；检出可疑文档 ${findings.length} 份`)
  console.log(`  结论段无就地依据：${totalNoEv} 处`)
  console.log(`  结论未见取舍理由的节：${totalNoAlt} 处`)
  if (externalSkipped.length) {
    console.log(`  豁免（外部归档原文，不受结论三问约束）：${externalSkipped.length} 份`)
  }
  console.log('')
  console.log('可疑文档（按"结论无依据"节数降序）：')
  console.log('  ' + '文档'.padEnd(52) + '无依据'.padStart(7) + '无取舍'.padStart(7))
  for (const f of findings.sort((a, b) => b.noEvidence - a.noEvidence).slice(0, 30)) {
    console.log('  ' + f.doc.padEnd(52).slice(0, 52) + String(f.noEvidence).padStart(7) + String(f.noAlternative).padStart(7))
  }

  const md = []
  md.push('# B 类「结论缺失型」检测报告')
  md.push('')
  md.push(`> 项目：\`${projectRoot}\``)
  md.push(`> 生成时间：${new Date().toISOString()}`)
  md.push(`> 判据：\`design-standard.md\`「结论三问」（是什么 / 凭什么 / 为什么不选别的）、QA D8`)
  md.push('>')
  md.push(`> **命中不等于有问题。** 本工具只标出"出现了结论性表述、但该节没有任何可核验依据"的段落。`)
  md.push(`> 一句话的过渡段、纯定义段不需要三问齐全；真正的判据是**读者能否据此下判断**。`)
  md.push('')
  md.push(`## 总览`)
  md.push('')
  md.push(`| 项 | 值 |`)
  md.push(`|---|---|`)
  md.push(`| 扫描文档 | ${docs.length} |`)
  md.push(`| 检出可疑文档 | ${findings.length} |`)
  md.push(`| **结论段无就地依据** | ${totalNoEv} |`)
  md.push(`| 结论未见取舍理由的节 | ${totalNoAlt} |`)
  if (externalSkipped.length) md.push(`| 豁免（外部归档原文） | ${externalSkipped.length} |`)
  md.push('')
  md.push(`## 判据标定说明（这条很重要，避免误用）`)
  md.push('')
  md.push(`初版判据误报率过高（把外部归档报告、规范文本、边界声明全判成"无依据"），已按实测收紧四处：`)
  md.push('')
  md.push(`1. **单节内结论词至少出现 ${MIN_CONCLUSION_HITS} 次**才算"该节在下结论"。只看 1 次会把"背景里带了句『必须』"的叙述段误判。`)
  md.push(`2. **边界/缺口/局限类段落豁免**：它们的本来目的就是声明"还没有依据"，报"结论无依据"属范畴错误。`)
  md.push(`3. **规范/模板/指南类节豁免**：它们陈述的是**规则**（如「每个结论必须答得出三问」），规则本身不需要贴证据。`)
  md.push(`4. **外部归档原文豁免**：照抄别人的报告不受结论三问约束——三问只约束**架构师自己撰写的设计结论**。`)
  md.push('')
  md.push(`**本工具查的是「结论与依据的就近程度」，不是「结论是否正确」。**`)
  md.push(`「行数」列是**非空内容行**。若某节只有 1–2 行正文就下结论、依据在平级的下一节里，`)
  md.push(`工具会报出——这不是误报，而正是「简练到没头没尾」的形态，需人判断该节是否本该自带依据。`)
  if (externalSkipped.length) {
    md.push('')
    md.push(`本轮豁免的外部归档原文：${externalSkipped.map((x) => '`' + x + '`').join('、')}`)
  }
  md.push('')
  md.push(`## 明细`)
  md.push('')
  for (const f of findings.sort((a, b) => b.noEvidence - a.noEvidence)) {
    md.push(`### ${f.doc}`)
    md.push('')
    md.push(`\`${f.path}\` —— 无依据 ${f.noEvidence} 节 / 无取舍 ${f.noAlternative} 节`)
    md.push('')
    md.push(`| 节 | 起始行 | 行数 | 检出问题 | 结论样例 |`)
    md.push(`|---|---:|---:|---|---|`)
    for (const b of f.details) {
      const probs = [b.problem, b.noAlternative].filter(Boolean).join('、')
      md.push(`| ${b.heading.slice(0, 40).replace(/\|/g, '/')} | ${b.startLine} | ${b.lineCount} | ${probs} | ${(b.conclusionSamples[0] || '').replace(/\|/g, '/').slice(0, 70)} |`)
    }
    md.push('')
  }
  md.push(`## 处置建议`)
  md.push('')
  md.push(`1. 「结论无依据」：补上①可复跑的命令 或 ②\`文件:行号\` 或 ③探针编号 + 采样时刻。**不得因"文档太长"而删结论，也不得为凑依据而堆过程。**`)
  md.push(`2. 「未见取舍理由」：补一句"还排除了什么 + 为什么排除"。这一句往往比结论本身更有决策价值。`)
  md.push(`3. 补完后按 9 节结构复核，并跑 \`verify-rewrite.mjs\` 确认净增长有据（新增结论必须有理由，见 \`design-standard.md\` 对"净增长 ≤ 0"的例外说明）。`)

  const out = args.out || join(projectRoot, '.dsh', 'tmp', 'cleanup', 'gaps-report.md')
  mkdirSync(join(projectRoot, '.dsh', 'tmp', 'cleanup'), { recursive: true })
  writeFileSync(out, md.join('\n'), 'utf8')
  console.log(`\n报告已落盘：${out}\n`)
  return 0
}

process.exit(main())
