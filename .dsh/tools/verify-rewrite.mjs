#!/usr/bin/env node
/**
 * verify-rewrite.mjs — 清洗/重写产物的零丢失校验器（零模型参与）
 *
 * 用途：清洗或整体重写之后，机器化核对"设计信息有没有丢"。
 * 它**只报告差异，不判断对错** —— 报告出来的每一条由人或 QA 裁决。
 *
 * 校验维度：
 *   1. 体量对比（行数 / 字节，是否满足净增长 ≤ 0）
 *   2. 设计标识符留存（D-xxx-n / Qn / #n / CL-n / PX-nn / R-xxx-n / P-xxx-n / A-n）
 *   3. 数字指纹留存（SHA256 前缀、inode、长度、计数、百分比、耗时、端口…）
 *   4. 修订痕迹检出（D10：重写产物应为 0；若重写产物里还剩痕迹 = FAIL）
 *   5. 结构核对（9 节是否齐全）
 *   6. 超长行（D12 复核信号）
 *
 * 用法：
 *   node tools/verify-rewrite.mjs --original <原文件> --rewrite <重写文件>
 *   node tools/verify-rewrite.mjs --original A --rewrite B --out <报告目录>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

/**
 * D10 修订痕迹的检出式与全部误报排除规则，已抽到 `lib-traces.mjs`
 * （唯一定义处，避免各工具各说各话）。
 */
import { isTraceLine, SELF_REVISION_HEADING_RE, SELF_REVISION_LABEL_RE } from './lib-traces.mjs'
// 行数必须走唯一定义处（契约「行数口径」：任何工具要行数必须 import 它，不得自行实现）。
// 2026-09-20 修：此前用 `t.split('\n').length`，对末尾有换行的文件**多算 1 段**，
// 与 lib-lines 的 167 vs 168 分歧即源于此。
import { countLines } from './lib-lines.mjs'

/**
 * QA 核对/回环类行的识别。
 * 清洗会**整节删除**「QA 设计检查回环响应表」「修订记录」等章节——560 的试点已确立这一做法，
 * 因为这些表记录的是"哪个轮次查出了什么"，属过程信息。
 *
 * 但它带来一个**判据缺陷**：拿"含 QA 表的原稿"比"不含 QA 表的重写稿"，
 * 会把**正确删除的 QA 表内容报成丢失**。实测 sangfor 调研报告：
 * 报出 44 个百分比"丢失"，逐条查上下文全是 `QA·F-3`、`验证·V1` 这类核对表行。
 *
 * 因此本工具同时给出**"剥离 QA 痕迹后的设计正文"比对视图**：
 * 判别真丢失时以正文视图为准；QA 视图的差异默认视为可解释。
 */
const QA_TABLE_ROW_RE = /^\s*\|\s*(?:QA|验证|复核|评审|审计|回环|轮次)\s*[·・:：]?\s*[A-Za-z]?[-–]?\d*|^\s*\|[^|]*\bQA\s*[·・:：]\s*[A-Z]/i
const QA_SECTION_HEAD_RE = /^#{2,4}\s*[^\n|]{0,80}(QA|回环|复核|评审与修订|验证专家|审计)[^\n|]{0,60}$/
const AUDIT_NARRATIVE_RE = /(QA\s*的\s*[FN R]\d|上一轮|本轮|回环第\s*\d|检查方误判|已修正|不采纳|就地注记|原句保留|逐字保留|v\d+\.\d+\s*(?:新增|修订|更正|更新))/

/**
 * 剥离 QA/回环类章节与核对表行，得到"设计正文"。
 * 只用于**比对视图**，不改变原始体的任何判据。
 */
function stripProcessSections(text) {
  const lines = text.split('\n')
  const out = []
  let skipLevel = 0
  for (const l of lines) {
    const m = l.match(/^(#{2,4})\s/)
    if (m) {
      const lv = m[1].length
      if (skipLevel && lv <= skipLevel) skipLevel = 0
      if (!skipLevel && QA_SECTION_HEAD_RE.test(l)) { skipLevel = lv; continue }
      if (skipLevel) continue
      out.push(l)
      continue
    }
    if (skipLevel) continue
    if (QA_TABLE_ROW_RE.test(l)) continue
    out.push(l)
  }
  // 再逐行剔除纯审计叙述行
  return out.filter((l) => !AUDIT_NARRATIVE_RE.test(l)).join('\n')
}


/** 设计标识符族：前缀 + 可选章节 + 编号 */
const ID_FAMILIES = [
  { name: '决策记录 D-', re: /\bD-[A-Za-z]*-?\d+(?:-[a-z0-9]+)?/g },
  { name: '待决事项 Q', re: /\bQ\d{1,3}\b/g },
  { name: '实施清单 #', re: /(?<![\w#])#\d{1,3}[a-z]?(?![\w])/g },
  { name: '清理项 CL-', re: /\bCL-\d+[a-z]?\b/g },
  { name: '代理登记 PX-', re: /\bPX-\d{2}\b/g },
  { name: '风险 R-', re: /\bR-\d{3}-\d+\b/g },
  { name: '探针 P-', re: /\bP-\d{3}-\w+\b/g },
  { name: '动作 A-1', re: /\bA-1[a-d]\b/g },
  { name: '结论项 N-', re: /\bN-\d\b/g },
]

/**
 * 数字指纹：要能核验，就必须逐字相同。
 * 定义已抽到 `lib-numfingerprint.mjs`（唯一定义处，避免规则漂移）。
 */
import { NUM_PATTERNS, normNumKey, extractNumerics, missingNumerics } from './lib-numfingerprint.mjs'

const SECTION_HEADS = [
  '需求复述', '关键结论', '范围', '方案设计|系统.*设计', '可行性', '可维护性|性能',
  '附加|数据库|接口', '决策记录', '实施清单',
]

/**
 * 读文件。
 * **必须归一化换行**：本仓库的存量原稿多为纯 CRLF，而重写/规范化稿为纯 LF。
 * 若不归一化：① 行尾的 `\r` 会让 `/^\s*\|/`、`/^#{2,4}\s/` 这类行首正则失配
 * （表格行被当普通行，第 5 节结构核对会误判）；② "体量对比"会把换行符变化
 * 算成内容减少——实测 482 原稿 743 行纯 CRLF，未归一化时虚报 743 字节"缩减"。
 */
// 统计某个数字指纹值在文本里出现了几次（用于区分"真丢失"与"正确去重"）。
//
// 用**精确字面计数**，不用正则：正则版会因词边界/千位分隔符而数错
// （实测：值 "70%" 配正则 /\d[\d,.]*\s*%?/g 在中文文本里数出 0 次，
//   不是 70 丢失，而是我的计数器坏了）。字面 indexOf 不可能数错，也不需要维护正则。
function numCountIn(text, value) {
  let n = 0
  let i = 0
  while ((i = text.indexOf(value, i)) !== -1) { n++; i += value.length }
  return n
}

function readLines(p) {
  const raw = readFileSync(p, 'utf8')
  const t = raw.replace(/\r\n?/g, '\n')
  return {
    text: t,
    lines: t.split('\n'),   // 仅供逐行遍历；**行数一律用 lineCount**
    lineCount: countLines(t),
    bytes: Buffer.byteLength(raw, 'utf8'),
    // contentBytes：统一换行符**之后**的体量。仍含 '\n'，所以行数变化会渗进这个数里。
    contentBytes: Buffer.byteLength(t, 'utf8'),
    // contentChars：**真正剔除全部换行符**的内容体量（单位是 **UTF-8 字节**，不是"字符个数"）。
    //   判据用这个数。历史字段名保留 contentChars 以防下游脚本失效，但所有**输出**都已改标为
    //   「内容体量」并注明单位——见下方 2026-09-17 的第二个教训。
    //
    // 为什么要加这个数（实测教训一，2026-09-17，来自 447）：
    //   contentBytes 的注释写的是"剔除换行符差异"，但实现只把 CRLF 归一成 LF，'\n' 仍在。
    //   后果是**行数变化被计入"内容增长"**——447 原稿 6,787 = 真内容 6,640 + 147 个 '\n'。
    //   而"重排结构"（加表格、长行折行）恰恰最会改行数，于是这类正当改造被判成"变长了"。
    //   两个数一起报，让 reader 自己看是内容涨了还是只是行多了。
    //
    // 教训二（2026-09-17，来自 504 与 0.1.15 两位架构师同时报错）：
    //   字段名叫 contentChars，于是被读成"字符个数"。中文 UTF-8 下 1 个汉字 = 3 字节，
    //   同一份 504 出现三个都能自圆其说的数：工具 63,513（本字段，字节）/ 架构师 44,379
    //   （UTF-16 码元 .length）/ 派发单 41,368（去换行的 .length，口径又差一层换行）。
    //   三个数**缩减比例几乎一致**，所以结论方向从没受影响；但汇报里并排出现三个"内容字符"
    //   会让人怀疑工具算错。
    //   **处置：不改口径，改标名。** 口径本身是对的（字节数不受编码歧义影响，且"删排版不删内容"
    //   正是判据要的东西）；把输出里的「内容字符」一律改为「内容体量（去换行的 UTF-8 字节）」。
    //   同时派发单里的体量一律只给「行数 + 文件字节」，不再给"内容字符"——避免第三个口径。
    contentChars: Buffer.byteLength(t.replace(/\n/g, ''), 'utf8'),
    // ⚠️ 原式 `raw.replace(/\r\n/g,'\n') === raw` 对**任何含 CRLF 的文件恒为 false**
    //    （把 `\r\n` 换成 `\n` 之后必然 ≠ 原文），于是**纯 CRLF 文档全被误报成"混合"**。
    //    正确判定：以"不含 `\r`"定 CRLF，以"不含 `\n` 单独出现"定 LF，两者都有才是混合。
    //    此列**不进任何判据**（只污染展示与 `eolChanged`），但假报会误导人以为换行被改坏了。
    eolStyle: (() => {
      const hasCRLF = /\r\n/.test(raw)
      const loneLF = /(^|[^\r])\n/.test(raw)
      const loneCR = /\r(?!\n)/.test(raw)
      if (hasCRLF && !loneLF && !loneCR) return 'CRLF'
      if (!hasCRLF && !loneCR && /\n/.test(raw)) return 'LF'
      if (!hasCRLF && !loneLF && loneCR) return 'CR'
      return '混合'
    })(),
  }
}

function collect(re, text) {
  const set = new Map()
  const m = text.match(re) || []
  for (const x of m) set.set(x.trim(), (set.get(x.trim()) || 0) + 1)
  return set
}

function normNum(s) { return s.replace(/\s+/g, ' ').trim() }

/**
 * 按章节提取"编号定义行"：找出 /^\s*(?:\|\s*)?(编号)\s*(?:\||：|:)/ 形态的行。
 * 用来区分**真缺失**（表里少了一行）与**分割伪影**（正则从 "docs/552" 里抓出 "D-2"）。
 */
function extractDefinedIds(lines, ids) {
  const found = new Map()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!isTableOrDefRow(l)) continue
    for (const id of ids) {
      if (found.has(id)) continue
      // 编号必须出现在行的开头位置附近（表格首格 / 行首），而不是行中间
      const head = l.slice(0, 60)
      const re = new RegExp('(^|[|\\s`*])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[|\\s`*（(：:,，])')
      if (re.test(head)) found.set(id, { line: i + 1, text: l.slice(0, 110) })
    }
  }
  return found
}

function isTableOrDefRow(l) {
  return /^\s*\|/.test(l) || /^\s*[-*\d.]+\s*\*{0,2}[A-Z#]/.test(l) || /^\s*#?\d+[a-z]?\s*[.、|]/.test(l)
}

function main() {
  const a = {}
  const argv = process.argv.slice(2)
  const MOVED_OUT = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--original') a.original = argv[++i]
    else if (argv[i] === '--rewrite') a.rewrite = argv[++i]
    else if (argv[i] === '--out') a.out = argv[++i]
    // `--moved-out`：被"移出"而非删除的节（如 `## 实施记录`、尾部评审记录）。
    // **判据 ①c 会扣除它里面的出现次数**——"搬家不是丢失"在**次数**上同样成立。
    else if (argv[i] === '--moved-out') MOVED_OUT.push(argv[++i])
  }
  if (!a.original || !a.rewrite) {
    console.error('用法: node tools/verify-rewrite.mjs --original <原文件> --rewrite <重写文件> [--out <目录>] [--moved-out <移出件>]...')
    process.exit(1)
  }
  for (const p of [a.original, a.rewrite]) {
    if (!existsSync(p)) { console.error(`文件不存在：${p}`); process.exit(1) }
  }

  const O = readLines(a.original)
  const R = readLines(a.rewrite)

  // ---- 1. 体量 ----
  // 判据用 **contentChars**（真正剔除全部换行符）：
  //  - 原稿 CRLF、重写稿 LF 时，直接用原始字节会把"换行符变短"误算成内容缩减；
  //  - 更关键的是，用 contentBytes（仍含 '\n'）会把**行数变化**当成内容变化，
  //    而重排结构（加表格、折行）正是本轮改造的正当动作。详见 readLines 的注释。
  const size = {
    original: { lines: O.lineCount, bytes: O.bytes, contentBytes: O.contentBytes, contentChars: O.contentChars, eol: O.eolStyle },
    rewrite: { lines: R.lineCount, bytes: R.bytes, contentBytes: R.contentBytes, contentChars: R.contentChars, eol: R.eolStyle },
    deltaLines: R.lineCount - O.lineCount,
    deltaBytes: R.bytes - O.bytes,
    deltaContentBytes: R.contentBytes - O.contentBytes,
    deltaContentChars: R.contentChars - O.contentChars,
    eolChanged: O.eolStyle !== R.eolStyle,
    // 判据：**只看内容字符数**。
    //
    // 为什么不再把行数并进判据（实测教训，来自 545）：
    //   545 把 `### 3.8` 从 §六/§七 之间搬回 §三，并按标准 9 节重排、补齐 §一/§二，
    //   内容字符 53,808 → 53,166（−1.2%，真的变短了），但行数 349 → 351，于是被判"变长"。
    //   **重排结构必然改行数**——把长行折成表格、给新章节加标题，都是本轮该做的事。
    //   行数放在判据里，等于禁止重排。故拆成两个独立信号：内容看 netGrowthOk，行数看 lineGrowth。
    netGrowthOk: (R.contentChars - O.contentChars) <= 0,
    lineGrowth: R.lineCount - O.lineCount,
  }

  // ---- 2. 设计标识符 ----
  const idReport = []
  for (const fam of ID_FAMILIES) {
    const o = collect(fam.re, O.text)
    const r = collect(fam.re, R.text)
    const missing = [...o.keys()].filter((k) => !r.has(k))
    const added = [...r.keys()].filter((k) => !o.has(k))
    idReport.push({
      family: fam.name,
      originalCount: o.size, rewriteCount: r.size,
      missing: missing.sort(), added: added.sort(),
    })
  }

  // ---- 2b. 真缺失判定（按编号定义行） ----
  const definedReport = []
  for (const r of idReport) {
    if (!r.missing.length) continue
    const oDef = extractDefinedIds(O.lines, r.missing)
    const rDef = extractDefinedIds(R.lines, r.missing)
    const realMissing = r.missing.filter((id) => oDef.has(id) && !rDef.has(id))
    const artifacts = r.missing.filter((id) => !oDef.has(id))
    const definedBoth = r.missing.filter((id) => oDef.has(id) && rDef.has(id))
    definedReport.push({ family: r.family, realMissing, artifacts, definedBoth,
                         realMissingDetail: realMissing.map((id) => ({ id, original: oDef.get(id) })) })
  }

  // ---- 3. 数字指纹 ----
  const numReport = []
  for (const np of NUM_PATTERNS) {
    const o = collect(np.re, O.text)
    const r = collect(np.re, R.text)
    // 归一化对照：忽略"数字与单位之间的空格差异"，避免格式重排造成的假缺失
    const rNorm = new Set([...r.keys()].map(normNumKey))
    const missing = [...o.keys()].filter((k) => !r.has(k) && !rNorm.has(normNumKey(k)))
    // **区分"真丢失"与"正确去重"**（实测教训，来自 404）：
    //   404 原稿把「评审准备时间缩短70%」写了两遍（L453 概览表 + L1068 实施清单），
    //   清洗后只留一处——这是 D9 要求的正确去重，却被报成"数值缺失 1"。
    //   判据：该数值在**原稿里出现 ≥2 次**、而在重写稿里 ≥1 次 → 是去重，不是丢失。
    //   反之原稿只出现 1 次却没了 → 才是真丢失。
    //   两者处置完全相反（去重正确；丢失必须补回），必须分开报。
    const reduced = []
    const realMissing = []
    for (const k of missing) {
      const oTimes = numCountIn(O.text, k)
      const rTimes = numCountIn(R.text, k)
      if (oTimes >= 2 && rTimes >= 1) reduced.push({ value: k, originalTimes: oTimes, rewriteTimes: rTimes })
      else realMissing.push(k)
    }
    numReport.push({
      family: np.name,
      originalCount: o.size, rewriteCount: r.size,
      missingCount: realMissing.length,
      missing: realMissing.sort().slice(0, 40),
      reducedCount: reduced.length,
      reduced: reduced.slice(0, 40),
    })
  }

  // ---- 3b. 设计正文视图（剥离 QA/回环痕迹后重算）----
  // 清洗会整节删掉 QA 回环响应表，拿含该表的原稿比对会把它报成"丢失"。
  // 正文视图只回答一个更准确的问题：**设计内容里有没有数字真的没了**。
  const oBody = stripProcessSections(O.text)
  const rBody = stripProcessSections(R.text)
  const bodyNumReport = []
  for (const np of NUM_PATTERNS) {
    const o = collect(np.re, oBody)
    const r = collect(np.re, rBody)
    const rNorm = new Set([...r.keys()].map(normNumKey))
    const missing = [...o.keys()].filter((k) => !r.has(k) && !rNorm.has(normNumKey(k)))
    // 同第 3 节，但**判定"是否真的没了"必须回查全稿**：
    //   正文视图是在"剥离过程章节后"的语料上算的，而原稿与重写稿被剥掉的内容**不一样**
    //   （原稿有 QA 表、重写稿没有），两份"正文语料"并非同一批文本。
    //   实测 404：`70%` 在重写稿里确实还在（全量视图 12→12 命中），
    //   但 `stripProcessSections` 剥掉了它所在的那一行，于是正文视图报"缺失 1"——是假警报。
    //   规则：正文视图报某值不在，若该值在**重写稿全稿**里仍在 → 不是丢失，只是不在设计正文范围内。
    //   只有全稿也找不到，才算真丢失。
    const gone = []
    const outOfScope = []
    for (const k of missing) {
      if (r.has(k) || numCountIn(R.text, k) >= 1) {
        outOfScope.push({ value: k, originalTimes: numCountIn(O.text, k), rewriteTimes: numCountIn(R.text, k) })
      } else {
        gone.push(k)
      }
    }
    bodyNumReport.push({
      family: np.name,
      originalCount: o.size, rewriteCount: r.size,
      missingCount: gone.length,
      missing: gone.sort().slice(0, 40),
      outOfScopeCount: outOfScope.length,
      outOfScope: outOfScope.slice(0, 40),
    })
  }
  const bodyNumMissingTotal = bodyNumReport.reduce((s, r) => s + r.missingCount, 0)
  const rawNumMissingTotal = numReport.reduce((s, r) => s + r.missingCount, 0)
  const reducedTotal = numReport.reduce((s, r) => s + (r.reducedCount || 0), 0)

  // ---- 3b. 判据 ①c：**同一数值的出现次数减少** ----
  //
  // 🔴 **为什么必须有这一节（本会话已确认的真实事故）**：
  //   Sangfor 旗舰调研稿把 `76.26%` 写成 `71.52%`（原稿 0 次），
  //   **同时**把 `76.26%` 从 **3 处降到 2 处**。
  //   当时全部工具的输出是 `missing: 1` ——**"凭空多 1"掩盖了"减少 1"**。
  //
  //   上面那个 `reduced` 数组**看起来正好管这件事**，其实只覆盖 `rTimes === 0`
  //   （值彻底消失）的情形；`for (const k of missing)` 的 `missing` 本身
  //   就是"值不存在了"的集合，所以 **`3→2` 这种"还在、但少了"根本不进循环**。
  //
  // **教训的对称性**：
  //   - 只查缺失的工具 ⇒ 把「**编造**」伪装成「**遗漏**」（已由 3c/3d 补上）；
  //   - 只问"值还在不在"的工具 ⇒ 把「**次数减少**」伪装成「**完整**」（本节）。
  //
  // **必须与"搬家不是丢失"对称**：先扣除移出件里的出现次数，
  // 否则每份文档都会因为"删掉尾部评审记录"而误报一片。
  // 移出件由 `--moved-out <文件>`（可多次）给定。
  const reducedOccurrences = []
  {
    const O2 = extractNumerics(O.text)
    const R2 = extractNumerics(R.text)
    let movedText = ''
    for (const p of MOVED_OUT) { try { movedText += readFileSync(p, 'utf8') } catch { /* 缺文件不致命，只是更保守 */ } }
    const M2 = movedText ? extractNumerics(movedText) : null
    for (const [key, b] of O2) {
      const aCount = R2.has(key) ? R2.get(key).count : 0
      const mCount = M2 && M2.has(key) ? M2.get(key).count : 0
      const to = aCount + mCount
      if (to < b.count) {
        reducedOccurrences.push({ value: b.raw, family: b.family, from: b.count, to, inRewrite: aCount, inMoved: mCount })
      }
    }
    reducedOccurrences.sort((x, y) => (y.from - y.to) - (x.from - x.to) || x.family.localeCompare(y.family))
  }

  // ---- 3c. 反向数值指纹：改后稿里凭空多出来的数值 ----
  //
  // **为什么必须有这一节**：前面所有数值检查都只查"原稿有、改后没了"。
  // 2026-09-17 的 sangfor 报告暴露了这个盲区——那版把原稿的 76.26% 写成了 **71.52%**（原稿里出现 0 次），
  // 同时把 76.26% 从 3 处降到 2 处、把带该数的逐字摘录整行删掉。
  // 缺的那一处被"设计正文缺失=0"掩盖（因为它报的是**减少**），而**编造出来的那个数以任何方式都检不出来**。
  //
  // 判据是**单向**的、故意保守：只在**改后稿有、原稿没有**时报。
  // 它必然有假阳性（重算出的新值、格式化差异、日期推进），所以：
  //   - **只列出、不判失败**——它是给"通读查多了"用的线索清单，不是闸门。
  //   - 跳过**版本号族**与**时间/耗时族**：改后稿写新的评审日期、新的耗时是正常的。
  //   - 跳过纯计数（1、2、3…）这类几乎必然出现的短数。
  const novelNumerics = []
  {
    // 跳过"版本区间/计数"族：它抓的是 `#3` 这类编号与 x.y.z 版本串，不是设计判据，
    // 且新增编号是重排的正常结果（557 实测就被它刷屏）。
    const SKIP_FAMILIES = new Set(['版本区间/计数'])
    const before = extractNumerics(O.text)
    const after = extractNumerics(R.text)
    for (const [key, info] of after) {
      if (before.has(key)) continue
      if (SKIP_FAMILIES.has(info.family)) continue
      const raw = info.raw
      const digits = raw.replace(/[^\d]/g, '')
      // 太短的整数几乎必然假阳（1、2、3…），跳过；带小数/单位/百分号的保留
      if (digits.length <= 2 && !/[.%]/.test(raw)) continue
      novelNumerics.push({ value: raw, family: info.family, key })
    }
    // 百分比族在上面按同一逻辑处理，无需另开分支——`71.52%` 会以 "百分比" 族落入。
    novelNumerics.sort((a, b) => a.family.localeCompare(b.family) || a.value.localeCompare(b.value))
  }

  // ---- 3d. 反向标识指纹：改后稿里凭空多出来的**带编号标识**与**被引用文件名** ----
  //
  // **为什么必须有这一节**：3c 只覆盖了**数值**这一个族。而标识判据（判据⑤ 等）
  // **全部是单向的**——只查"原稿有、产物无"。**反向完全没人查**，于是
  // **凭空编造的标识符可以静默通过全部判据**。
  //
  // 这与 3c 的动机是同一个，只是换了族：
  //   3c 之前，"编造一个数值"检不出来（`76.26%` → `71.52%`，且"缺 1 个"掩盖了"编造 1 个"）；
  //   现在，"编造一个 `D7`/`OBS-12`/文件名"同样检不出来，而且**更容易**——
  //   因为标识符看起来就像"从别处搬来的"，不像数值那样引人核对。
  //
  // 判据同样**单向且保守**：只报**改后稿有、原稿没有**的标识。
  // **只列出、不判失败**——它是给"通读查多了"用的线索清单，不是闸门。
  // 已知假阳性来源（都保留在列表里供人判）：
  //   - 节号重排产生的新编号（`### 10.1` → `### 4.5`）；
  //   - 新增章节自带的示例标识（`## 零-乙` 里的 `D1`…`Dn` 举例）；
  //   - 原稿用裸名、产物补全为 `文件:行号`（这是**改进**不是编造）。
  const novelIdentifiers = []
  {
    // 带编号标识的族（与判据⑤ 同一套前缀）
    const ID_RE = /\b(?:D|OBS|F|E-[A-Z]+|T|RV|ADR|P-[A-Z]+|W|DOC|RC|CL|G|Q)-\d+\b|\bD\d+\b|\bG\d+\b|\bQ\d+\b|\bW\d+\b/g
    // 反引号包裹的文件名（含可选 `:行号`）
    const FILE_RE = /`([A-Za-z0-9_./\\-]+\.(?:md|py|js|mjs|cjs|ts|tsx|svelte|json|ya?ml|toml|sh|ps1|sql|css|html))(:\d+(?:-\d+)?)?`/g
    const grab = (t) => {
      const s = new Set()
      for (const m of t.matchAll(ID_RE)) s.add(m[0])
      for (const m of t.matchAll(FILE_RE)) s.add(m[1] + (m[2] || ''))
      return s
    }
    const before = grab(O.text)
    const after = grab(R.text)
    for (const v of after) {
      if (before.has(v)) continue
      // 裸文件名（无行号）若原稿出现过同名文件（带别的行号），不算编造——行号更新是合法的
      const bare = v.replace(/:\d+(-\d+)?$/, '')
      if (before.has(bare)) continue
      novelIdentifiers.push(v)
    }
    novelIdentifiers.sort()
  }

  // ---- 4c. 判据⑫：新增章节不得夹带新数值/新标识 ----
  //
  // **为什么单列这一节**：`## 零-甲、需求复述` 与 `## 零-乙、关键结论` 是架构师**自己写的新节**，
  // 是全书**最像"作者的话"、最容易夹带**的地方。而它们夹带的东西
  // **在后面所有节里都找不到对照**（因为后面根本没有）——**除了 3c 之外没有任何判据会发现**。
  //
  // **实证**（`534`）：第一版 3c 报出 **2 处凭空数值**，都是新节里写的、原稿没有的：
  //   - `判据化为 §4.5 的 17 条用例`  ← 原稿是 `17 用例`（**同值异形现场复现**）
  //   - `风险登记（2 项，均不阻塞）`  ← 原稿风险表 3 行，**没有"2 项"这个计数**（凭空造计数）
  //
  // **判据**：`零-甲`/`零-乙` 里出现的每个数值指纹与带编号标识，
  // **必须在原稿中有同形的一处**。**只报告**（复述本就会重述正文里的数）。
  const addedSectionNovel = []
  {
    // 定位新节范围（`## 零-甲` 到下一个 `## ` 为止）
    const scopeOf = (label) => {
      const s = R.lines.findIndex((l) => new RegExp(`^##\\s*${label}`).test(l))
      if (s < 0) return null
      let e = R.lines.findIndex((l, i) => i > s && /^##\s/.test(l))
      if (e < 0) e = R.lines.length
      return R.lines.slice(s, e).join('\n')
    }
    const addText = [scopeOf('零-甲'), scopeOf('零-乙')].filter(Boolean).join('\n')
    if (addText) {
      const ID_RE = /\b(?:OBS|F|E-[A-Z]+|T|RV|ADR|P-[A-Z]+|DOC|RC|CL)-\d+\b|\bD\d+\b|\bG\d+\b|\bQ\d+\b|\bW\d+\b/g
      const beforeIds = new Set()
      for (const m of O.text.matchAll(ID_RE)) beforeIds.add(m[0])
      for (const m of addText.matchAll(ID_RE)) {
        if (!beforeIds.has(m[0])) addedSectionNovel.push({ kind: '标识', value: m[0] })
      }
      const beforeNums = extractNumerics(O.text)
      const addNums = extractNumerics(addText)
      for (const [key, info] of addNums) {
        if (beforeNums.has(key)) continue
        // ⚠️ **这里故意不套用 3c 的"短整数跳过"规则。**
        //    3c 面对整篇文档，短整数假阳太多；而这一节**只看两节新增文字**，范围极小，
        //    且它要抓的病灶**恰恰是短计数**——实测 `风险登记（2 项，均不阻塞）`
        //    就是架构师凭空的计数（原稿风险表 3 行，没有"2 项"这个数）。
        //    若在这里也跳过 `digits.length <= 2`，**这个病灶一次也报不出来**
        //    （§17.12 的"判据在权威口径下不可能判出目标"）。
        const digits = String(info.raw).replace(/[^\d]/g, '')
        // 只保留"带单位/百分号/小数"的，纯裸数字（1、2、3）仍跳过——它们更可能是章节序号
        const hasUnit = /[个项行处文件版次条列张组秒分时天日%]/.test(info.raw) || /\./.test(info.raw)
        if (digits.length <= 2 && !hasUnit) continue
        if (digits.length === 1 && !hasUnit) continue
        addedSectionNovel.push({ kind: '数值', value: info.raw, family: info.family })
      }
    }
  }

  // ---- 4b. 并入式冗余（判据⑭）----
  //
  // **为什么必须有这一节**：`## 零、前置参考` 拆掉后，其引用要"**并**"进正文。
  // 若把 ref 的整句话直接拿来当并入文本，就会**同一件事一行里说两遍**：
  //
  //   …是 AI 与人工操作远端的**唯一入口**（`tools/ssh_remote.py` 是 AI 与人工同一远程的唯一入口，见 …§5）
  //                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 与前文重说一遍
  //
  // **它 数值一个没少 / 痕迹没有 / 结构 9/9 / 节号未动 / 3c=0 —— 五道绿灯全过。**
  //
  // 而它正是**用户最初投诉的那个病的续集**：
  //   原来的冗余 = "**没删干净旧过程**"；
  //   这一类的冗余 = "**删旧过程时新造了冗余**"。
  //   前 13 项查的是"**少了什么**"与"**多了什么可疑内容**"；
  //   这一类是"**同一信息出现两次**"——**既不缺也不假，只是重复**。所以谁都看不见。
  //
  // **判据三版演进（这段本身是方法论）**：
  //
  // | 版本 | 判别法 | 实测 | 判决 |
  // |---|---|---|---|
  // | 一 | 插入语里 ≥10 字片段已出现在同一行 | 报 91/65 处，抽样 6 处**全假阳**（命中 `` `--timeout` ``/函数名等合法重复标识） | 否 |
  // | 二 | 最长公共子串 ≥18 字且含 ≥8 CJK | **连已知坏例都抓不到**——真病灶是**换词复述**（「操作远端的唯一入口」vs「同一远程的唯一入口」），子串在「AI 与人工」后就分岔 | 否 |
  // | **三** | **插入语从头重说**（inner 开头与 before 有 ≥12 字公共前缀，先归一化去 `` ` ``/`**`/空格） | 2 个已知坏例**全中**；7 个合法形态**全不中**；真实文档假阳 0~1 | **采纳** |
  //
  // > **版本二被否掉比版本三被采纳更重要。** 它是一个"**看起来在工作、其实永远抓不到目标**"的判据：
  // > 假阳性 0、报告干净，**但一次也不可能报出真病灶**。与 §17.5 的恒绿判据同型。
  // > **发现它的唯一方法是拿已知坏例反向验证**——只看它在正常文档上"没报警"，
  // > **区分不出「没有病」与「检测不出来」**。
  //
  // **只报告、不作闸门**（唯一已知假阳：`docs/479:351` 报 `self._timeout`，代码标识符合法重复）。
  const redundantMerges = []
  {
    const norm = (s) => s.replace(/[`*_\s]/g, '')
    const CJK = /[\u4e00-\u9fa5]/
    for (let i = 0; i < R.lines.length; i++) {
      const line = R.lines[i]
      // 找行内括号插入语（中英文括号都算）
      for (const m of line.matchAll(/[（(]([^（()）]{12,200})[）)]/g)) {
        const inner = m[1]
        if (!CJK.test(inner)) continue
        const before = norm(line.slice(0, m.index))
        const innerN = norm(inner)
        // 插入语**从头重说**：inner 的开头与 before 有一段公共前缀
        let common = 0
        const lim = Math.min(innerN.length, before.length)
        while (common < lim && innerN[common] === before[before.length - lim + common]) common++
        // 也允许 before 的**末尾片段**与 inner 开头一致（before 末尾 = 重说锚点）
        let tail = 0
        for (let k = Math.min(12, before.length, innerN.length); k >= 6; k--) {
          if (before.endsWith(innerN.slice(0, k))) { tail = k; break }
        }
        const hit = common >= 12 || tail >= 6
        let sub = 0
        if (!hit) {
          // 逐长度滑窗：片段内**汉字数 ≥6** 且 `before` 含该片段 ⇒ 重说。
          // ⚠️ 不能用"片段**全部**是汉字"——重说常中间夹 ASCII（`是 AI 与人工…`）。
          //
          // 🔴 **已知漏报（实测，勿删）**：`534` 报告的那个"教科书例"
          //   「…操作远端的**唯一入口**（`tools/ssh_remote.py` 是 AI 与人工**同一远程**的唯一入口，见 §5）」
          //   ——`before` 是 `操作远端`，插入语是 `同一远程`，**两者真正共现的只有 `人工` 两个字**
          //   （`同` 只出现在插入语里）。**任何"公共子串"判据都抓不到它**；
          //   若把阈值降到 2~3 字，`合法重复标识`会立刻刷屏（§17.14 判据⑭ 版本一就是这么被否掉的）。
          //   ⇒ **这一类"换词复述"是子串法的盲区，只能靠通读。** 本判据只抓**强重叠**（≥6 字真共现）。
          const MIN_CJK = 6
          for (let len = 14; len >= MIN_CJK && !sub; len--) {
            for (let a = 0; a + len <= innerN.length; a++) {
              const piece = innerN.slice(a, a + len)
              if ((piece.match(/[\u4e00-\u9fa5]/g) || []).length < MIN_CJK) continue
              if (before.includes(piece)) { sub = len; break }
            }
          }
        }
        if (hit || sub) {
          redundantMerges.push({
            line: i + 1, overlap: Math.max(common, tail, sub),
            inner: inner.slice(0, 90),
          })
        }
      }
    }
  }

  // 判定式与全部误报排除规则都在 lib-traces.mjs（唯一定义处）。
  //
  // ⚠️ **v2 修正（系统性假阳性）**：v1 只扫产物行，**不检查该行是否原稿本来就有**。
  //    这与本目标的另一条硬纪律**直接冲突**——"页脚/状态行/被引用证据要**逐字继承**"。
  //    结果：凡是**合规地保留了原稿修订注记**的文档，都会被判"修订痕迹不为 0"，
  //    也就是**永远无法通过**；而架构师若为了通过而删掉它们，又违反"逐字继承"。
  //    （与 §17.5 的恒绿判据同源，只是这次是**恒红判据**。）
  //
  //    实测：全批工具报 5 处（`403` 3 处、`488` 2 处）→ 剥离逐字继承后**真新增 = 0 行**。
  //    被误报的都是原稿本来就有、按纪律**必须保留**的行，例如：
  //      `## 四、统一方案设计（v3.0 修正版）`
  //      `> 🗄️ **历史记录注记（T-24 勘误，2026-09-05）**：…`
  //      `> **v2.0 修正**：添加 DB 驱动配置原则（§3.10）…`
  //
  //    **正确判据式**：产物中命中痕迹词表的行 **∩ 不在原稿中** = 真修订叙事。
  //    （对照数据也一并保留：`inheritedTraceLines` 让"继承了几行"可见，
  //     否则无法区分"真的 0 处"与"判据看不见"。）
  const origLineSet = new Set(O.lines.map((s) => s.trim()))
  const traceHits = []            // 真新增（进闸门）
  const inheritedTraceLines = []  // 逐字继承（只报告，不进闸门）
  for (let i = 0; i < R.lines.length; i++) {
    const l = R.lines[i]
    if (!isTraceLine(l)) continue
    if (origLineSet.has(l.trim())) inheritedTraceLines.push({ line: i + 1, text: l.slice(0, 140) })
    else traceHits.push({ line: i + 1, text: l.slice(0, 140) })
  }
  const versionMentions = []
  const upstreamVersionMentions = []
  /**
   * 版本号要分两类看待，「逐字保留」规则只禁止前者：
   * - **自指版本号**：本文档自己第几版改的（`（v1.2 新增）`、`v1.5 订正为…`），必删，只许头部留 1 行。
   * - **引用上游文档的版本号**：`555 v1.3.4 §4.8`、`docs/547（v1.3，现行）`、`node v24.19.0`。
   *   这些属于「被引用文档的标识」，压缩粒度边界明确要求逐字保留——误删会让读者无法定位依据。
   *
   * 判定取向：**用正面特征判定「自指」，不用排除法**。理由是排除法需要穷举所有「看起来像
   * 版本号但其实不是」的写法（上游文档编号、`node -v` 输出、包名、配置键……），把整个 558
   * 语料当成边界用例去凑，既脆弱又难检查；而自指的写法其实高度固定——**自指版本号的后面
   * 一定跟着一句「这一版改了什么」**（新增 / 修订 / 订正…），或它就写在头部 `版本：` 字段里。
   * 所以只认这两种签名，其余一律视为引用（并在报告里列出，便于人眼抽查）。
   * 注意：`V0/V1`、`V2` 这类无小数点的分级标签不是版本号（正则已要求 `v\d+\.\d+`），不参与。
   */
  // 自指签名：版本号 + 紧随其后的修订动作词（允许中间夹标点/空格/括号）
  //
  // ⚠️ **vN 的小数点必须是可选的**（2026-09-17 修正，来自 0.1.24 外部接管那份的实测）：
  // 原先写成 `v\d+\.\d+`，于是整批 `（v6 新增）`/`（v4 行）` 这类**无小数点自指注记**全部漏检——
  // 那份原稿实际有 **103 处**括号内版本注记，而工具报 **0**，反向验证因此给出**假的安全感**。
  //
  // 放宽为什么安全：自指的判别力**不在小数点，而在"版本号后紧跟修订动作词"**这个签名。
  // `（v6 新增）` 里的 `新增` 就是那个签名；而"引用上游文档版本"不会被这个签名命中
  // （写的是 `docs/555 v1.3.4 §4.8`，后面跟的是章节号，不是"新增/修订"）。
  //
  // ⚠️ **动词集必须收窄**（同日第二次修正）：放宽小数点后实测出假阳——`v2 起关闭`、`v2 说明见 §X`
  // 这类是**叙述主体自身的版本**或指向别处的指针，不是本文档的修订史。
  // 故只保留**明确的修订动作词**，去掉 `说明/起/引入/并入/改造` 这类兼作普通动词的词。
  const SELF_VERSION_MARKER_RE =
    /v\d+(?:\.\d+)*(?:\.\d+)?[\s（(，,、:：—\-]*?(?:新增|新加|修订|更正|订正|更新|补登|补写|改写)(?![\w])/
  // 头部签名：`版本：v3.0` / `version: v1.2`（头部字段，允许且只允许 1 处）
  const HEADER_VERSION_RE = /(?:^|\|)\s*(?:版本|version)\s*[:：]\s*v\d+\.\d+/i
  for (let i = 0; i < R.lines.length; i++) {
    const line = R.lines[i]
    if (!/\bv\d+(?:\.\d+)*/.test(line)) continue
    const isHeaderField = HEADER_VERSION_RE.test(line)
    const isSelfMarker = SELF_VERSION_MARKER_RE.test(line)
    if (isSelfMarker || (isHeaderField && i > 6)) {
      // `i > 6`：头部 7 行内（标题 + 状态/版本/日期行）允许 1 处版本号
      versionMentions.push({ line: i + 1, text: line.slice(0, 140) })
    } else {
      upstreamVersionMentions.push({ line: i + 1, text: line.slice(0, 140) })
    }
  }

  // ---- 5. 结构 ----
  //
  // ⚠️ **必须跳过代码围栏**。产物里**贴了原稿或模板原文**时，那段被围栏包住的文本
  //    里可能逐字含 `## 进度桩协议（强制）` 之类的行——按行首正则数标题会把它算进去，
  //    于是"9 节结构"判据**虚高**（实测 10 份受影响：`466` 围栏内 **10** 个、`428` 4 个、
  //    `414` 3 个、`433` 2 个、`420`/`413`/`417`/`408`/`460`/`458` 各 1 个）。
  //    而这些围栏内容**不能改**——改它=**篡改被引用的原始数据**。
  //    （同一类错误已在 B 类批 1 的解析器里出现过："解析器不分围栏会'多出' 5~17 节，
  //      断言不分围栏会把**正确**产物判成失败"。）
  const heads = []
  {
    let inFence = false
    let fenceTok = null
    for (let i = 0; i < R.lines.length; i++) {
      const l = R.lines[i]
      const m = l.match(/^\s*(`{3,}|~{3,})/)
      if (m) {
        if (!inFence) { inFence = true; fenceTok = m[1][0] }
        else if (m[1][0] === fenceTok) { inFence = false; fenceTok = null }
        continue
      }
      if (inFence) continue
      if (/^##\s/.test(l)) heads.push({ line: i + 1, text: l.replace(/^#+\s*/, '') })
    }
  }

  /**
   * **空壳节**：只有标题、正文为空（或只有分隔线/空白）。
   *
   * 为什么必须单独断言：结构判据只匹配**标题正则**，所以"节标题在、内容没了"
   * 会一路绿灯通过，让"结构 9/9 ✅"变成一个**没有内容的绿灯**。
   *
   * 实测 `483`：产物把 `## 七、决策记录` 变成只有标题与空行的空壳，
   * 而原稿那张 **7 条决策表**（`D483-1`~`D483-6`）与 `## 十二、决策记录（补充）` 里的
   * `D483-7` 证据链（含 `backend/services/pg_db.py` L377-384 等 4 处文件+行号）
   * 与 `D483-8v2` 的修复代码块**全部消失**——**而结构判据是 ✅**。
   *
   * 这是"不要造空壳节凑正则"的**反面**：造空壳是**用标题骗核验器**，
   * 这里是**标题还在、内容没了**——两者都让结构判据失去意义。
   *
   * **只报告、不作硬闸门**：少数文档里某节本来就只放一行指针（如"见 §N"），
   * 那是合法形态。但**任何一个空壳节都该被人看一眼**。
   */
  const emptySections = []
  {
    let inF = false, fTok = null
    let curH = null, body = 0
    const flush = () => {
      if (curH && body === 0) emptySections.push({ line: curH.line, text: curH.text })
      curH = null
    }
    for (let i = 0; i < R.lines.length; i++) {
      const l = R.lines[i]
      const m = l.match(/^\s*(`{3,}|~{3,})/)
      if (m) {
        if (!inF) { inF = true; fTok = m[1][0] } else if (m[1][0] === fTok) { inF = false; fTok = null }
        if (curH) body++
        continue
      }
      if (inF) { if (curH) body++; continue }
      if (/^##\s/.test(l)) { flush(); curH = { line: i + 1, text: l.replace(/^#+\s*/, '') }; continue }
      if (/^###\s/.test(l)) { if (curH) body++; continue }  // 有子节也算有内容
      // 分隔线、纯空白、`---` 不算正文
      if (/^\s*$/.test(l) || /^\s*-{3,}\s*$/.test(l)) continue
      if (curH) body++
    }
    flush()
  }
  const structureOk = SECTION_HEADS.map((pat, idx) => ({
    expected: pat,
    found: heads.some((h) => new RegExp(pat).test(h.text)),
  }))

  // ---- 6. 超长行 ----
  const longLines = []
  for (let i = 0; i < R.lines.length; i++) {
    if (R.lines[i].length > 500) longLines.push({ line: i + 1, chars: R.lines[i].length })
  }

  // ---------------- 输出 ----------------
  const L = []
  const P = (s) => L.push(s)
  P(`# 重写/清洗产物零丢失校验报告`)
  P('')
  P(`- 原文件：\`${a.original}\``)
  P(`- 重写后：\`${a.rewrite}\``)
  P(`- 生成时间：${new Date().toISOString()}`)
  P(`- 说明：**本报告只列差异，不判断对错**；每条差异由人或 QA 裁决"是被合理删除的过程，还是丢失的设计信息"。`)
  P('')
  P(`## 1. 体量对比`)
  P('')
  P(`| 项 | 原文件 | 重写后 | 变化 |`)
  P(`|---|---:|---:|---:|`)
  P(`| 行数 | ${size.original.lines} | ${size.rewrite.lines} | ${size.deltaLines >= 0 ? '+' : ''}${size.deltaLines} |`)
  P(`| 原始字节 | ${size.original.bytes.toLocaleString('en-US')} | ${size.rewrite.bytes.toLocaleString('en-US')} | ${size.deltaBytes >= 0 ? '+' : ''}${size.deltaBytes.toLocaleString('en-US')} |`)
  P(`| **内容体量**（剔除全部换行符的 UTF-8 字节）**← 判据用这个** | ${size.original.contentChars.toLocaleString('en-US')} | ${size.rewrite.contentChars.toLocaleString('en-US')} | ${size.deltaContentChars >= 0 ? '+' : ''}${size.deltaContentChars.toLocaleString('en-US')} |`)
  P(`| 内容字节（仅归一 CRLF→LF，仍含 \\n） | ${size.original.contentBytes.toLocaleString('en-US')} | ${size.rewrite.contentBytes.toLocaleString('en-US')} | ${size.deltaContentBytes >= 0 ? '+' : ''}${size.deltaContentBytes.toLocaleString('en-US')} |`)
  P(`| 换行符 | ${size.original.eol} | ${size.rewrite.eol} | ${size.eolChanged ? '⚠️ 已改变（不影响判据）' : '一致'} |`)
  P(`| 缩减比例（按内容体量） | — | — | ${((1 - size.rewrite.contentChars / size.original.contentChars) * 100).toFixed(1)}% |`)
  P('')
  P(`**净增长 ≤ 0 判据：${size.netGrowthOk ? '✅ 满足' : '❌ 不满足（不得变长）'}**`)
  P('')
  P(`> 判据用**内容体量**（剔除全部换行符的 UTF-8 字节）而非原始字节：存量原稿多为 CRLF、重写稿为 LF，直接用原始字节会把"换行符变短"误算成内容缩减。`)
  P(`> **单位提醒：这是字节数，不是"字符个数"。** 中文 1 个汉字 = 3 字节，所以本列数值约是中文「字数」的 2~3 倍。若与架构师自报的数字对不上，先问一句他量的是 UTF-16 码元（\`.length\`）还是 UTF-8 字节——**缩减比例一致即口径等价，不必纠数值**。`)
  P(`> 也**不用"内容字节"**：它只归一了 CRLF→LF，\`\\n\` 仍在数里，于是**行数变化会渗进来**——实测 447 原稿 6,787 = 真内容 6,640 + 147 个换行符。重排结构（加表格、折行）恰恰最会改行数，用错口径会把正当改造判成"变长了"。`)
  P(`> 判据同时要求**行数不增**：内容字符不增但行数暴涨，说明把内容摊成了大量短行，同样属变长。`)
  P(`> 例外：补齐契约要求的标准章节（§一 需求复述 / §二 关键结论）不计入净增长，但须在交付说明中列出**补了什么、占多少**。`)
  P('')
  P(`**行数变化参考：${size.lineGrowth >= 0 ? '+' : ''}${size.lineGrowth} 行**${size.lineGrowth > 0 ? '（内容未增时，行数增加通常是重排结构所致，属正常）' : ''}`)
  P('')

  P(`## 2. 设计标识符留存`)
  P('')
  P(`> 缺失 = 原文件出现、重写后没出现。**逐条都要能解释**：编号若只是为对应 QA 轮次而存在，可去掉编号只留内容；若是设计自身的标识符，缺失即丢失。`)
  P('')
  P(`| 标识符族 | 原文件 | 重写后 | 缺失 | 新增 |`)
  P(`|---|---:|---:|---:|---:|`)
  for (const r of idReport) {
    P(`| ${r.family} | ${r.originalCount} | ${r.rewriteCount} | **${r.missing.length}** | ${r.added.length} |`)
  }
  P('')
  const allMissingIds = idReport.filter((r) => r.missing.length)
  if (allMissingIds.length) {
    P(`### 缺失的标识符明细`)
    P('')
    for (const r of allMissingIds) {
      P(`- **${r.family}**（${r.missing.length} 个）：\`${r.missing.join('`, `')}\``)
    }
  } else {
    P(`### ✅ 未被检出的标识符缺失`)
  }
  P('')

  P(`## 2b. 真缺失判定（区分"丢失"与"分割伪影"）`)
  P('')
  P(`> 上一节的缺失分两类：**真缺失**＝原文件里有编号定义行、重写后没有（要逐条解释）；**伪影**＝编号只是被正则从别的字串里抓出来的（例如从 \`docs/552\` 抓出 \`D-2\`），不构成丢失。`)
  P('')
  if (!definedReport.length) {
    P(`✅ 无缺失项，无需判定。`)
  } else {
    P(`| 标识符族 | 真缺失 | 分割伪影 |`)
    P(`|---|---:|---:|`)
    for (const d of definedReport) P(`| ${d.family} | **${d.realMissing.length}** | ${d.artifacts.length} |`)
    P('')
    for (const d of definedReport.filter((x) => x.realMissing.length)) {
      P(`### ⚠️ ${d.family} 真缺失明细（原文件中的定义行）`)
      P('')
      for (const m of d.realMissingDetail) {
        P(`- \`${m.id}\` — 原 L${m.original.line}：${m.original.text.replace(/\|/g, '/')}`)
      }
      P('')
    }
    for (const d of definedReport.filter((x) => x.artifacts.length)) {
      P(`- ${d.family} 的 ${d.artifacts.length} 个"缺失"是分割伪影：\`${d.artifacts.join('`, `')}\``)
    }
    P('')
  }

  P(`## 3. 数字指纹留存`)
  P('')
  P(`> 数字要能核验就必须逐字相同（同一命令在不同环境跑出的数字不是同一个事实）。缺失的数字逐条裁决。`)
  P('')
  P(`| 指纹族 | 原文件 | 重写后 | 真缺失 | 去重 |`)
  P(`|---|---:|---:|---:|---:|`)
  for (const r of numReport) {
    P(`| ${r.family} | ${r.originalCount} | ${r.rewriteCount} | **${r.missingCount}** | ${r.reducedCount || 0} |`)
  }
  P('')
  P(`**数字指纹总缺失：全量比对 ${rawNumMissingTotal} 个 / 设计正文比对 ${bodyNumMissingTotal} 个**（另有 ${reducedTotal} 个属"正确去重"，不计入缺失）`)
  P('')
  P(`> **"真缺失"与"去重"为什么必须分开报**（实测教训，来自 404）：404 原稿把「评审准备时间缩短70%」写了两遍`)
  P(`> （概览表 L453 + 实施清单 L1068），清洗后只留一处——这是 D9 要求的**正确去重**，却被报成"数值缺失 1"。`)
  P(`> 判据：该数值在**原稿里出现 ≥2 次**、重写稿里 ≥1 次 → 去重；原稿只出现 1 次却没了 → 真丢失。`)
  P(`> **两者处置相反**：去重是对的；真丢失必须补回。混在一起报会让人去补一个本就该删的重复值。`)
  P('')
  P(`> **两个视图怎么读**：清洗会整节删除「QA 设计检查回环响应表」等过程章节（560 试点确立的做法），`)
  P(`> 因此拿"含该表的原稿"比"不含该表的重写稿"，会把**正确删除的 QA 表内容报成丢失**——`)
  P(`> 实测 sangfor 调研报告的全量比对报出 44 个百分比"丢失"，逐条查上下文全是 \`QA·F-3\`、\`验证·V1\` 这类核对表行。`)
  P(`>`)
  P(`> **判别真丢失以「设计正文」视图为准**；全量视图的差异逐条看上下文，是 QA/修订行的即可解释。`)
  P('')
  P(`### 3c. 反向数值指纹：改后稿里凭空多出来的数值（**新增检查，2026-09-17**）`)
  P('')
  P(`前面所有数值检查都只查"原稿有、改后没了"。**这一节查反向：改后稿有、原稿没有。**`)
  P('')
  if (novelNumerics.length === 0) {
    P(`**未发现凭空新增的数值。** ✅`)
  } else {
    P(`**发现 ${novelNumerics.length} 个"改后稿有、原稿没有"的数值** —— 逐个确认：是**重算出的新值**（合规），还是**编造**（必须改回原稿的值）？`)
    P('')
    P(`| 数值 | 指纹族 |`)
    P(`|---|---|`)
    for (const x of novelNumerics.slice(0, 40)) P(`| \`${x.value}\` | ${x.family} |`)
    if (novelNumerics.length > 40) P(`| …另有 ${novelNumerics.length - 40} 个 | |`)
  }
  P('')
  P(`> **为什么必须有这一节**（实测教训，来自 sangfor 报告）：那一版把原稿的 **76.26%** 写成了 **71.52%**，`)
  P(`> 而 71.52% 在原稿里出现 **0 次**。它同时把 76.26% 从 3 处降到 2 处、把带该数的逐字摘录整行删掉。`)
  P(`> 减少的那一处被"设计正文缺失 = 0"掩盖，**而编造出来的那个数，用任何"查缺失"的方式都检不出来**。`)
  P(`> 财务/合规类报告尤其致命：**改动一位数字就是错的**。`)
  P('')
  P(`> **这一节的假阳性是设计上的取舍**：重算出的新值、日期推进、格式差异都会落入此列，所以它**只列不判失败**，`)
  P(`> 用途是给"通读查多了"提供线索清单。已跳过**版本号族**（新版本号是正常的）与**短整数**。`)
  P('')
  for (const r of bodyNumReport.filter((x) => x.missingCount)) {
    P(`- **【正文视图】${r.family}** 缺失 ${r.missingCount} 个（列前 40）：\`${r.missing.join('`, `')}\``)
  }
  const rawOnly = numReport.filter((x) => x.missingCount)
  if (rawOnly.length) {
    P('')
    P(`全量视图缺失（与正文视图之差，即已由 QA/修订章节删除解释的部分）：`)
    for (const r of rawOnly) {
      const body = bodyNumReport.find((b) => b.family === r.family)
      const explained = r.missingCount - (body ? body.missingCount : 0)
      P(`- ${r.family}：报出 ${r.missingCount} 个，其中 ${explained} 个可由"QA/修订章节已删"解释`)
    }
  }
  P('')

  // 3d 报告
  // 3b 报告（判据 ①c）
  P('## 3b. 数值出现次数减少（判据 ①c）')
  P('')
  P(`- 命中：**${reducedOccurrences.length} 项**  ${reducedOccurrences.length === 0 ? '✅ 无次数减少' : '⚠️ 线索清单，逐条人判'}`)
  P('  - 判据式：`原稿次数 > 改后稿次数 + 移出件次数`（**对称扣除移出件**——搬家不是丢失）')
  P(`  - 移出件：${MOVED_OUT.length ? MOVED_OUT.map((p) => p.split(/[\\/]/).pop()).join(', ') : '**未提供**（此时候选数会偏高，请用 --moved-out 指明被移出的节）'}`)
  P('  - **为什么必须有**：`76.26%` 3→2 次的同时凭空造了 `71.52%`，当时工具只报 `missing: 1`')
  P('    ——**"凭空多 1"掩盖了"减少 1"**。只问"值还在不在"的判据**对次数减少结构性不敏感**。')
  if (reducedOccurrences.length) {
    P('')
    P('| 值 | 族 | 原稿 | 改后 | 移出件 |')
    P('|---|---|---:|---:|---:|')
    for (const r of reducedOccurrences.slice(0, 50)) P(`| ${String(r.value).replace(/\|/g, '/')} | ${r.family} | ${r.from} | ${r.inRewrite} | ${r.inMoved} |`)
  }
  P('')
  P('## 3d. 反向标识指纹（改后稿**凭空多出**的带编号标识 / 被引用文件名）')
  P('')
  P(`- 命中：**${novelIdentifiers.length} 项**  ${novelIdentifiers.length === 0 ? '✅ 无凭空新增' : '⚠️ 线索清单，逐条人判'}`)
  P(`  - 判据式：**改后稿有 ∩ 原稿无**（单向、保守；只列不判失败）`)
  P(`  - **为什么必须有**：数值有 3c 管，但**标识没有反向判据**——所有标识判据都是单向的，`)
  P(`    **凭空编造的标识符可以静默通过全部判据**（与 3c 抓到的"编造数值"同一类盲区）。`)
  P('  - 已知假阳：节号重排的新编号、新增章节的示例标识、原稿裸名→产物补全 文件:行号（后者是改进）。')
  if (novelIdentifiers.length) {
    P('')
    for (const v of novelIdentifiers.slice(0, 60)) P(`  - \`${v}\``)
  }
  P('')
  // 4c 报告（判据⑫）
  P('## 4c. 新增章节夹带检查（判据⑫：零-甲/零-乙 不得引入新数值/新标识）')
  P('')
  P(`- 命中：**${addedSectionNovel.length} 项**  ${addedSectionNovel.length === 0 ? '✅ 无夹带' : '⚠️ 线索清单，逐条人判'}`)
  P('  - 判据式：`零-甲`/`零-乙` 里出现的每个数值指纹与带编号标识，**必须在原稿中有同形的一处**')
  P('  - **为什么单列**：这两节是架构师自己写的，夹带的东西**在后面所有节里都没有对照**')
  P('  - 已知假阳：复述本就会重述正文里的数（**同值异形**会误报，如 `17 条用例` vs `17 用例`）')
  if (addedSectionNovel.length) {
    P('')
    P('| 类 | 值 | 族 |')
    P('|---|---|---|')
    for (const r of addedSectionNovel.slice(0, 40)) P(`| ${r.kind} | ${String(r.value).replace(/\|/g, '/')} | ${r.family || ''} |`)
  }
  P('')
  P('## 4b. 并入式冗余（判据⑭：同一信息一行内说两遍）')
  P('')
  P(`- 命中：**${redundantMerges.length} 处**  ${redundantMerges.length === 0 ? '✅ 无并入式冗余' : '⚠️ 线索清单，逐条人判'}`)
  P('  - 判据式：**行内括号插入语的开头与前文重说**（归一化后公共前缀 ≥12 字，或前文末尾 ≥6 字即插入语开头）')
  P('  - 已知假阳：代码标识符的合法重复（如 self._timeout）——故 **report-only**')
  if (redundantMerges.length) {
    P('')
    P('| 行 | 重叠 | 插入语 |')
    P('|---:|---:|---|')
    for (const r of redundantMerges.slice(0, 40)) P(`| ${r.line} | ${r.overlap} | ${r.inner.replace(/\|/g, '/')} |`)
  }
  P('')
  P(`## 4. 修订痕迹检出（QA D10）`)
  P('')
  P(`- 重写产物中的修订痕迹命中：**${traceHits.length} 行**  ${traceHits.length === 0 ? '✅ 通过' : '❌ 应为 0'}`)
  P(`  - 判据式：**产物命中痕迹词表的行 ∩ 不在原稿中**（剥离逐字继承）`)
  P(`  - 逐字继承的痕迹行（原稿本来就有、按"逐字继承"纪律必须保留）：**${inheritedTraceLines.length} 行** → 只报告，**不进闸门**`)
  if (inheritedTraceLines.length) {
    P('')
    P(`<details><summary>继承行明细（${inheritedTraceLines.length} 行，非违规）</summary>`)
    P('')
    for (const h of inheritedTraceLines.slice(0, 40)) P(`- L${h.line}：${h.text.replace(/\|/g, '/')}`)
    P('')
    P('</details>')
  }
  P(`- 重写产物中的**自指版本号**出现：**${versionMentions.length} 处**（按规则只允许头部 1 行）  ${versionMentions.length <= 1 ? '✅ 通过' : '❌ 超出 1 处'}`)
  P(`  （引用上游文档的版本号另计，见本节末，属合法保留）`)
  P('')
  if (traceHits.length) {
    P(`| 行 | 内容 |`)
    P(`|---:|---|`)
    for (const h of traceHits.slice(0, 60)) P(`| ${h.line} | ${h.text.replace(/\|/g, '/')} |`)
    P('')
  }
  if (versionMentions.length) {
    P(`自指版本号出现位置（须为 0，只允许头部 1 行）：`)
    for (const h of versionMentions.slice(0, 20)) P(`- L${h.line}：${h.text.replace(/\|/g, '/')}`)
    P('')
  }
  if (upstreamVersionMentions.length) {
    P(`引用上游文档的版本号（**合法，逐字保留**，不计入不合规）：**${upstreamVersionMentions.length} 处**`)
    P(`- 判据：形如 \`555 v1.3.4 §4.8\`、\`docs/547（v1.3，现行）\`、\`node v24.19.0\` 的版本号属于「被引用文档的标识」，压缩粒度边界要求逐字保留。`)
    for (const h of upstreamVersionMentions.slice(0, 12)) P(`- L${h.line}：${h.text.replace(/\|/g, '/')}`)
    if (upstreamVersionMentions.length > 12) P(`- …（共 ${upstreamVersionMentions.length} 处，其余略）`)
    P('')
  }

  P(`## 5. 结构核对（9 节）`)
  P('')
  P(`| 期望章节 | 是否找到 |`)
  P(`|---|---|`)
  for (const s of structureOk) P(`| ${s.expected} | ${s.found ? '✅' : '❌'} |`)

  if (emptySections.length) {

    P('')

    P(`- **空壳节**（有标题、正文为空）：**${emptySections.length} 处**  ⚠️ 请逐条人判（结构判据只看标题，会放过它们）`)

    for (const s of emptySections.slice(0, 20)) P(`  - L${s.line}：${s.text.replace(/\|/g, '/')}`)

  }
  
  P('')
  P(`重写产物的二级标题（${heads.length} 个）：`)
  for (const h of heads) P(`- L${h.line} ${h.text}`)
  P('')

  P(`## 6. 超长行（D12 复核信号）`)
  P('')
  P(`- 重写产物 >500 字符的行：**${longLines.length} 行**`)
  if (longLines.length) {
    P('')
    P(`| 行 | 字符数 |`)
    P(`|---:|---:|`)
    for (const h of longLines.slice(0, 30)) P(`| ${h.line} | ${h.chars} |`)
  }
  P('')

  const md = L.join('\n')
  console.log(md)

  if (a.out) {
    mkdirSync(a.out, { recursive: true })
    const base = basename(a.rewrite).replace(/\.md$/, '')
    const mdPath = join(a.out, `verify-${base}.md`)
    writeFileSync(mdPath, md, 'utf8')
    writeFileSync(join(a.out, `verify-${base}.json`), JSON.stringify(
      { original: a.original, rewrite: a.rewrite, size, idReport, numReport, bodyNumReport, rawNumMissingTotal, bodyNumMissingTotal, novelNumerics, traceHits, inheritedTraceLines, novelIdentifiers, redundantMerges, addedSectionNovel, reducedOccurrences, versionMentions, structureOk, emptySections, heads, longLines },
      null, 2), 'utf8')
    console.error(`\n报告已落盘：${mdPath}`)
  }
  return 0
}

process.exit(main())
