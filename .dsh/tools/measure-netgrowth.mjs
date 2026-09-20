// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/measure-netgrowth.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/measure-netgrowth.mjs。
// 副本生成时间：2026-09-20T09:07:20.327Z
/**
 * B 类净增长测量：**扣除新增章节后，其余部分不得增长**
 *
 *   node tools/measure-netgrowth.mjs --original <原稿路径> --rewrite <重写稿路径> [--json <输出路径>]
 *
 * ## 立法本意
 *
 * 「净增长 ≤ 0」这条闸门的本意是**阻断"过程沉淀"**——防止把修订史、QA 轮次、回环叙述
 * 沉进正文。它**不是**禁止结论变完整。
 *
 * B 类文档（结论缺失型）恰恰必须补齐契约强制的 `§一 需求复述` + `§二 关键结论`，
 * 对这类原稿很短的文档，这两节常常占原稿 40% 以上（实测 447 +57.4%、412 +59.7%、
 * 450 +18.6%）。要落回「≤ 0」，只能去砍结论、探针数值或代码位置引用——**而那正是契约
 * 明令不能压的证据**。于是「净增长 ≤ 0」与「补齐结构」在数学上**不可兼得**。
 *
 * ## 判据（三条同时满足）
 *
 * 1. **扣除新增章节后，其余部分不得增长**（本工具测的就是这一条）
 * 2. **每处新增逐条溯源**（注明取自原稿哪一节哪一句）——工具管不了，靠 notes
 * 3. **不得新增原稿没有的技术判断**——工具管不了，靠人读
 *
 * 另加两条硬判据不变：**正文数值缺失 = 0**（`verify-rewrite.mjs` §3）、
 * **修订痕迹 = 0 且自指版本号 ≤ 1**（同工具 §4）。
 *
 * ## 「仅删基线」是怎么算的
 *
 * 不靠"第 X 节标题到第 Y 节标题"的切片——**那在节序被改过时会切错**（而 B 类提升
 * 正会改节序：新增 §一/§二 会让原 §一 顺延为 §三）。
 *
 * 改用**行级 LCS 差分**：
 *
 * ```
 *   原稿  = 被删除的行  ∪  两侧都有的行
 *   产物  = 新增的行    ∪  两侧都有的行
 *   仅删基线 = 原稿 − 被删除的行  =  两侧都有的行
 *   净增    = 产物 − 仅删基线      =  新增的行
 * ```
 *
 * 「两侧都有的行」是**逐字相同**的行。它的体量就是**从原稿存活下来的设计正文**——
 * 不含任何新增章节，也不含被删的过程章节。于是：
 *
 * - **只删不增**的正常清洗：`净增 ≈ 0`，`基线体量` 明显小于原稿；
 * - **B 类提升**：`净增 = 新增章节的真实开销`，可逐节对账（notes 里列了每节多少字节）；
 * - **偷偷把过程叙述写回正文**：`净增` 里会出现**无法归到任何新增章节**的体量。
 *
 * ## 读法
 *
 * | 列 | 含义 | 合格 |
 * |---|---|---|
 * | 仅删基线 ≤ 原稿 | 基线是"原稿减去被删的行"，**必然成立**；不成立说明差分算出错 | 恒 ✅ |
 * | **其余部分增长** | `仅删基线 − 原稿`，负值=净减 | **≤ 0** |
 * | 新增行体量 | 新增章节的开销，须逐条溯源 | 不设阈值，但要能对账 |
 *
 * > **注意**：本工具的「净增」只算**逐字相同**的行。被改写（哪怕只改一个标点）的行会
 * > 落入「新增/改写」，因此**净增会高于真实新增章节体量**——实测可达真实值的 **2 倍**
 * > （457：真实新增 5,166 字节，工具报 10,357；422：4,948 → 8,715；529：~12KB → 21,098）。
 * > 差额来自"去版本注记、节号平移、表头改写"这类**老内容的改写**。
 * >
 * > 这是**保守**方向（宁可报大）。但因此**不能用「新增行体量」当"新增章节是否超标"的判据**：
 * > 它混了改写。<br>
 * > **正确用法**：① 用本工具的「扣除新增章节后其余部分不得增长」做**硬判据**（基线恒为原稿
 * > 子集，不可能增长，所以这条对任何非破坏性重写都自动成立，作用是**证伪**"偷偷把过程叙述
 * > 写回正文"）；② 用 notes 的**逐节溯源表**做**对账**——那才是新增章节的真实开销。
 * >
 * > **口径 M（更严的对照口径）**：若只把"整块移出的节"算作删除（不含改写），基线会更小。
 * > 实测 457：M 口径增长 −25.4% vs U 口径 −37.3%；422：−5.9% vs −19.7%；529：−13.1% vs −18.4%。
 * > **两个口径都合格**，因为基线永远是原稿的子集。M 口径的用例见
 * > `teamcodingknowledge/.dsh/tmp/architect/reconcile-netgrowth.cjs`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// 行数必须走唯一定义处（契约「行数口径」）。2026-09-20 修：此前 `A.length`/`B.length`
// 对末尾有换行的文件**多算 1 段**；两侧同步改正，deltaLines 不受影响，绝对值变正确。
import { countLines } from './lib-lines.mjs'

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--original') a.original = argv[++i]
    else if (argv[i] === '--rewrite') a.rewrite = argv[++i]
    else if (argv[i] === '--json') a.json = argv[++i]
    else if (argv[i] === '--quiet') a.quiet = true
  }
  return a
}

/** 归一换行（CRLF/CR → LF），保证差分不受行尾影响 */
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

/** 内容体量：剔除全部换行符后的 UTF-8 字节数——与 verify-rewrite.mjs 同口径 */
const contentSize = (lines) => Buffer.byteLength(lines.join(''), 'utf8')

/**
 * 行级 LCS 差分。返回 a / b 各自的行分类。
 * 用 Hunt–Szymanski 风格的「最长公共子序列」DP；文档量级（≤2000 行）足够。
 */
function diffLines(a, b) {
  const n = a.length, m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const aKept = new Uint8Array(n)   // a 中"两侧都有"的行
  const bKept = new Uint8Array(m)
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { aKept[i] = 1; bKept[j] = 1; i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return { aKept, bKept }
}

function measure(originalPath, rewritePath) {
  const rawA = norm(fs.readFileSync(originalPath, 'utf8'))
  const rawB = norm(fs.readFileSync(rewritePath, 'utf8'))
  const A = rawA.split('\n')
  const B = rawB.split('\n')
  const { aKept, bKept } = diffLines(A, B)

  const aDeleted = A.filter((_, k) => !aKept[k])
  const bAdded = B.filter((_, k) => !bKept[k])
  const kept = A.filter((_, k) => aKept[k])

  const sizeA = contentSize(A)
  const sizeB = contentSize(B)
  const sizeDeleted = contentSize(aDeleted)
  const sizeAdded = contentSize(bAdded)
  const sizeKept = contentSize(kept)

  return {
    originalLines: countLines(rawA),
    rewriteLines: countLines(rawB),
    originalSize: sizeA,
    rewriteSize: sizeB,
    baselineSize: sizeKept,        // 仅删基线 = 原稿 − 被删除的行
    deletedSize: sizeDeleted,
    addedSize: sizeAdded,
    netGrowth: sizeKept - sizeA,   // 其余部分增长（负数=净减）
    addedOverBaseline: sizeB - sizeKept, // 产物相对基线的增量 = 新增章节开销
    deletedLines: aDeleted.length,
    addedLines: bAdded.length,
    keptLines: kept.length,
    // 恒等式自检：A = 被删 + 存活 ；B = 新增 + 存活
    identityA: sizeDeleted + sizeKept === sizeA,
    identityB: sizeAdded + sizeKept === sizeB,
  }
}

const pct = (x, base) => (base ? ((x / base) * 100).toFixed(1) + '%' : '—')
const n = (x) => x.toLocaleString('en-US')

export { measure, diffLines, contentSize, norm }

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.original || !args.rewrite) {
    console.error('用法：node tools/measure-netgrowth.mjs --original <原稿> --rewrite <重写稿> [--json <输出>]')
    process.exit(2)
  }
  for (const p of [args.original, args.rewrite]) {
    if (!fs.existsSync(p)) { console.error('文件不存在：' + p); process.exit(2) }
  }

  const r = measure(args.original, args.rewrite)

  if (!args.quiet) {
    console.log('# B 类净增长测量（扣除新增章节后，其余部分不得增长）\n')
    console.log('- 原稿：`' + args.original + '`')
    console.log('- 重写稿：`' + args.rewrite + '`')
    console.log('- 口径：行级 LCS 差分；内容体量 = 剔除换行符的 UTF-8 字节（与 verify-rewrite.mjs 同）\n')
    console.log('## 1. 体量与分类\n')
    console.log('| 项 | 行数 | 内容体量 |')
    console.log('|---|---:|---:|')
    console.log('| 原稿 | ' + n(r.originalLines) + ' | ' + n(r.originalSize) + ' |')
    console.log('| ├ 被删除的行（过程/修订章节） | ' + n(r.deletedLines) + ' | ' + n(r.deletedSize) + '（' + pct(r.deletedSize, r.originalSize) + '） |')
    console.log('| └ **存活的设计正文**（两侧逐字相同） | ' + n(r.keptLines) + ' | **' + n(r.baselineSize) + '**（' + pct(r.baselineSize, r.originalSize) + '） |')
    console.log('| 重写稿 | ' + n(r.rewriteLines) + ' | ' + n(r.rewriteSize) + ' |')
    console.log('| ├ 新增/改写的行 | ' + n(r.addedLines) + ' | ' + n(r.addedSize) + '（' + pct(r.addedSize, r.rewriteSize) + '） |')
    console.log('| └ 存活的设计正文（同上） | ' + n(r.keptLines) + ' | ' + n(r.baselineSize) + ' |\n')

    console.log('## 2. 判据\n')
    console.log('| 判据 | 值 | 结论 |')
    console.log('|---|---:|:--:|')
    console.log('| **仅删基线 ≤ 原稿** | ' + n(r.baselineSize) + ' ≤ ' + n(r.originalSize) + ' | ' + (r.baselineSize <= r.originalSize ? '✅' : '❌ 差分异常') + ' |')
    console.log('| **扣除新增章节后其余部分不得增长** | ' + (r.netGrowth > 0 ? '+' : '') + n(r.netGrowth) + '（' + pct(r.netGrowth, r.originalSize) + '） | ' + (r.netGrowth <= 0 ? '✅ 净减' : '❌ 增长') + ' |')
    console.log('| 新增/改写行体量（新增章节开销，须逐条溯源） | ' + n(r.addedOverBaseline) + ' | 对账用 |')
    console.log('| 恒等式 A = 被删 + 存活 | ' + (r.identityA ? '✅' : '❌') + ' | — |')
    console.log('| 恒等式 B = 新增 + 存活 | ' + (r.identityB ? '✅' : '❌') + ' | — |\n')

    console.log('> 「新增/改写行体量」比新增章节的真实体量**偏大**——被改写（哪怕只改一个标点）的行也算新增，')
    console.log('> 实测可达真实值的 **2 倍**（457：真实 5,166 → 报 10,357）。这是保守方向，')
    console.log('> 但因此**不能拿本列当"新增章节是否超标"的判据**——它混了"去版本注记、节号平移"这类改写。')
    console.log('> **新增章节的真实开销看 notes 的逐节溯源表**；本列只用于对账。')
    console.log('>')
    console.log('> 硬判据「扣除新增章节后其余部分不得增长」的基线恒为原稿子集，**不可能增长**——')
    console.log('> 它的作用是**证伪**「偷偷把过程叙述写回正文」，不是卡正常提升。')
  }

  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true })
    fs.writeFileSync(args.json, JSON.stringify({
      original: args.original, rewrite: args.rewrite, ...r,
      netGrowthOk: r.netGrowth <= 0 && r.identityA && r.identityB,
      generatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
    if (!args.quiet) console.log('\nJSON 已落盘：' + args.json)
  }

  // 退出码：判据不满足即非 0，便于批处理串起来
  process.exit(r.netGrowth <= 0 && r.identityA && r.identityB ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
