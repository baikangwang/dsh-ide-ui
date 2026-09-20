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

console.log(fail === 0 ? '\n[lib-lines] PASS：口径已钉住' : `\n[lib-lines] ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
