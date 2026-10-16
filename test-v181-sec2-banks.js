// ====== 测试 v181：三批新题（酒吧一期 / 艳中二期 / 客房送餐二期）+ 云端上传库合并语义 ======
// 背景（用户口径）：「发布酒吧团队第一期（参考 56 个英语单词），然后根据之前的文件和错题
//   发布艳中餐厅 和 客房送餐 第二期」→ 拍板：交付 = 建期 + 出题入库；酒吧沿用客房送餐模板
//   （每词 4 题型：single 英→中 / listen 听音选义 / voicematch 看字选音 / judge 判断）；
//   二期出题重点 = 错题优先 + 历史文件补强；落库走**云端上传库 doc.upq**（免发版、即时生效）。
//
// ⚠️ 本套件依赖工作区根目录下 4 个**题库正本快照**（不是仓库文件，发版不推送）：
//   _bar-questions.json（252 题）· _yan2-questions.json（194 题）· _ird2-questions.json（175 题）
//   _v181-upq.json（写入前云端正本 295 题，压缩格式）
//   ★ 这四个文件不得删除 —— 回归套件靠它们复算「推送前/推送后」的合并语义。
//
// 覆盖点：
// ① 三批题文件结构：题数 / id 段 / dept / category_id / 无重号 / 无空字段 / 选项与 answer 合法
// ② 题型口径：judge 恒「正确/错误」二选一；listen 题干必须英文（中文无语音包且朗读无意义）；
//    voicematch 题干必须非空（v155 契约：题干非空 → 作答时隐藏选项文字 → 必须给出文字提示）
// ③ 与既有题库（bank-data.js，1436 题）id 不冲突
// ④ 云端上传库合并语义（照抄 cloud-store.js 的 _upqPack/_upqUnpack/_optCompact 真实源码）：
//    以「写入前 295 题」为基线重放一次合并 → 916 题，且原 295 题逐条保留（防推新题冲掉旧题）
// ⑤ 抽题池容量：三批题接入后，酒吧/艳中/客房送餐的桶3 缺口为 0（v181 的核心结论）
// ⑥ 营次形态：r5 酒吧一期（seq=1）→ 基础档；r6 艳中二期 / r7 客房送餐二期（seq=2）→ 进阶档
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); failed = true }
}
function extractFn(src, name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('fn not found: ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
function extractConst(src, name) {
  const start = src.indexOf('const ' + name + ' =')
  if (start < 0) throw new Error('const not found: ' + name)
  let i = src.indexOf('[', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
// 对象方法简写（`absorbCloudUploaded(list, at) { … }`）—— extractFn 只认 `function name(`
function extractMethod(src, name) {
  const m = new RegExp('(^|\\n)[ \\t]*' + name + '[ \\t]*\\(').exec(src)
  if (!m) throw new Error('method not found: ' + name)
  const start = m.index + m[0].length - 1
  let i = start, depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') { depth--; if (depth === 0) break }
  }
  const b = src.indexOf('{', i)
  for (i = b, depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(m.index, i + 1)
}
// 计数类断言必须剥注释（本项目九次复发的老坑）
const codeOnly = s => String(s || '')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w])\/\/[^\n]*/g, '$1')

const ROOT = path.join(__dirname, '..')
const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const CS = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')

const readJson = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf-8'))
const BAR = readJson('_bar-questions.json')
const YAN2 = readJson('_yan2-questions.json')
const IRD2 = readJson('_ird2-questions.json')
const UPQ_BEFORE = readJson('_v181-upq.json')      // 压缩格式（i/d/c/t/f/q/o/a/e），写入前云端正本

// 用 cloud-store.js 的**真实源码**解压/压缩（第 ④ ⑤ 组共用；绝不手写简化版）
const upqCtx = { console, JSON, Array, Object, String, Number, Boolean, Math }
vm.createContext(upqCtx)
;['_optCompact', '_upqPack', '_upqUnpack'].forEach(fn => vm.runInContext(extractFn(CS, fn), upqCtx))
const upqUnpack = list => { upqCtx.__x = list; return vm.runInContext('JSON.parse(JSON.stringify(_upqUnpack(__x)))', upqCtx) }
const upqPack = list => { upqCtx.__x = list; return vm.runInContext('JSON.parse(JSON.stringify(_upqPack(__x)))', upqCtx) }
const UPQ_BEFORE_UNPACKED = upqUnpack(UPQ_BEFORE)

const hasCJK = s => /[\u4e00-\u9fa5]/.test(String(s == null ? '' : s))
const countBy = (arr, k) => {
  const m = {}
  arr.forEach(q => { const v = String(q[k]); m[v] = (m[v] || 0) + 1 })
  return m
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const SPEC = [
  {
    file: '_bar-questions.json', label: '酒吧团队第一期', list: BAR,
    dept: 'dining/bar', n: 252, lo: 3001, hi: 3252,
    types: { single: 63, listen: 63, voicematch: 63, judge: 63 },
    diff: { 1: 94, 2: 75, 3: 83 },
  },
  {
    file: '_yan2-questions.json', label: '艳中餐厅第二期', list: YAN2,
    dept: 'dining/yan', n: 194, lo: 4001, hi: 4194,
    types: { single: 84, judge: 28, listen: 41, voicematch: 41 },
    diff: { 1: 24, 2: 55, 3: 115 },
  },
  {
    file: '_ird2-questions.json', label: '客房送餐部第二期', list: IRD2,
    dept: 'dining/ird', n: 175, lo: 5001, hi: 5175,
    types: { single: 76, judge: 25, listen: 37, voicematch: 37 },
    diff: { 1: 43, 2: 49, 3: 83 },
  },
]

// 既有本地种子库（数字 id）
const bankCtx = {}
vm.createContext(bankCtx)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8') + '\n; globalThis.__B = BANK;', bankCtx)
const BANK = vm.runInContext('__B', bankCtx)

console.log('\n🧪 v181 三批新题 + 云端上传库合并语义')

// ================= ① 三批题文件结构 =================
console.log('\n[1] 三批题文件：题数 / id 段 / 部门 / 分类 / 字段合法性')
SPEC.forEach(s => {
  const t = s.label + '：'
  assert(t + s.file + ' 题数 = ' + s.n, s.list.length === s.n, s.list.length)
  const ids = s.list.map(q => String(q.id)).sort()
  assert(t + 'id 段 u' + s.lo + '–u' + s.hi,
    ids[0] === 'u' + s.lo && ids[ids.length - 1] === 'u' + s.hi, ids[0] + '..' + ids[ids.length - 1])
  assert(t + '无重号', new Set(ids).size === s.list.length, s.list.length - new Set(ids).size)
  assert(t + 'dept 全为 ' + s.dept, sameJson(countBy(s.list, 'dept'), { [s.dept]: s.n }), JSON.stringify(countBy(s.list, 'dept')))
  assert(t + 'category_id 全为 12（挑战抽题池硬过滤）',
    sameJson(countBy(s.list, 'category_id'), { 12: s.n }), JSON.stringify(countBy(s.list, 'category_id')))
  assert(t + '题型分布 ' + JSON.stringify(s.types), sameJson(countBy(s.list, 'type'), s.types), JSON.stringify(countBy(s.list, 'type')))
  assert(t + '难度分布 ' + JSON.stringify(s.diff), sameJson(countBy(s.list, 'difficulty'), s.diff), JSON.stringify(countBy(s.list, 'difficulty')))
  assert(t + '无空题干 / 无空解析',
    s.list.every(q => String(q.question || '').trim() && String(q.explanation || '').trim()), '')
  assert(t + 'answer 恒为长度 1 的数组且下标合法',
    s.list.every(q => Array.isArray(q.answer) && q.answer.length === 1
      && Number(q.answer[0]) >= 0 && Number(q.answer[0]) < (q.options || []).length), '')
  assert(t + '同一题内选项无重复文本',
    s.list.every(q => (q.options || []).length === new Set((q.options || []).map(String)).size), '')
  assert(t + '选项数恒为 4（judge 为 2）',
    s.list.every(q => (q.type === 'judge' ? (q.options || []).length === 2 : (q.options || []).length === 4)), '')
})

// ================= ② 题型口径 =================
console.log('\n[2] 题型口径（与线上既有口径一致）')
SPEC.forEach(s => {
  const t = s.label + '：'
  const judge = s.list.filter(q => q.type === 'judge')
  assert(t + 'judge 选项恒为「正确 / 错误」',
    judge.every(q => sameJson(q.options, ['正确', '错误'])), '')
  assert(t + 'judge 题干必须是中文判断题（含「的英文是」句式）',
    judge.every(q => hasCJK(q.question)), judge.filter(q => !hasCJK(q.question)).length + ' 道例外')
  assert(t + 'judge 真伪两种答案都出现（答案分布不偏）',
    judge.some(q => Number(q.answer[0]) === 0) && judge.some(q => Number(q.answer[0]) === 1), '')
  // listen（听音选义）：会朗读题干 → 题干必须是英文（中文不产生语音包，且朗读中文无意义）
  const listen = s.list.filter(q => q.type === 'listen')
  assert(t + 'listen 题干**全部为英文**（中文题干无法生成语音包）',
    listen.every(q => !hasCJK(q.question)), listen.filter(q => hasCJK(q.question)).length + ' 道中文题干')
  // voicematch（看字选音）：v155 契约 —— 题干非空即隐藏选项文字，故题干必须给出「选什么」的任务描述
  const vmq = s.list.filter(q => q.type === 'voicematch')
  assert(t + 'voicematch 题干非空（v155：题干非空 → 作答时隐藏选项文字）',
    vmq.every(q => String(q.question || '').trim().length > 0), '')
  assert(t + 'voicematch 选项为 4 项且互不相同',
    vmq.every(q => (q.options || []).length === 4
      && new Set((q.options || []).map(String)).size === 4), '')
  const single = s.list.filter(q => q.type === 'single')
  assert(t + 'single 选项为 4 项', single.every(q => (q.options || []).length === 4), '')
})

// ================= ③ 与既有题库 id 不冲突 =================
console.log('\n[3] 与既有本地种子库（bank-data.js）id 不冲突')
{
  const oldIds = new Set(BANK.questions.map(q => String(q.id)))
  const hit = []
  SPEC.forEach(s => s.list.forEach(q => { if (oldIds.has(String(q.id))) hit.push(s.file + '#' + q.id) }))
  assert('三批题与本地 1436 题（cat12 共 920 题）id 无交集', hit.length === 0, hit.slice(0, 5).join(' '))
  const all = [].concat(BAR, YAN2, IRD2).map(q => String(q.id))
  assert('三批题合计 ' + all.length + ' 题内部也无重号', new Set(all).size === all.length, all.length - new Set(all).size)
  assert('本地种子题库仍有 cat12 920 题（sig 633 / bar 51 / ird 236，yan 0）',
    BANK.questions.filter(q => Number(q.category_id) === 12).length === 920 && BANK.version === 9, '')
  assert('★ BANK.version 未被本次出题改动（仍为 9，不动版本铁律）', BANK.version === 9, BANK.version)
}

// ================= ④ 云端上传库合并语义 =================
console.log('\n[4] 云端上传库 doc.upq 合并语义（照抄 cloud-store.js 真实源码）')
{
  const unpack = upqUnpack
  const pack = upqPack

  // 写入前云端正本
  const before = unpack(UPQ_BEFORE)
  assert('写入前云端正本 = 295 题（全 dining/yan cat12）',
    before.length === 295 && before.every(q => q.dept === 'dining/yan' && Number(q.category_id) === 12),
    before.length + ' 题')

  // 落库（与 CloudSync.setUploadedBank 同款合并语义：本机全量优先、远端独有才追加）
  const batches = [].concat(BAR, YAN2, IRD2)
  const have = new Set(batches.map(q => String(q.id)))
  const merged = batches.concat(before.filter(q => !have.has(String(q.id))))
  assert('合并后 = 916 题（现有 295 + 本批 621，且无重复 id）',
    merged.length === 916 && new Set(merged.map(q => String(q.id))).size === 916, merged.length)
  assert('★ 原有 295 题逐条仍在合并结果里（防「推新题冲掉旧题」）',
    before.every(q => merged.some(m => String(m.id) === String(q.id))), '')

  // 压缩往返：不得丢字段
  const rt = unpack(pack(merged))
  const fields = ['id', 'dept', 'category_id', 'type', 'difficulty', 'question', 'options', 'answer', 'explanation']
  let bad = 0
  const byId = {}
  rt.forEach(q => { byId[String(q.id)] = q })
  batches.forEach(q => {
    const r = byId[String(q.id)]
    if (!r) { bad++; return }
    fields.forEach(f => { if (!sameJson(r[f], q[f])) bad++ })
  })
  assert('压缩 → 解压往返后，本批 621 题逐字段一致（0 处不一致）', bad === 0, bad + ' 处')

  // upqAt 守卫：Store.absorbCloudUploaded 靠「新时间戳 > 旧时间戳」才吸收
  const STORE = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
  const absorb = codeOnly(extractMethod(STORE, 'absorbCloudUploaded'))
  assert('absorbCloudUploaded 源码含 upqAt 新旧守卫（ts <= _cloudUpqAt → 不吸收）',
    /ts <= this\._cloudUpqAt/.test(absorb) && /return false/.test(absorb), '')
}

// ================= ⑤ 抽题池容量（桶3 缺口） =================
console.log('\n[5] 三批题接入后各营次抽题池分桶容量 vs 计划需求')
{
  const sb = { console, JSON, Array, Object, String, Number, Math }
  vm.createContext(sb)
  ;['CHALLENGE_DIFF_PLAN', 'CHALLENGE_DIFF_PLAN_HARD'].forEach(n => vm.runInContext(extractConst(CH, n), sb))
  ;['chDiffBucketOf', 'chBankMaxDiff', 'chPlanAllocate'].forEach(fn => vm.runInContext(extractFn(CH, fn), sb))

  const PLAN1 = vm.runInContext('CHALLENGE_DIFF_PLAN', sb)
  const PLANH = vm.runInContext('CHALLENGE_DIFF_PLAN_HARD', sb)
  const bucketOf = (d, mx) => vm.runInContext('chDiffBucketOf(' + d + ',' + mx + ')', sb)
  const maxDiffOf = list => vm.runInContext('chBankMaxDiff(' + JSON.stringify(list.map(q => ({ difficulty: q.difficulty }))) + ')', sb)
  const allocate = (plan, cap) => vm.runInContext(
    'JSON.stringify(chPlanAllocate(' + JSON.stringify(plan) + ', { 1: new Array(' + cap[0] + ').fill(0), 2: new Array(' + cap[1] + ').fill(0), 3: new Array(' + cap[2] + ').fill(0) }))', sb)

  const cat12Seed = BANK.questions.filter(q => Number(q.category_id) === 12)
  const allCat12 = cat12Seed.concat(UPQ_BEFORE_UNPACKED, BAR, YAN2, IRD2)
  function poolOf(dept) {
    const major = String(dept).split('/')[0]
    return allCat12.filter(q => {
      const d = String(q.dept || '')
      if (!d || d === 'all') return true
      return d === dept || d === major
    })
  }
  const need = plan => [0, 1, 2].map(k => plan.reduce((s, r) => s + r[k], 0))

  const CASES = [
    { label: '酒吧团队第一期', dept: 'dining/bar', plan: PLAN1, planName: '第一期', n: 303, gap: '0/0/0' },
    { label: '艳中餐厅第二期', dept: 'dining/yan', plan: PLANH, planName: '进阶期', n: 489, gap: '0/0/0' },
    { label: '客房送餐部第二期', dept: 'dining/ird', plan: PLANH, planName: '进阶期', n: 411, gap: '0/0/0' },
    // 对照：标帜餐厅第一期桶3 不足（既有事实，证明「缺口 0」不是断言写松）
    { label: '（对照）标帜餐厅第一期', dept: 'dining/sig', plan: PLAN1, planName: '第一期', n: 633, gap: '0/0/55' },
  ]
  CASES.forEach(c => {
    const list = poolOf(c.dept)
    const mx = maxDiffOf(list)
    const cap = [0, 0, 0]
    list.forEach(q => cap[bucketOf(Number(q.difficulty) || 1, mx) - 1]++)
    const nd = need(c.plan)
    const gap = nd.map((v, i) => Math.max(0, v - cap[i])).join('/')
    assert(c.label + '：池 ' + list.length + ' 题（含本批）/ maxDiff=' + mx + ' / 桶容量 ' + cap.join('/')
      + ' / 需求 ' + nd.join('/') + ' / 缺口 ' + gap,
      list.length === c.n && gap === c.gap, 'n=' + list.length + ' gap=' + gap)
    // 计划能完整落地：分配出的每日题量合计 = 计划题量
    const alloc = JSON.parse(allocate(c.plan, cap))
    const planTotal = c.plan.reduce((s, r) => s + r[0] + r[1] + r[2], 0)
    const allocTotal = alloc.reduce((s, r) => s + r[0] + r[1] + r[2], 0)
    assert(c.label + '：按配比分配后每日题量合计 = ' + planTotal + ' 题（无空题）',
      allocTotal === planTotal, allocTotal)
    // 实际日均难度单调不减（「逐日变难」的梯度真的落地了）
    const daily = alloc.map(r => (r[0] + r[1] * 2 + r[2] * 3) / (r[0] + r[1] + r[2]))
    assert(c.label + '：实际每日均值单调不减（' + daily.map(x => x.toFixed(2)).join(' ') + '）',
      daily.every((x, i) => i === 0 || x >= daily[i - 1] - 1e-9), daily.map(x => x.toFixed(2)).join(' '))
  })
}

// ================= ⑥ 营次形态 → 难度档 =================
console.log('\n[6] 三个新营次的部门与期号 → 难度档')
{
  const ROUNDS = [
    { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: false },
    { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: false },
    { id: 'r3', name: '标帜餐厅七天挑战第二期', depts: ['dining/sig'], open: true },
    { id: 'r4', name: '客房送餐部七天挑战第1期', depts: ['dining/ird'], open: true, seq: 1 },
    { id: 'r5', name: '酒吧团队七天挑战第一期', depts: ['dining/bar'], open: true, seq: 1 },
    { id: 'r6', name: '艳中餐厅七天挑战第二期', depts: ['dining/yan'], open: true, seq: 2 },
    { id: 'r7', name: '客房送餐部七天挑战第二期', depts: ['dining/ird'], open: true, seq: 2 },
  ]
  const sb = { console, JSON, Array, Object, String, Number, Math }
  vm.createContext(sb)
  vm.runInContext("const ROUND_DEPT_ALL_KEY = '__all__'", sb)
  vm.runInContext(extractFn(CS, '_roundDeptGroupKey'), sb)
  vm.runInContext(extractFn(CS, '_roundSeqOf'), sb)
  sb.__R = ROUNDS
  const seqOf = id => vm.runInContext('_roundSeqOf(__R, ' + JSON.stringify(id) + ')', sb)
  const hardOf = id => seqOf(id) > 1

  assert('酒吧团队第一期 r5：depts=["dining/bar"] / seq=1（本批新建）',
    ROUNDS[4].depts.join() === 'dining/bar' && ROUNDS[4].seq === 1, JSON.stringify(ROUNDS[4]))
  assert('艳中餐厅第二期 r6：depts=["dining/yan"] / seq=2（本批新建）',
    ROUNDS[5].depts.join() === 'dining/yan' && ROUNDS[5].seq === 2, JSON.stringify(ROUNDS[5]))
  assert('客房送餐部第二期 r7：depts=["dining/ird"] / seq=2（本批新建）',
    ROUNDS[6].depts.join() === 'dining/ird' && ROUNDS[6].seq === 2, JSON.stringify(ROUNDS[6]))
  assert('r5 酒吧第一期 → 基础档（seq=1）', hardOf('r5') === false, '')
  assert('r6 艳中二期 → 进阶档（seq=2）', hardOf('r6') === true, '')
  assert('r7 客房送餐二期 → 进阶档（seq=2）', hardOf('r7') === true, '')
  // v181 修 bug 后：存量一期不再被误判为进阶期
  assert('r2 艳中一期（无 seq，同组第 1 期）→ 基础档（v181 修 bug 前被误判为进阶）',
    hardOf('r2') === false, '')
  assert('r4 客房送餐一期（seq=1）→ 基础档（v181 修 bug 前被误判为进阶）',
    hardOf('r4') === false, '')
  assert('r1 标帜一期 / r3 标帜二期 → 基础 / 进阶（原有行为不变）',
    hardOf('r1') === false && hardOf('r3') === true, '')
  assert('源码契约：chIsHardRound 已改为「按部门组期号」判定（不再只看 r1）',
    /_roundSeqOf|Number\(rec\.seq\) > 0/.test(codeOnly(extractFn(CH, 'chIsHardRound'))), '')
  assert('源码契约：challengePool 的题源仍按 category_id === 12 硬过滤',
    /category_id\)?\s*===\s*12/.test(codeOnly(extractFn(CH, 'chBankQuestions'))), '')
}

console.log(failed ? '\n❌ v181 测试存在失败项\n' : '\n✅ v181 测试全部通过\n')
process.exit(failed ? 1 : 0)
