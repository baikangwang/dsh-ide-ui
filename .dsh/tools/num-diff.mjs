// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/num-diff.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/num-diff.mjs。
// 副本生成时间：2026-09-20T09:07:20.327Z
/**
 * num-diff.mjs — 原稿 vs 重写稿的数值指纹全量对撞（比 verify-rewrite.mjs 更细的粒度）
 *
 * 判据来源：architect/design-standard.md 「压缩粒度边界」
 *   必须逐字保留：端口、文件大小与字节数、计数、时间戳（含 nanos）、PID、epoch、
 *                百分比、耗时、SHA256 前缀、inode、判定结论的那几行输出
 *
 * 用法：
 *   node num-diff.mjs --original <原稿> --rewrite <重写稿> [--out <目录>]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { countLines } from './lib-lines.mjs'

/** 每类指纹一条规则；捕获组 1 为"值"，用于逐字比对 */
const RULES = [
  { key: 'epoch',      re: /\b(1[6-9]\d{8}|2\d{9})\b/g,                       desc: 'epoch 秒（10 位）' },
  { key: 'nanos',      re: /\.(\d{9})\b/g,                                    desc: '时间戳纳秒小数位' },
  { key: 'mtime_date', re: /(20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g, desc: '日期时间' },
  { key: 'bytes',      re: /(\d{3,7})\s*(?:字节|bytes?|B\b)/g,                desc: '字节数' },
  { key: 'pid',        re: /(?:PID|pid|进程(?:号)?)\D{0,12}(\d{3,7})/g,       desc: 'PID' },
  { key: 'port',       re: /(?<![\d.])(\d{2,5})(?=\s*(?:\/\s*tcp|端口|port|\bTCP_))/gi, desc: '端口（带上下文词）' },
  { key: 'sha',        re: /([0-9a-f]{12,64})/g,                              desc: 'SHA256 前缀/哈希' },
  { key: 'inode',      re: /inode\D{0,6}(\d{4,12})/gi,                        desc: 'inode' },
  { key: 'pct',        re: /(\d+(?:\.\d+)?)\s*%/g,                            desc: '百分比' },
  { key: 'elapsed',    re: /(\d+(?:\.\d+)?)\s*(?:ms|毫秒|s\b|秒)\b/g,         desc: '耗时' },
  { key: 'counts',     re: /(?:共|计|合计|总数|行数|条|处|项|个(?:文件)?)\s*[：:=]?\s*(\d{1,6})/g, desc: '计数（带量词）' },
  { key: 'lines',      re: /(\d{2,5})\s*行/g,                                 desc: '行数' },
  { key: 'range',      re: /(?:L|:)(\d{2,5})\s*[-–~]\s*(\d{2,5})/g,           desc: '行号区间' },
  { key: 'allnum3',    re: /\b(\d{3,7})\b/g,                                  desc: '3–7 位整数（兜底）' },
]

function collect(text, r) {
  const hits = new Map()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const re = new RegExp(r.re.source, r.re.flags)
    let m
    while ((m = re.exec(l)) !== null) {
      const val = m[1] + (m[2] !== undefined ? `-${m[2]}` : '')
      if (!hits.has(val)) hits.set(val, [])
      const arr = hits.get(val)
      if (arr.length < 6) arr.push({ line: i + 1, text: l.trim().slice(0, 160) })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return hits
}

function main() {
  const argv = process.argv.slice(2)
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
  const origPath = get('--original'), rewPath = get('--rewrite')
  const outDir = get('--out')
  if (!origPath || !rewPath) { console.error('用法：--original <原稿> --rewrite <重写稿> [--out <目录>]'); process.exit(2) }

  const orig = readFileSync(origPath, 'utf8')
  const rew = readFileSync(rewPath, 'utf8')

  const report = []
  report.push('# 数值指纹对撞报告（全量粒度）')
  report.push('')
  report.push(`> 原稿：\`${origPath}\`（${countLines(orig)} 行 / ${Buffer.byteLength(orig)} B）`)
  report.push(`> 重写稿：\`${rewPath}\`（${countLines(rew)} 行 / ${Buffer.byteLength(rew)} B）`)
  report.push(`> 判据：architect/design-standard.md「压缩粒度边界」——**可以压排版，不能压证据**`)
  report.push('')
  report.push('| 指纹族 | 原稿 | 重写稿 | 原稿有而重写缺 |')
  report.push('|---|---:|---:|---:|')
  const missingAll = []
  for (const r of RULES) {
    const a = collect(orig, r), b = collect(rew, r)
    const missing = [...a.keys()].filter((k) => !b.has(k))
    report.push(`| ${r.key}（${r.desc}） | ${a.size} | ${b.size} | **${missing.length}** |`)
    if (missing.length) missingAll.push({ rule: r, missing, a })
  }

  report.push('')
  report.push('## 逐条明细（原稿有、重写稿缺）')
  report.push('')
  for (const { rule, missing, a } of missingAll) {
    report.push(`### ${rule.key} — ${rule.desc}（${missing.length} 条）`)
    report.push('')
    for (const v of missing) {
      const occ = a.get(v)
      report.push(`- **\`${v}\`**`)
      for (const o of occ) report.push(`  - 原 L${o.line}：${o.text}`)
    }
    report.push('')
  }

  const text = report.join('\n')
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    const p = join(outDir, 'num-diff.md')
    writeFileSync(p, text, 'utf8')
    console.log(`报告：${p}`)
  }
  process.stdout.write(text + '\n')
}

main()
