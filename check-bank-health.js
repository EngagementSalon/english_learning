// v107 题库体检脚本（防回归）
// 用途：一次性扫描「本地上传库 + 云端 upq + 种子题库」，报出所有会被渲染成
//       「空白选项」的题，以及答案指向空槽 / 有效选项不足的畸形题。
//      发版前跑一次，或怀疑题库脏了时跑。
//
// 用法（在 quiz-unified/ 目录下）：
//   node check-bank-health.js                    # 只查本地文件（种子题库 + 上传库快照）
//   node check-bank-health.js --cloud            # 额外拉云端 upq（只读，不改）
//   node check-bank-health.js --fetch-doc <url>  # 从指定同步文档地址拉快照
//
// 退出码：0 = 健康；1 = 发现需要清理的题。
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const DIR = __dirname

// ---------- v107 空槽裁尾口径（与 app.js visibleOptionIndexes 完全一致）----------
function visibleOptionIndexes(options) {
  const arr = Array.isArray(options) ? options : []
  let end = arr.length
  while (end > 0 && String(arr[end - 1] == null ? '' : arr[end - 1]).trim() === '') end--
  const out = []
  for (let i = 0; i < end; i++) out.push(i)
  return out
}
const NEED_OPTS = ['single', 'judge', 'multiple', 'pronounce', 'listen', 'voicematch']
const isBlank = o => String(o == null ? '' : o).trim() === ''

let problems = 0
function scanBank(label, list, mapQ) {
  const qs = Array.isArray(list) ? list : []
  if (!qs.length) { console.log(`\n[${label}] 无题目，跳过`); return }
  let tailBad = [], midBad = [], fewOpt = [], ansBad = [], emptyStem = []
  qs.forEach((raw, idx) => {
    const q = mapQ ? mapQ(raw) : raw
    const id = q && (q.id != null ? q.id : ('#' + (idx + 1)))
    const type = String((q && q.type) || '')
    if (!q || !String(q.question || '').trim()) emptyStem.push(id)
    const opts = Array.isArray(q && q.options) ? q.options : []
    if (type === 'fill' || type === 'translate') return          // 填空题 options=[参考答案]
    const vis = visibleOptionIndexes(opts)
    if (vis.length !== opts.length) tailBad.push(`${id}(${type}) ${opts.length}→${vis.length}`)
    const mid = opts.map((o, i) => (isBlank(o) && i < vis.length ? i : -1)).filter(i => i >= 0)
    if (mid.length) midBad.push(`${id}(${type}) 空槽下标=[${mid.join(',')}]`)
    if (NEED_OPTS.indexOf(type) >= 0 && vis.length < 2) fewOpt.push(`${id}(${type}) 有效选项=${vis.length}`)
    const ans = Array.isArray(q.answer) ? q.answer : []
    if (NEED_OPTS.indexOf(type) >= 0) {
      const bad = ans.filter(i => opts[i] == null || isBlank(opts[i]))
      if (bad.length) ansBad.push(`${id}(${type}) 答案指向空槽=[${bad.join(',')}]`)
      if (!ans.length) ansBad.push(`${id}(${type}) 无答案`)
    }
  })
  const total = qs.length
  console.log(`\n[${label}] 共 ${total} 题`)
  const report = (name, arr, limit) => {
    const n = arr.length
    console.log(`  ${n === 0 ? 'OK  ' : 'BAD '}${name}: ${n}`)
    arr.slice(0, limit || 5).forEach(s => console.log(`        · ${s}`))
    if (n > (limit || 5)) console.log(`        … 还有 ${n - (limit || 5)} 条`)
    return n
  }
  // 尾部空槽 = 本次要清理的目标（会渲染成空白选项）
  problems += report('尾部空槽（会渲染成空白选项，v107 自动清理）', tailBad, 8)
  problems += report('中间空槽（保留原下标，仅提示）', midBad, 5)
  problems += report('有效选项 < 2 的选择题（会被降级成填空）', fewOpt, 5)
  problems += report('答案指向空槽 / 无答案', ansBad, 8)
  problems += report('题干为空', emptyStem, 5)
}

// ---------- 1. 种子题库 ----------
try {
  const bankSrc = fs.readFileSync(path.join(DIR, 'bank-data.js'), 'utf8')
  const sb = { console, window: {} }
  vm.createContext(sb)
  vm.runInContext(bankSrc + '\n;globalThis.__BANK = BANK', sb)
  const BANK = sb.__BANK
  scanBank('种子题库 bank-data.js（BANK.questions）', BANK && BANK.questions, q => q)
} catch (e) { console.log('种子题库读取失败:', e.message) }

// ---------- 2. 云端快照 _doc.json（若存在）----------
const snap = path.join(DIR, '_doc.json')
if (fs.existsSync(snap)) {
  try {
    const doc = JSON.parse(fs.readFileSync(snap, 'utf8'))
    const upq = (Array.isArray(doc.upq) ? doc.upq : []).map(x => ({
      id: x.i, type: x.t, question: x.q,
      options: Array.isArray(x.o) ? x.o : [],
      answer: Array.isArray(x.a) ? x.a : []
    }))
    scanBank('云端上传库 doc.upq（快照 _doc.json）', upq, q => q)
    console.log(`  提示：快照时间戳 upqAt=${doc.upqAt}`)
  } catch (e) { console.log('快照解析失败:', e.message) }
} else {
  console.log('\n[云端上传库] 无 _doc.json 快照，跳过（用 --fetch-doc <url> 拉取）')
}

// ---------- 3. 可选：现场拉云端 ----------
const argv = process.argv.slice(2)
const urlIdx = argv.indexOf('--fetch-doc')
if (urlIdx >= 0 && argv[urlIdx + 1]) {
  ;(async () => {
    try {
      const res = await fetch(argv[urlIdx + 1], { headers: { 'Cache-Control': 'no-cache' } })
      const doc = await res.json()
      const upq = (Array.isArray(doc.upq) ? doc.upq : []).map(x => ({
        id: x.i, type: x.t, question: x.q,
        options: Array.isArray(x.o) ? x.o : [],
        answer: Array.isArray(x.a) ? x.a : []
      }))
      scanBank('云端上传库 doc.upq（现场拉取）', upq, q => q)
      console.log('\n' + summary())
    } catch (e) { console.log('云端拉取失败:', e.message); process.exit(2) }
  })()
} else {
  console.log('\n' + summary())
}

function summary() {
  if (problems === 0) return '体检结论：健康 ✓ 未发现空选项 / 畸形题。'
  return `体检结论：发现 ${problems} 处需要清理的问题（见上）。\n` +
    '  尾部空槽无需手工改库 —— v107 起：\n' +
    '    · 学员端渲染时自动忽略（visibleOptionIndexes）\n' +
    '    · 管理员进「题库管理」列表时自动清理本地库并推云端（compactAndPushUploaded）\n' +
    '    · 云端旧数据在 _upqUnpack 解包时即被清掉'
}
process.exit(problems ? 1 : 0)
