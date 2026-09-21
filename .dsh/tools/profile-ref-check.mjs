// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/profile-ref-check.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/profile-ref-check.mjs。
// 副本生成时间：2026-09-21T02:28:49.470Z
/**
 * profile-ref-check.mjs — 契约里用到的每个 `{{a.b}}` 占位符，是否都能在 `profile.yaml` 里解析
 *
 * ## 为什么需要它
 *
 * 契约把**项目专属取值**全部换成占位符（`{{paths.*}}` / `{{tech_stack.*}}` / `{{deploy.*}}`），
 * 由 `profile.yaml` 提供取值。这解决了"契约硬编码某项目字面量"的老问题，但**换来了一个新的失效模式**：
 *
 * **占位符解析不了时，契约不会报错，它会带着原文里的 `{{...}}` 继续跑。**
 * 后果比硬编码更隐蔽——硬编码至少是个真值（只是不对），未解析的占位符是**一句没有意义的话**，
 * 而判据会照常给出"通过/不通过"。
 *
 * 实测触发过一次：给 `deploy-standard.md` 新引入 `{{deploy.platforms}}` / `{{deploy.image_name}}`，
 * 而 `profile.yaml` 骨架里声明的键是 `deploy.arch` / `deploy.service`——**名字对不上，且没有任何东西会报错**。
 *
 * ## 判据
 *
 * 1. **未声明**：契约用了 `{{k}}`，但 `profile.yaml` 里没有对应的生效键 → **FAIL**（这是缺陷）
 * 2. **仅注释**：键只出现在注释骨架里（如"参考骨架：Java 服务类项目"段）→ **WARN**
 *    （对本项目不生效；消费项目按自己的技术栈填，不算缺陷）
 *
 * ## 用法
 *
 *   node .dsh/tools/profile-ref-check.mjs [--dir <项目根>] [--json]
 *
 * 退出码：有未声明占位符 ⇒ 1；只有 WARN 或无问题 ⇒ 0。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
function parseArgs(argv) {
  const a = { dir: resolve(HERE, '..', '..'), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = resolve(argv[++i]);
    else if (argv[i] === '--json') a.json = true;
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));

function walkMd(d) {
  const out = [];
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// ── 解析 profile.yaml 的键（缩进栈法；只需支持两层块映射，足够用）────────────
function profileKeys(text) {
  const active = new Set();
  const commented = new Set();
  const stack = []; // [{indent, name}]
  for (const raw of text.split('\n')) {
    const isComment = /^\s*#/.test(raw);
    const line = isComment ? raw.replace(/^\s*#\s?/, '') : raw;
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (!m) continue;
    const indent = m[1].length;
    const name = m[2];
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, name });
    const path = stack.map((s) => s.name).join('.');
    (isComment ? commented : active).add(path);
  }
  // 顶层名也算（如 `tech_stack`）
  return { active, commented };
}

const profilePath = join(args.dir, '.dsh', 'profile.yaml');
if (!existsSync(profilePath)) {
  console.error('[profile-ref] 找不到 ' + profilePath);
  process.exit(1);
}
const { active, commented } = profileKeys(readFileSync(profilePath, 'utf8'));

// ── 收集契约/skill 里的占位符 ───────────────────────────────────────────────
const ROOTS = [join(args.dir, '.dsh', 'contracts'), join(args.dir, '.dsh', 'contracts-research'), join(args.dir, '.dsh', 'skills')];
const used = new Map(); // key -> Set(file)
for (const root of ROOTS) {
  for (const f of walkMd(root)) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/\{\{([a-z_][a-z0-9_.]*)\}\}/gi)) {
      const k = m[1];
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(f.replace(args.dir, '').replace(/\\/g, '/').replace(/^\//, ''));
    }
  }
}

const missing = [];
const onlyComment = [];
for (const [k, files] of [...used].sort()) {
  if (active.has(k)) continue;
  // 允许父级已声明（如 `paths` 整体）
  const parent = k.split('.').slice(0, -1).join('.');
  if (parent && active.has(parent)) continue;
  if (commented.has(k) || (parent && commented.has(parent))) onlyComment.push([k, files]);
  else missing.push([k, files]);
}

if (args.json) {
  console.log(JSON.stringify({
    profile: profilePath.replace(args.dir, '').replace(/\\/g, '/'),
    total: used.size,
    missing: missing.map(([k, f]) => ({ key: k, files: [...f] })),
    only_comment: onlyComment.map(([k, f]) => ({ key: k, files: [...f] })),
  }, null, 2));
  process.exit(missing.length ? 1 : 0);
}

console.log('[profile-ref] ' + profilePath.replace(args.dir, '').replace(/\\/g, '/'));
console.log('  契约/skill 共用占位符 ' + used.size + ' 个');
console.log('  ✅ 已解析 ' + (used.size - missing.length - onlyComment.length) + ' 个');

if (onlyComment.length) {
  console.log('\n  🟡 WARN：只声明在注释骨架里（对本项目不生效，消费项目按自己技术栈填）');
  for (const [k, f] of onlyComment) console.log('     ' + k + '   ← ' + [...f].join(', '));
}

if (missing.length) {
  console.log('\n  ❌ FAIL：**未声明**——契约会带着原文的 {{...}} 继续跑，且不会报错');
  for (const [k, f] of missing) console.log('     ' + k + '   ← ' + [...f].join(', '));
  console.log('\n[profile-ref] FAIL：' + missing.length + ' 个占位符解析不了');
  process.exit(1);
}

console.log('\n[profile-ref] PASS：全部占位符都能在 profile.yaml 里解析');
