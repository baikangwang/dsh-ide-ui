#!/usr/bin/env node
/**
 * lib-lines-check.mjs — 行数口径的回归测试
 *
 * 本测试的**目的不是"库能跑"**，而是**钉住口径**：一旦有人改了 `lib-lines.mjs` 的语义，
 * 依赖"净增长 ≤ 0"的闸门结论就会变，必须在这里被挡住。
 *
 * 同时把**三种常见实现会量出不同结果**这件事固化成证据——这正是当初判据失效的原因。
 */
import { countLines, countBytes, countChars, measure } from '../tools/lib-lines.mjs'

let fail = 0
const eq = (name, got, want) => {
  const ok = got === want
  if (!ok) fail += 1
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}  期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
}

// ── 口径用例 ────────────────────────────────────────────────────────────────
console.log('行数口径：UTF-8 解码后按 \\n 切分的段数；空行照数；末尾换行不多算一段')
eq('空串', countLines(''), 0)
eq('单行无换行', countLines('a'), 1)
eq('单行带末尾换行', countLines('a\n'), 1)
eq('两行带末尾换行', countLines('a\nb\n'), 2)
eq('两行无末尾换行', countLines('a\nb'), 2)
eq('含空行（空行照数）', countLines('a\n\nb\n'), 3)
eq('CRLF 与 LF 同口径', countLines('a\r\nb\r\n'), countLines('a\nb\n'))
eq('纯 CR 也归一', countLines('a\rb'), 2)
eq('中文两行', countLines('第一行\n第二行\n'), 2)

console.log('\n字节与字符')
eq('中文 3 字 = 9 字节', countBytes('中文测'), 9)
eq('中文 3 字 = 3 字符', countChars('中文测'), 3)
eq('emoji 按码点算 1 字符', countChars('👍'), 1)

// ── 对照：三种常见实现会给出不同答案（判据失效的根因）────────────────────────
console.log('\n对照证据：同一份文本，三种实现量出的"行数"不同')
const sample = 'a\n\nb\n'
const mine = countLines(sample)
const naiveSplit = sample.split('\n').length                                  // Node 朴素写法
const psLike = sample.replace(/\r\n/g, '\n').split('\n').filter((s) => s.trim() !== '').length // Measure-Object -Line 行为
console.log(`  文本 ${JSON.stringify(sample)}`)
console.log(`  本口径            ${mine}   ← a / 空行 / b`)
console.log(`  split('\\n').length ${naiveSplit}   ← 末尾换行多算一段`)
console.log(`  跳过空行（PS -Line） ${psLike}   ← 空行被吃掉`)
if (!(mine === 3 && naiveSplit === 4 && psLike === 2)) {
  fail += 1
  console.log('  FAIL 三种实现应当给出三个不同的数（这正是"净增长 ≤ 0"会因换工具而改变结论的原因）')
}
console.log('\n  实测更极端的例子：一份 100 行的中文文档，PowerShell 的 -Line 与 Python 的')
console.log('  splitlines() 在同一文件上可以差出十余行——差值全部来自空行与末尾换行。')

// ── measure 三数齐出 ────────────────────────────────────────────────────────
console.log('\nmeasure() 一次给出契约所说的"三个数"')
const m = measure('第一行\n第二行\n')
console.log(`  ${JSON.stringify(m)}`)
eq('lines', m.lines, 2)
eq('bytes', m.bytes, Buffer.byteLength('第一行\n第二行\n', 'utf8'))
// 8 = 第一行(3) + \n(1) + 第二行(3) + \n(1)。**字符数把换行也算进去**，与行数不是一回事。
eq('chars', m.chars, 8)

// ── 全交付面的口径一致性（2026-09-20 补：契约有硬规则，此前无机制）────────────────
//
// 契约 `.dsh/contracts/qa/gate-standard.md`「行数口径（唯一定义处）」写着：
//   「任何工具要行数必须 import 它，**不得自行实现**。」
//
// **这条规则此前没有任何检查**，于是长期被违反而不为人知（审计实测：旗舰工具
// `verify-rewrite.mjs` 与 `measure-netgrowth.mjs` 各自 `split('\n')` 数行，
// 同一份内容量出 2 vs 3）。这里把它变成机器判据。
//
// 判据刻意收窄，只抓**"把行数当值用"**，不抓**"逐行遍历"**——后者 `split('\n')` 是正当用法：
//   1. 变量由 `split(/\r?\n/ | '\n')` 直接赋值；
//   2. 且该变量被读 `.length` **而该处不是 `for (...)` 的循环上界**。
//
// 第 2 条的限定是**反向验证逼出来的**：初版只判"读了 .length"，实测把
// `for (let i = 0; i < lines.length; i++)` 这种逐行遍历全判成违反（7 处假阳性）。
// 循环上界与"把行数当值用"是两件事，必须分开。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(HERE, '..', 'tools')
const SELF = 'lib-lines.mjs'
const SPLIT_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n]{0,80}?\.split\(\s*(?:\/\\r\?\\n\/|'\\n'|"\\n")\s*\)/g

// ── 已裁定的良性点（**人工逐条判定过一次，登记在案**）──────────────────────────
//
// 为什么不放宽判据而是列豁免：正则做不到把"把行数当值用"与"拿段数当数组用"分开，
// 放宽会把真违反一起放掉。所以判据保持窄，**每条命中必须被人判定一次**；
// 判成良性的记在这里，判成违反的必须改代码。**任何新增命中都会让本闸门失败**，
// 逼下一个改动者去判定，而不是让判据自己糊过去。
//
// **已知覆盖缺口（如实记录，不假装完备）**：本判据只认**由 `split` 直接赋给变量**的形式
// （`const A = rawA.split('\n')` 然后 `A.length`）。对象属性形式
// （`lines: t.split('\n')` 然后 `O.lines.length`）**抓不到**——`verify-rewrite.mjs` 当初
// 正是这种形式，是靠属性误匹配的歪路才被发现的，已于 2026-09-20 手工修掉。
// 要覆盖它得做数据流分析，正则做不到；宁可不报，也不发一个会误杀的判据。
//
// 契约「行数口径」管的是**文件的"行数"这个数**；下列两处不是：
//
// ⚠️ **豁免的键必须是"内容特征"，不能是"文件:行号"**（2026-09-20 修）：
//   原先键写作 `table-integrity.mjs:76`，结果一次**与该判据毫无关系**的改动
//   （7 支工具改自相对作用域）把该文件行号整体挪了 12 行 → 豁免当场失效，
//   一边报"新违反"、一边报"豁免名单已过期"，**两处失败都跟被改的东西无关**。
//   一个会被无关改动打穿的豁免名单，比没有豁免更坏：它逼人为了无关改动手工改编号。
//   现改为 `文件|代码特征`，行号位移不再影响，语义（必须被用到，否则报过期）不变。
const BENIGN = new Map([
  ['table-integrity.mjs|while (j < L.length', '`while (j < L.length && …)` 是**逐行扫描的循环上界**，不是把行数当值报出去。'],
])

// 命中是否落在已登记的豁免上（按文件 + 代码特征匹配，不看行号）
const benignWhy = (o) => {
  for (const [sig, why] of BENIGN) {
    const idx = sig.indexOf('|')
    const file = sig.slice(0, idx)
    const needle = sig.slice(idx + 1)
    if (o.name === file && o.code.includes(needle)) return why
  }
  return null
}

console.log('\n全交付面：宣称"任何工具要行数必须 import lib-lines"——谁在自行实现')
const offenders = []
const files = existsSync(TOOLS) ? readdirSync(TOOLS).filter((f) => f.endsWith('.mjs') && f !== SELF) : []
for (const name of files) {
  const abs = join(TOOLS, name)
  const text = readFileSync(abs, 'utf8')
  const usesLib = /from\s+['"][^'"]*lib-lines\.mjs['"]/.test(text)
  SPLIT_DECL.lastIndex = 0
  let m
  while ((m = SPLIT_DECL.exec(text)) !== null) {
    const v = m[1]
    const after = text.slice(m.index + m[0].length)
    // 负向后顾：`R.lines.length` 里的 `.lines` 不是本变量，不能匹配
    const lenRe = new RegExp(`(?<![.\\w$])${v.replace(/\$/g, '\\$')}\\.length\\b`, 'g')
    let lm
    while ((lm = lenRe.exec(after)) !== null) {
      const lineStart = after.lastIndexOf('\n', lm.index) + 1
      const lineEnd = after.indexOf('\n', lm.index)
      const theLine = after.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      const beforeOnLine = theLine.slice(0, lm.index - lineStart)
      // 循环上界：同一行里 `for (` 出现在 .length 之前 → 是遍历，不是数行
      if (/\bfor\s*\(/.test(beforeOnLine)) continue
      const line = text.slice(0, m.index + m[0].length + lm.index).split('\n').length
      offenders.push({ name, line, v, usesLib, code: theLine.trim().slice(0, 72) })
      break
    }
  }
}
for (const o of offenders) {
  const key = `${o.name}:${o.line}`
  const benign = benignWhy(o)
  const tag = benign ? '良性' : '违反'
  console.log(`  ${tag} ${key}  ${o.code}${benign ? `\n        └─ ${benign}` : o.usesLib ? '  ← 该文件已 import lib-lines，但这一行没有用它' : ''}`)
}
// **不因文件 import 了 lib-lines 就放行这一行**：import 了还裸数行，恰恰是最该抓的。
const hard = offenders.filter((o) => benignWhy(o) === null)
// 过期的判定同样按内容特征：登记的豁免在该文件里**再也找不到对应命中**才算过期。
// （按行号判过期会把"行号位移"误报成"豁免烂在名单里"。）
const stale = [...BENIGN.keys()].filter((sig) => {
  const idx = sig.indexOf('|')
  const file = sig.slice(0, idx)
  const needle = sig.slice(idx + 1)
  return !offenders.some((o) => o.name === file && o.code.includes(needle))
})
if (stale.length > 0) {
  // 豁免点消失（代码被改走）→ 也必须失败，否则豁免会烂在名单里
  console.log(`\n  豁免名单已过期（该处不再命中，请删除登记）：${stale.join(', ')}`)
  fail += 1
}
if (hard.length === 0 && stale.length === 0) {
  console.log(`  OK   无工具把自行切分的段数当行数用（豁免 ${BENIGN.size} 处已登记裁定）`)
} else if (hard.length > 0) {
  console.log(`\n  以上 ${hard.length} 处违反契约「任何工具要行数必须 import 它，不得自行实现」。`)
  console.log('  注意：末尾换行会让这种写法**多算 1 段**，而"净增长 ≤ 0"的闸门结论依赖这个数。')
  console.log('  两条出路：① 改成 import lib-lines（首选）；② 若确属良性，在 BENIGN 里登记并写明理由。')
}
if (hard.length > 0 || stale.length > 0) fail += 1

console.log(fail === 0 ? '\n[lib-lines] PASS：口径已钉住' : `\n[lib-lines] ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
