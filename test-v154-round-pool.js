// test-v154-round-pool.js —— v154：抽题池跟「当前营次」走（做哪期就抽哪期的题）
// 背景：管理员「题目部门」=饮食部一级切片做 r4（客房送餐）时 chDeptKey()='dining' →
//   chBankQuestions() 走大部门分支 = 全库（含艳中 295 道），而营次条回落 r4 →
//   「送餐挑战里出艳中题」（u1827 线上实撞，2026-10-09）。
// 契约（用户拍板方案 A）：
//   ① 当前营次挂了明确 depts → 抽题池按营次 depts 从全量 cat12 收窄（与视角/切片解耦）；
//   ② 通用题（dept 空/'all'）保留；营次挂大部门时其分部门题整包可见；
//   ③ 当前营次未挂部门（legacy）或无营次数据 → 维持 chBankQuestions() 视角口径，老行为零变化；
//   ④ chBankQuestions 本体不动（视角口径：上传默认部门等用途）；
//   ⑤ 抽题链路 7 处消费 chRoundBankQuestions：challengePool / challengeRandomQuestions /
//      challengeTestQuestions(k<20 回退) / challengeTestWithWrongQuestions(兜底) /
//      chBankIdSet / chBankDiffStats / chBankCount。
// ★ 夹具镜像线上形状：营次列表 [rB(yan), rA(ird)]、cur 指针=rB —— 大部门视角在
//   chRoundRecForDept ②③ 全落空后回落列表末项 rA（与线上「饮食部视角营次条=r4」同构）。
//   legacy 全部门期不能混进主夹具（它对大部门恒适用，会在第②级被命中，破坏同构性）。
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const DIR = __dirname

let pass = 0, fail = 0
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')) }
}
// 源码剥注释行（否定断言防咬注释，v133/v137 定式）
const codeOnly = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// ====== 沙箱：全载渲染/挑战链 ======
const CH_SRC = fs.readFileSync(path.join(DIR, 'challenge.js'), 'utf8')
const sb = {}
sb.window = sb; sb.console = console; sb.alert = () => {}
sb.setTimeout = () => 0; sb.clearTimeout = () => {}; sb.setInterval = () => 0; sb.clearInterval = () => {}
sb.addEventListener = () => {}
sb.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false } }, setAttribute(){}, appendChild(){}, addEventListener(){} }),
  body: { appendChild(){}, classList: { add(){}, remove(){} } }, documentElement: { style: {} },
}
const lsStore = new Map()
sb.localStorage = {
  getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: k => lsStore.delete(k), clear: () => lsStore.clear(),
  key: i => Array.from(lsStore.keys())[i], get length() { return lsStore.size },
}
sb.navigator = { userAgent: 'node', language: 'zh-CN', onLine: true }
sb.location = { href: 'http://localhost/', hash: '', reload(){} }
sb.URL = URL; sb.Blob = function () {}
sb.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
vm.createContext(sb)
for (const s of ['bank-data.js', 'i18n.js', 'store.js', 'cloud-store.js', 'app.js', 'challenge.js']) {
  try { vm.runInContext(fs.readFileSync(path.join(DIR, s), 'utf8'), sb, { filename: s }) }
  catch (e) { if (s !== 'app.js') console.log('  [LOAD-WARN] ' + s + ': ' + e.message.slice(0, 80)) }
}
const run = c => vm.runInContext(c, sb)

// ★ 钉死随机源（Math.random 浅拷贝替换；challengeRng 本身确定性，无需覆写）
const mathCopy = Object.create(Math)
let seed = 20261009
mathCopy.random = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
sb.Math = mathCopy

// ====== 受控夹具 ======
const NOW = Date.now()
const OPEN = { startAt: NOW - 86400000, endAt: NOW + 86400000 }   // 进行中
// 题库夹具（cat12）：ird 5 + yan 2 + sig 1 + bar 1 + 通用 1（u 前缀模拟云端上传题）
const Q = [
  { id: 8701, dept: 'dining/ird', category_id: 12, type: 'single', difficulty: 1, question: 'ird-q1', options: ['a', 'b', 'c', 'd'], answer: [0], explanation: '' },
  { id: 8702, dept: 'dining/ird', category_id: 12, type: 'single', difficulty: 2, question: 'ird-q2', options: ['a', 'b', 'c', 'd'], answer: [0], explanation: '' },
  { id: 8703, dept: 'dining/ird', category_id: 12, type: 'single', difficulty: 2, question: 'ird-q3', options: ['a', 'b', 'c', 'd'], answer: [0], explanation: '' },
  { id: 8704, dept: 'dining/ird', category_id: 12, type: 'listen', difficulty: 3, question: 'ird-q4', options: ['a', 'b', 'c', 'd'], answer: [0], explanation: '' },
  { id: 8705, dept: 'dining/ird', category_id: 12, type: 'judge', difficulty: 3, question: 'ird-q5', options: ['正确', '错误'], answer: [0], explanation: '' },
  { id: 'u1827', dept: 'dining/yan', category_id: 12, type: 'listen', difficulty: 4, question: 'yan-q-aftermeal-fruit', options: ['我为您上餐后水果。', '餐后甜品请慢用。', '垃圾我帮您及时清理。'], answer: [0], explanation: 'fruit=水果' },
  { id: 'u1828', dept: 'dining/yan', category_id: 12, type: 'single', difficulty: 4, question: 'yan-q2', options: ['a', 'b', 'c'], answer: [0], explanation: '' },
  { id: 8001, dept: 'dining/sig', category_id: 12, type: 'single', difficulty: 1, question: 'sig-q1', options: ['a', 'b', 'c', 'd'], answer: [0], explanation: '' },
  { id: 8101, dept: 'dining/bar', category_id: 12, type: 'single', difficulty: 2, question: 'bar-q1', options: ['a', 'b', 'c', 'd'], answer: [0], explanation: '' },
  { id: 9901, dept: 'all', category_id: 12, type: 'single', difficulty: 1, question: 'generic-q1', options: ['a', 'b', 'c', 'd'], answer: [0], explanation: '' },
]
run(`globalThis.__Q = ${JSON.stringify(Q)}; globalThis.__origGQ = Store.getQuestions;
     Store.getQuestions = function () { return globalThis.__Q }`)

// 营次夹具：yan 在前（cur 指向它）、ird 在末（大部门视角回落末项命中它）——镜像线上 r2/r4
const ROUNDS = [
  { id: 'rB', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], ...OPEN },
  { id: 'rA', name: '客房送餐部七天挑战第1期', depts: ['dining/ird'], seq: 1, ...OPEN },
]
const LEGACY = [{ id: 'rC', name: '全部门挑战第一期', depts: [], ...OPEN }]
function setCloud(rounds, curId) {
  run(`CloudSync._chRounds = ${JSON.stringify(rounds)}; CloudSync._chRoundCurId = ${JSON.stringify(curId)}`)
}
function setSession(username, dept, isAdmin, slice) {
  // ★ role 必须带引号（v154 实撞：role: student 被当标识符 → getSession 抛 ReferenceError → chDeptKey=''）
  run(`Store.getSession = () => ({ username: ${JSON.stringify(username)}, dept: ${JSON.stringify(dept)}, role: ${JSON.stringify(isAdmin ? 'admin' : 'student')} });
       Store.isAdmin = () => ${!!isAdmin};
       practiceDept = ${JSON.stringify(slice || '')};
       localStorage.removeItem('eq_challenge_v2'); localStorage.removeItem('eq_challenge_v2_rA'); localStorage.removeItem('eq_challenge_v2_rB')`)
}
// ★ 一律返回「字符串」用于 === 比对（v154 实撞：曾返回对象去比字符串常量 → 恒 false 的 7 个假失败）
const poolDepts = () => run(`JSON.stringify(chRoundBankQuestions().reduce((m,q)=>{const d=String(q.dept||'(空)');m[d]=(m[d]||0)+1;return m},{}))`)
const seqDepts = () => run(`JSON.stringify(challengePool().reduce((m,q)=>{const d=String(q.dept||'(空)');m[d]=(m[d]||0)+1;return m},{}))`)
const viewDepts = () => run(`JSON.stringify(chBankQuestions().reduce((m,q)=>{const d=String(q.dept||'(空)');m[d]=(m[d]||0)+1;return m},{}))`)
const P_IRD = JSON.stringify({ 'dining/ird': 5, 'all': 1 })
const P_YAN = JSON.stringify({ 'dining/yan': 2, 'all': 1 })
const P_ALL = JSON.stringify({ 'dining/ird': 5, 'dining/yan': 2, 'dining/sig': 1, 'dining/bar': 1, 'all': 1 })
const P_SIG = JSON.stringify({ 'dining/sig': 1, 'all': 1 })

// ====== 组〇：源码契约护栏 ======
console.log('\n—— 组〇 源码契约护栏 ——')
{
  const src = codeOnly(CH_SRC)
  assert('chRoundBankQuestions 已定义', src.includes('function chRoundBankQuestions()'))
  assert('chRoundRecForCurrent 已定义', src.includes('function chRoundRecForCurrent()'))
  // ★ v134 教训：批量替换把函数体替换成自己 → 无限递归。chBankQuestions 体内不得引用新函数
  const bankBody = src.slice(src.indexOf('function chBankQuestions()'), src.indexOf('function chRoundRecForCurrent()'))
  assert('★ chBankQuestions 本体未动（体内无 chRoundBankQuestions/chRoundRecForCurrent，防自递归）',
    !bankBody.includes('chRoundBankQuestions') && !bankBody.includes('chRoundRecForCurrent'))
  const grab = name => { const i = src.indexOf('function ' + name + '('); return src.slice(i, src.indexOf('\nfunction ', i + 1) < 0 ? src.length : src.indexOf('\nfunction ', i + 1)) }
  assert('challengePool 已换 chRoundBankQuestions', grab('challengePool').includes('chRoundBankQuestions()'))
  assert('challengeRandomQuestions 已换', grab('challengeRandomQuestions').includes('chRoundBankQuestions()'))
  assert('challengeTestQuestions k<20 回退已换', grab('challengeTestQuestions').includes('chRoundBankQuestions()'))
  assert('challengeTestWithWrongQuestions 兜底已换', grab('challengeTestWithWrongQuestions').includes('chRoundBankQuestions()'))
  assert('chBankIdSet 已换（错题归属跟营次）', grab('chBankIdSet').includes('chRoundBankQuestions()'))
  assert('chBankDiffStats 已换（缺口告警跟营次）', grab('chBankDiffStats').includes('chRoundBankQuestions()'))
  assert('chBankCount 已换（入口文案跟营次）', grab('chBankCount').includes('chRoundBankQuestions()'))
  // 视角用途保留 chBankQuestions：上传默认部门仍跟切片
  assert('上传默认部门仍用 chDeptKey（视角口径不动）', src.includes("openImportModal(12,'") && src.includes('escAttr(chDeptKey()'))
  // 版本号弹性断言（v116/v117/v150 三连坑定式）
  const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('index.html 12 处 ?v= 且取值唯一', vms.length === 12 && uniq.length === 1, { n: vms.length, set: uniq })
  assert('资源版本号 ≥ 154', uniq.length === 1 && uniq[0] >= 154, uniq)
  assert('无残留 ?v=153', !/\?v=153\b/.test(HTML))
}

// ====== 组一：核心矩阵（营次 depts 收窄 vs 视角切片解耦） ======
console.log('\n—— 组一 核心矩阵（夹具题库） ——')
setCloud(ROUNDS, 'rB')

setSession('Rock', '饮食部·客房送餐部', false)
assert('1.1 真 ird 学员：当前营次=rA（②本部门已开放命中）', run('chCurrentRound()') === 'rA')
assert('1.2 真 ird 学员：池=ird5+通用1', poolDepts() === P_IRD, poolDepts())
assert('1.3 真 ird 学员：序列不含艳中', !seqDepts().includes('yan'), seqDepts())

setSession('admin', '', true, 'dining')
assert('1.4 ★ 管理员+饮食部一级切片（截图场景）：营次条回落列表末项=rA（镜像线上 r4）', run('chCurrentRound()') === 'rA', run('chCurrentRound()'))
assert('1.5 ★ 池被营次收窄=ird5+通用1（不再是全夹具10）', poolDepts() === P_IRD, poolDepts())
assert('1.6 ★ 序列 100% ird（u1827 消失）', !seqDepts().includes('yan'), seqDepts())
assert('1.7 chBankCount 跟营次=6（不再报 10）', run('chBankCount()') === 6, run('chBankCount()'))
assert('1.9 两函数解耦：视角题库（chBankQuestions）=全夹具10、抽题池=6', (() => {
  const viewN = run('chBankQuestions().length')
  return viewN === 10 && run('chRoundBankQuestions().length') === 6
})(), { view: run('chBankQuestions().length'), pool: run('chRoundBankQuestions().length') })
assert('1.9b ★ 视角口径未被污染（大部门切片下仍=全夹具10）', viewDepts() === P_ALL, viewDepts())

setSession('admin', '', true, 'dining/ird')
assert('1.8 管理员+ird 二级切片：营次解析=rA（切片与营次同部门，池=ird）',
  run('chCurrentRound()') === 'rA' && poolDepts() === P_IRD, { cur: run('chCurrentRound()'), pool: poolDepts() })

setSession('admin', '', true, '')
assert('1.10 管理员全部部门（effDept 空）：①指针直接命中 cur=rB → 营次条=rB、池=yan2+通用1（显示与抽题一致）',
  run('chCurrentRound()') === 'rB' && poolDepts() === P_YAN, { cur: run('chCurrentRound()'), pool: poolDepts() })

// ====== 组二：legacy 兼容（老行为零变化） ======
console.log('\n—— 组二 legacy 兼容 ——')
setSession('admin', '', true, 'dining')
setCloud(LEGACY, 'rC')
assert('2.1 legacy 全部门期（depts=[]）：①指针直接命中 → 回落视角口径（大部门=全夹具）',
  run('chCurrentRound()') === 'rC' && poolDepts() === P_ALL, { cur: run('chCurrentRound()'), pool: poolDepts() })
assert('2.2 legacy 期下挑战池仍可用（序列非空）', run('challengePool().length') > 0)

// 无营次数据 → 完全回落视角口径（对每种视角各自核对）
setSession('stu', '饮食部·标帜餐厅', false)
setCloud([], '')
assert('2.3 无营次数据：sig 学员回落视角口径=sig1+通用1', poolDepts() === P_SIG, poolDepts())
assert('2.4 无营次数据：chCurrentRound 回落第一期', run('chCurrentRound()') === '第一期')
setSession('admin', '', true, 'dining')
assert('2.5 无营次数据：大部门切片回落视角口径=全夹具10', poolDepts() === P_ALL, poolDepts())
setSession('admin', '', true, 'dining/ird')
assert('2.6 无营次数据：ird 切片回落视角口径=ird5+通用1', poolDepts() === P_IRD, poolDepts())

// ====== 组三：错题归属过滤跟营次（chBankIdSet） ======
console.log('\n—— 组三 错题归属过滤 ——')
setCloud(ROUNDS, 'rB')
setSession('Rock', '饮食部·客房送餐部', false)
// 第一期存档里塞一道艳中错题 + 一道 ird 错题
run(`localStorage.setItem('eq_challenge_v2', JSON.stringify({ uid: 'Rock', days: { 1: { stages: { 0: { done: true, wrong: ['u1827', 8702] } } } } }))`)
const wrongIds = JSON.parse(run(`JSON.stringify(chPrevRoundWrongQuestions().map(q => String(q.id)))`))
assert('3.1 艳中错题被营次题库过滤掉', !wrongIds.includes('u1827'), wrongIds)
assert('3.2 ird 错题保留（本期题库内的错题照常注入）', wrongIds.includes('8702'), wrongIds)

// ====== 组四：真实题库端到端冒烟（线上复现场景回归） ======
console.log('\n—— 组四 真实题库端到端 ——')
{
  // 还原真题库，灌云端 295 道艳中题 + 线上真实营次形状
  run('Store.getQuestions = globalThis.__origGQ')
  const cloud = JSON.parse(fs.readFileSync(path.join(DIR, '_cloud-sync.json'), 'utf8'))
  sb.localStorage.setItem('eq_uploaded', JSON.stringify((cloud.upq || []).map(o => ({
    id: o.i, dept: o.d, category_id: o.c, type: o.t, difficulty: o.f,
    question: o.q, options: o.o, answer: o.a, explanation: o.e,
  }))))
  run(`CloudSync._chRounds = ${JSON.stringify(cloud.chRounds)}; CloudSync._chRoundCurId = ${JSON.stringify(cloud.chRoundCur)}`)
  setSession('admin', '', true, 'dining')
  assert('4.1 线上形状：管理员饮食部切片当前营次=r4', run('chCurrentRound()') === 'r4')
  const seq = JSON.parse(run(`JSON.stringify(challengePool().map(q => q.dept))`))
  const yan = seq.filter(d => d === 'dining/yan').length
  assert('4.2 ★ 练习序列 170 题 0 道艳中（线上 u1827 事故回归）', seq.length === 170 && yan === 0, { total: seq.length, yan })
  assert('4.3 ★ 序列不含 u1827', !run(`challengePool().some(q => String(q.id) === 'u1827')`))
  assert('4.4 抽题池=236（ird 种子题）', run('chRoundBankQuestions().length') === 236, run('chRoundBankQuestions().length'))
  assert('4.5 入口文案 chBankCount=236', run('chBankCount()') === 236)
  assert('4.5b ★ 视角题库仍是全库（admin 切 ird 时 chBankQuestions=236，与抽题池同数但不依赖它）',
    run('chBankQuestions().length') >= 236)
  // 真 ird 学员不受影响
  setSession('Rock', '饮食部·客房送餐部', false)
  const seq2 = JSON.parse(run(`JSON.stringify(challengePool().map(q => String(q.dept)))`))
  const by2 = seq2.reduce((m, d) => { m[d] = (m[d] || 0) + 1; return m }, {})
  assert('4.6 真 ird 学员序列仍 170 全 ird', seq2.length === 170 && Object.keys(by2).length === 1 && by2['dining/ird'] === 170, { total: seq2.length, by: by2 })
}

console.log(`\n${pass} assertions, ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`)
process.exit(fail ? 1 : 0)
