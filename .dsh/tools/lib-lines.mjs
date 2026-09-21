// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/lib-lines.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/lib-lines.mjs。
// 副本生成时间：2026-09-21T02:28:49.470Z
/**
 * lib-lines.mjs — **行数与体量口径的唯一定义处**（零模型参与）
 *
 * ## 为什么必须有这个文件
 *
 * 实测：调研模式的停止条件**依赖行数**（`analysis-standard.md`「QA 每轮会记录三个数：行数 /
 * 字节数 / 修订痕迹命中数」），而两份契约集全文检索**行数口径零命中**——**判据用的数没有定义**。
 * 同一个文件在不同工具下会量出不同的行数：
 *
 *   - Python `len(f.read().splitlines())`    → 不数末尾空行，且把 `\r\n` 当一处分隔
 *   - Node `text.split('\n').length`         → 末尾换行会多算一段
 *   - PowerShell `Measure-Object -Line`      → **跳过空行**，与上面两个都不同
 *
 * 于是"净增长 ≤ 0"这条闸门会**因为换了工具而改变结论**。这是判据结构缺陷，不是实现 bug。
 *
 * ## 口径（2026-09-18 裁决）
 *
 * > **行数 = UTF-8 解码后按 `\n` 切分得到的段数。**
 *
 * - 统一按 `\n` 切分；`\r\n` 先把 `\r` 去掉，不额外算一段。
 * - **不跳过空行**（空行也是行——它是文档结构的一部分）。
 * - 末尾若有换行，**不额外算一段**（`a\nb\n` 是 2 行，不是 3）。
 * - 先做 UTF-8 解码；**不用平台默认编码**（Windows 上会把中文按 GBK 解出乱码，行数不变但字符串比较全错）。
 *
 * ## 用法
 *
 *   import { countLines, countBytes, measure } from './lib-lines.mjs'
 *   countLines(text)            // 行数（按上述口径）
 *   countBytes(text)            // 字节数 = UTF-8 编码后的字节长度
 *   measure(text)               // { lines, bytes, chars }
 *
 * 其他工具要行数**必须 import 本模块**，不得自行实现——口径分叉是本文件存在的理由。
 *
 * ## 自检（`--self-test`）
 *
 *   node .dsh/tools/lib-lines.mjs --self-test
 *
 * **自检随本文件一起交付**，这是有意的：口径用例是**判据的一部分**，不是模式仓库的私产。
 * 把对照测试留在模式仓库的 `tests/` 下，会让交付到项目里的契约引用一个**目标项目不存在**的路径
 * ——那正是"交付件必须自包含"要排除的情况。
 */

import { readFileSync } from 'node:fs'

/** 字节数：UTF-8 编码后的字节长度（不是字符数） */
export function countBytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** 字符数：Unicode 码点数量（非 UTF-16 单元数） */
export function countChars(text) {
  return [...text].length
}

/**
 * 行数 = UTF-8 解码后按 `\n` 切分的段数。
 * 末尾换行不额外算一段；`\r\n` 归一为 `\n`；空行照数。
 */
export function countLines(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized === '') return 0
  const segments = normalized.split('\n')
  // 末尾换行产生的空段不算一行
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop()
  return segments.length
}

/** 一次拿到三个数（契约里说的"三个数"）。 */
export function measure(text) {
  const s = String(text)
  return { lines: countLines(s), bytes: countBytes(s), chars: countChars(s) }
}

/** 从文件读数（按 UTF-8 解码，绝不使用平台默认编码）。 */
export function measureFile(path) {
  return measure(readFileSync(path, 'utf8'))
}

// ── 自检：钉住口径 ──────────────────────────────────────────────────────────
// 目的**不是"库能跑"**，而是**把口径钉死**：一旦有人改了 countLines 的语义，
// 依赖"净增长 ≤ 0"的闸门结论就会变，必须在这里被挡住。
// 同时把「三种常见实现量出三个数」固化成常驻对照证据——那正是当初判据失效的根因。
if (process.argv.includes('--self-test')) {
  let fail = 0
  const eq = (name, got, want) => {
    const ok = got === want
    if (!ok) fail += 1
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}  期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
  }

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

  console.log('\n对照证据：同一份文本，三种实现量出的"行数"不同')
  const sample = 'a\n\nb\n'
  const mine = countLines(sample)
  const naiveSplit = sample.split('\n').length
  const psLike = sample.replace(/\r\n/g, '\n').split('\n').filter((s) => s.trim() !== '').length
  console.log(`  文本 ${JSON.stringify(sample)}`)
  console.log(`  本口径              ${mine}   ← a / 空行 / b`)
  console.log(`  split('\\n').length  ${naiveSplit}   ← 末尾换行多算一段`)
  console.log(`  跳过空行（PS -Line） ${psLike}   ← 空行被吃掉`)
  if (!(mine === 3 && naiveSplit === 4 && psLike === 2)) {
    fail += 1
    console.log('  FAIL 三种实现应当给出三个不同的数（这正是"净增长 ≤ 0"会因换工具而改变结论的原因）')
  }

  console.log('\nmeasure() 一次给出契约所说的"三个数"')
  const m = measure('第一行\n第二行\n')
  console.log(`  ${JSON.stringify(m)}`)
  eq('lines', m.lines, 2)
  eq('bytes', m.bytes, Buffer.byteLength('第一行\n第二行\n', 'utf8'))
  // 8 = 第一行(3) + \n(1) + 第二行(3) + \n(1)。**字符数把换行也算进去**，与行数不是一回事。
  eq('chars', m.chars, 8)

  console.log(fail === 0 ? '\n[lib-lines] PASS：口径已钉住' : `\n[lib-lines] ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}
