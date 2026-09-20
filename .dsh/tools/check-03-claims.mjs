#!/usr/bin/env node
/**
 * `docs/03-实施记录.md` 的**数据正确性**核验器。
 *
 * 与"缺失值扫描"的根本区别：本工具**不比对旧稿**，只问一件事——
 * **文档现在写的数字，跟文件现在真实的样子，对得上吗？**
 * 这是 `design-standard.md` 准则二的要求："每个数字标注来源、时间、环境"，
 * 以及用户诉求里的「**数据正确**」。
 *
 * ⚠️ 本工具本身也遵守那条纪律：**每个断言都打印它读的是哪个文件，
 * 并给出权威口径的出处**——否则它自己就是一条悬空的结论。
 *
 * 用法：node tools/check-03-claims.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { countLines } from './lib-lines.mjs'

const DOC = 'D:/working/projects/agent-mode/docs/03-实施记录.md'
const PRESET = join(process.env.USERPROFILE, '.dsh', '.agent-presets')
const doc = readFileSync(DOC, 'utf8').replace(/\r\n?/g, '\n')

let pass = 0, fail = 0
const row = (label, claimed, actual, src) => {
  const ok = String(claimed) === String(actual)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(38)} 文档 ${String(claimed).padStart(9)}   实测 ${String(actual).padStart(9)}   （${src}）`)
}

// ── 权威 persona 计数：走 dsh-persona 的 Config 解析路径（YAML 解析后取 .length）
const npxCache = join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')
const cands = []
for (const e of readdirSync(npxCache)) {
  const d = join(npxCache, e, 'node_modules', '@deepseek-ai', 'dsh-persona')
  try {
    const pj = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
    cands.push({ m: statSync(d).mtimeMs, url: 'file:///' + join(d, 'lib', 'index.js').replaceAll('\\', '/'), dir: d, v: pj.version })
  } catch {}
}
cands.sort((a, b) => b.m - a.m)
let mod = null, best = null
const errs = []
for (const c of cands) { try { mod = await import(c.url); best = c; break } catch (e) { errs.push(c.dir) } }
let counts = null
if (mod) {
  const { parse } = createRequire(join(best.dir, 'package.json'))('yaml')
  counts = {}
  for (const id of ['agile', 'agile-research']) {
    const d = parse(readFileSync(join(PRESET, id, 'agent.cordis.yml'), 'utf8'))
    const r = d.find((x) => x && x.name === '@deepseek-ai/dsh-persona')
    const v = mod.Config(r.config)
    counts[id] = { prefix: v.prefix.length, suffix: (v.suffix ?? '').length }
  }
}

const fileStat = (p) => {
  const b = readFileSync(p)
  const t = b.toString('utf8').replace(/\r\n?/g, '\n')
  return {
    bytes: b.length, lines: countLines(t),
    sha16: createHash('sha256').update(b).digest('hex').toUpperCase().slice(0, 16),
    bom: b[0] === 0xEF, crlf: b.includes(Buffer.from('\r\n')),
  }
}
// 从文档 §一 表格单元格取声称值（去逗号与反引号）
const cell = (rowLabel, col) => {
  const re = new RegExp('^\\|\\s*' + rowLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|([^|]*)\\|([^|]*)\\|', 'm')
  const m = doc.match(re)
  if (!m) return null
  return m[col].replace(/[`,]/g, '').trim()
}

console.log(`  ══ 核验 ${DOC} ══`)
console.log(`  权威计数口径：dsh-persona Config 解析后的 prefix.length（YAML 解析后）`)
console.log(`  实现：直接 import ${best ? best.dir.replace(/\\/g, '/') : '(未找到 dsh-persona)'}\n`)

if (!counts) {
  console.log('  ⚠️ 无法 import dsh-persona，跳过 persona 计数核验（不报通过）')
} else {
  row('agile agent.cordis.yml 行数', cell('`agent.cordis.yml` 行数', 1), fileStat(join(PRESET, 'agile', 'agent.cordis.yml')).lines, '实测')
  row('agile-research ... 行数', cell('`agent.cordis.yml` 行数', 2), fileStat(join(PRESET, 'agile-research', 'agent.cordis.yml')).lines, '实测')
  row('agile 字节', cell('`agent.cordis.yml` 字节', 1), fileStat(join(PRESET, 'agile', 'agent.cordis.yml')).bytes, '实测')
  row('agile-research 字节', cell('`agent.cordis.yml` 字节', 2), fileStat(join(PRESET, 'agile-research', 'agent.cordis.yml')).bytes, '实测')
  row('agile SHA256(16)', cell('SHA256（前 16 位）', 1).replace(/[`]/g, ''), fileStat(join(PRESET, 'agile', 'agent.cordis.yml')).sha16, '实测')
  row('agile-research SHA256(16)', cell('SHA256（前 16 位）', 2).replace(/[`]/g, ''), fileStat(join(PRESET, 'agile-research', 'agent.cordis.yml')).sha16, '实测')
  row('agile persona prefix 字符数', cell('persona prefix 字符数', 1), counts.agile.prefix, 'YAML 解析后 .length')
  row('agile-research persona prefix', cell('persona prefix 字符数', 2), counts['agile-research'].prefix, 'YAML 解析后 .length')
  row('agile persona suffix 字符数', cell('persona suffix 字符数', 1), counts.agile.suffix, 'YAML 解析后 .length')
  row('agile-research persona suffix', cell('persona suffix 字符数', 2), counts['agile-research'].suffix, 'YAML 解析后 .length')
}
// §1.1 历史表「当前」行
const cur = doc.match(/\|\s*\*\*当前\*\*（含 §6\.2 补强，见 §一）\s*\|\s*`(\d+) chars`\s*\/\s*`(\d+) chars`\s*\|/)
if (cur && counts) {
  row('§1.1 历史表「当前」agile', cur[1], counts.agile.prefix, 'YAML 解析后 .length')
  row('§1.1 历史表「当前」research', cur[2], counts['agile-research'].prefix, 'YAML 解析后 .length')
} else if (!cur) { console.log('  ❌ 未找到 §1.1 历史表「当前」行'); fail++ }

// §一 编码/行尾 声称
const enc = doc.match(/^\|\s*编码 \/ 行尾\s*\|([^|]*)\|([^|]*)\|/m)
if (enc) {
  const want = enc[1].trim()
  const s = fileStat(join(PRESET, 'agile', 'agent.cordis.yml'))
  row('agile 声称编码/行尾匹配', want, `UTF-8 ${s.bom ? 'BOM' : '无 BOM'} / ${s.crlf ? 'CRLF' : 'LF'}`, '实测')
}

console.log(`\n  ➜ 通过 ${pass} / 失败 ${fail}`)
console.log(`  ➜ 判定：${fail === 0 ? '文档声称值与真实文件一致' : '**文档存在与真实文件不符的数字**'}`)
process.exit(fail === 0 ? 0 : 1)
