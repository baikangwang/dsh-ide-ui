// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/measure-section-growth.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/measure-section-growth.mjs。
// 副本生成时间：2026-09-20T09:07:20.327Z
/**
 * measure-section-growth.mjs — B 类「净增长」的**逐节对账**器（零模型参与）
 *
 *   node tools/measure-section-growth.mjs --original <原稿路径> --rewrite <重写稿路径>
 *     --new "<新增节名关键词>" ...          # 可重复：声明哪些二级节是**新增章节**
 *     --dissolved "<被并入的原稿节名>" ...   # 可重复：声明哪些原稿节的内容**被并进了新增节**
 *     --moved-to "<节名>=<字符数>" ...       # 可重复：声明某保留节因**承接迁入**而长了多少
 *     --remap "<原节名>=<产出节名>|<承接迁入数>" ...  # 可重复：声明该节在产出里改了名/号
 *
 * ## ⚠️ 这一列的用途：**只用于对账，不作判据**
 *
 * 本工具的判定列是**对账用**的，与 `measure-netgrowth.mjs` 的 `addedOverBaseline` 列同性质。
 * **权威判据是 `measure-netgrowth.mjs`**（行级 LCS 差分，直接算"存活行体量"，
 * 不需要你申报任何东西）。本工具**不替代它**，两者应当**互相印证**：
 *
 *   · 若两工具结论一致 → 放心；
 *   · 若不一致 → 优先信 `measure-netgrowth.mjs`，本工具的差异提示"你漏申报了某个迁移"。
 *
 * 为什么还需要本工具：`measure-netgrowth.mjs` 回答"**总共**新增了多少"，
 * 本工具回答"**新增长在哪个节上**、以及每个保留节各自有没有变长"。
 * 后者是**归因**，前者是**总量**。归因要靠人申报"这段是从别处搬来的"，所以它只配做对账。
 *
 * ## 与 measure-netgrowth.mjs 的口径差异（会导致两者对不上，属正常）
 *
 *   1. 本工具按**二级标题切段**；若改造过程中重排/改名/换行，切段边界会变；
 *   2. 本工具算的是"该节区间内的字符数"，**不区分**这一节里哪些是原句、哪些是新句；
 *   3. 本工具依赖 `--dissolved` / `--moved-to` / `--remap` 的**人工申报**——
 *      **漏申报 = 假增长**，误申报 = 假通过。这是它只能作对账的根本原因。
 *
 * ## 为什么要有这个工具（来自 7 份 B 类实测）
 *
 * B 类「提升（Hoist & Locate）」会把原稿的 §零/§一/§二 **并进**新增的 §一/§二。
 * 如果只算总量，会把"内容搬家"与"内容新增"混在一起，于是造出一批**伪例外**。
 * 本工具把两者拆开：
 *
 *     保留节合计（原稿 → 产出）      ← 判据盯的是这一行
 *     dissolved 迁入 N 字符 → 新增节 M 字符，净新增 M−N
 *
 * 实测：492 保留节真实差 −3、497 逐字节 +0、493 因两份实施清单合并 −125。
 *
 * ## 局限（务必知道）
 *
 *   · 它**不是**零丢失校验器——数值/痕迹/版本/凭空新增请跑 `verify-rewrite.mjs`；
 *   · 它**不判断**申报是否诚实——申报内容要人复核；
 *   · **不判断"该不该新增"**——`--new` 只是告诉它哪些节是新增，不问为什么新增。
 */
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * 按二级标题切段并统计内容字符数。
 *
 * ⚠️ **必须归一换行**：存量原稿多为纯 CRLF，而重写稿为纯 LF。
 * 若不正则化，行尾残留的 `\r` 会让 `/^##\s/`、`/^#{2,4}\s/` 这类行尾锚正则**全部失配**，
 * 于是"按节切分"静默退化成"整篇一节"——**不报错的错判**。
 * 实测 492 原稿 214 个 CRLF，未归一化时 `/^##\s+/` 匹配 0 行。
 */
function sections(p) {
  const lines = readFileSync(p, 'utf8').replace(/\r\n?/g, '\n').split('\n')
  const out = {}
  let cur = '__前缀(标题与头部)__'
  out[cur] = []
  for (const l of lines) {
    const m = l.match(/^##(?!#)\s+(.*)$/)
    if (m) { cur = m[1].trim(); out[cur] = out[cur] || []; continue }
    out[cur].push(l)
  }
  const r = {}
  for (const [k, v] of Object.entries(out)) r[k] = v.join('\n').replace(/[\r\n]/g, '').length
  return r
}

function parseArgs(argv) {
  const pos = []
  const flag = (name) => {
    const o = []
    argv.forEach((a, i) => { if (a === name && argv[i + 1] !== undefined) o.push(argv[i + 1]) })
    return o
  }
  for (const a of argv) if (!a.startsWith('--')) pos.push(a)
  return {
    origPath: pos[0],
    newPath: pos[1],
    newKeys: flag('--new'),
    dissolvedKeys: flag('--dissolved'),
    movedKeys: flag('--moved-to'),
    remapKeys: flag('--remap'),
    jsonPath: flag('--json')[0],
  }
}

const norm = (s) => s.replace(/[（(].*$/, '').trim()

function run() {
  const { origPath, newPath, newKeys, dissolvedKeys, movedKeys, remapKeys, jsonPath } = parseArgs(process.argv.slice(2))
  if (!origPath || !newPath) {
    console.error('用法: node tools/measure-section-growth.mjs --original <原稿> --rewrite <重写稿>')
    console.error('      [--new "<新增节名>"]... [--dissolved "<被并入的原稿节>"]...')
    console.error('      [--moved-to "<保留节名>=<承接迁入字符数>"]... [--remap "<原节>=<产出节>|<承接迁入数>"]...')
    process.exit(2)
  }

  const a = sections(origPath)
  const b = sections(newPath)

  const isNew = (k) => newKeys.some((n) => k.includes(n))
  const isDissolved = (k) => dissolvedKeys.some((n) => k.includes(n))

  const movedAllow = {}
  for (const m of movedKeys) { const i = m.lastIndexOf('='); movedAllow[m.slice(0, i)] = Number(m.slice(i + 1)) }

  const remap = []
  for (const m of remapKeys) {
    const eq = m.indexOf('=')
    const rhs = m.slice(eq + 1)
    const bar = rhs.lastIndexOf('|')
    remap.push({
      from: m.slice(0, eq),
      out: bar < 0 ? rhs : rhs.slice(0, bar),
      allow: bar < 0 ? 0 : Number(rhs.slice(bar + 1)),
    })
  }
  const findRemap = (k) => remap.find((r) => k.includes(r.from))

  console.log('=== 逐节内容字符核算（**对账用，不作判据**；权威判据见 measure-netgrowth.mjs）===\n')

  console.log('【保留节】（判据盯这一段：真实差应 ≤ 0）')
  let keptOrig = 0, keptNew = 0, keptNewAdj = 0
  const realLoss = []
  const kept = []
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith('__')) continue
    if (isDissolved(k)) continue
    if (isNew(k)) continue

    let nk = Object.keys(b).find((x) => x === k)
    if (!nk) nk = Object.keys(b).find((x) => norm(x) === norm(k))
    const rm = findRemap(k)
    if (!nk && rm) nk = Object.keys(b).find((x) => x.includes(rm.out))
    if (!nk) { realLoss.push(k); console.log('  ❌真缺失 ' + String(v).padStart(7) + '            ' + k.slice(0, 50)); continue }

    const now = b[nk]
    const movedHit = Object.keys(movedAllow).find((n) => k.includes(n))
    const allow = (rm ? rm.allow : 0) + (movedHit ? movedAllow[movedHit] : 0)
    const d = now - v
    const eff = d - allow

    keptOrig += v; keptNew += now; keptNewAdj += (now - allow)
    kept.push({ from: k, to: nk, orig: v, now, delta: d, declared: allow, real: eff })

    console.log('  ' + (eff > 0 ? '⚠️变长' : '✅   ') + ' ' + String(v).padStart(7) + ' → ' + String(now).padStart(7)
      + '  ' + String(d >= 0 ? '+' + d : d).padStart(7)
      + (allow ? '  (申报承接迁入 ' + allow + ' → 真实 ' + (eff >= 0 ? '+' + eff : eff) + ')' : '')
      + '   ' + k.slice(0, 34) + (nk !== k ? '  →  ' + nk.slice(0, 18) : ''))
  }

  console.log('\n【被并入新增节的节（--dissolved，不算丢失）】')
  let dissolvedTotal = 0
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith('__') || !isDissolved(k)) continue
    dissolvedTotal += v
    console.log('  ↪ ' + String(v).padStart(7) + '            ' + k.slice(0, 50))
  }

  console.log('\n【新增节】')
  let addedTotal = 0
  for (const [k, v] of Object.entries(b)) {
    if (k.startsWith('__') || !isNew(k)) continue
    addedTotal += v
    console.log('  ＋' + String(v).padStart(7) + '            ' + k.slice(0, 50))
  }

  console.log('\n=== 结论（对账） ===')
  console.log('  保留节：原稿 ' + keptOrig + ' → 产出 ' + keptNew + '   差 ' + (keptNew - keptOrig >= 0 ? '+' : '') + (keptNew - keptOrig))
  console.log('  扣除申报的承接迁入后：' + keptNewAdj + '   真实差 ' + (keptNewAdj - keptOrig >= 0 ? '+' : '') + (keptNewAdj - keptOrig))
  console.log('  dissolved 迁入 ' + dissolvedTotal + ' 字符 → 新增节 ' + addedTotal + '，净新增 ' + (addedTotal - dissolvedTotal))
  console.log('  真缺失节：' + (realLoss.length ? realLoss.join(' / ') : '无'))

  const ok = (keptNewAdj - keptOrig) <= 0 && realLoss.length === 0
  console.log('\n  ➜ 保留节' + (keptNewAdj - keptOrig <= 0 ? '未变长 ✅' : '变长 ❌') + '；无真缺失节 ' + (realLoss.length === 0 ? '✅' : '❌'))
  console.log('  ➜ B 类判据（扣除新增章节后其余部分不得增长）：' + (ok ? '✅ 满足' : '❌ 不满足'))
  console.log('\n  ⚠️ 本列只用于对账，不作判据。权威判据请再跑一次：')
  console.log('     node tools/measure-netgrowth.mjs --original ' + origPath + ' --rewrite ' + newPath)
  console.log('     两者不一致时**以 measure-netgrowth.mjs 为准**，并回来检查是否有迁移漏申报。')

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({
      note: '对账用，不作判据；权威判据见 measure-netgrowth.mjs',
      original: origPath, rewrite: newPath,
      keptOrig, keptNew, keptNewAdj,
      keptRealDelta: keptNewAdj - keptOrig,
      dissolvedTotal, addedTotal, addedOverBaseline: addedTotal - dissolvedTotal,
      realLoss, kept,
    }, null, 2), 'utf8')
    console.log('\n  （JSON 已写 ' + jsonPath + '）')
  }

  return ok ? 0 : 1
}

process.exit(run())
