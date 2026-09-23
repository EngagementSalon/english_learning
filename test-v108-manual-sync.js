// ====== 测试 v108：手动补录成绩 → 完成情况与积分同步作数 ======
// 用户验收口径：「我手动录入成绩，七天完成情况也应该作数，且积分也应该同步」。
// v105 补录链路的三处缺口/确认点：
//   ① chyfix（覆盖补录）定位跳过 cleared + 覆写保留 cleared → 对被重置过的学员，补录永远不计入
//      （看板 s7 与积分口径都是 `!x.cleared`）→ v108 改为可命中存根并清除 cleared
//   ② 看板口径（maxDay/打卡/s7/积分/排名）从 base+events+本机队列 重放推导 → 本来就作数（回归锁死）
//   ③ 学员端进度/打卡/报告 100% 读本地 challengeState，云端补录不可见 → v108 新增
//      chAbsorbManualScores：积分榜拉取时把本人 manual 考试记录合并进本地进度（真实成绩优先）
// 沙箱坑备忘：challenge.js 整载须注入 TYPE_LABELS/LETTERS/quizTitleHtml/autoplayListen+escHtml；
//   `const` 模块级绑定不挂 vm 全局；let challengeState 不可直接访问 → 走函数间接断言。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
let n = 0
function assert(name, cond, msg) {
  n++
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
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

const CLOUD_SRC = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const CH_SRC = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')

// ---------- 云端沙箱（整载 cloud-store.js，mock 云端 fetch） ----------
function makeCloudSandbox(docRef) {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Date, Promise, Set, Map,
    AbortController,
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] == null ? null : this.store[k] },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: { addEventListener() {}, visibilityState: 'visible', getElementById() { return null } },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  }
  sb.window = sb
  sb.navigator = { onLine: true }
  sb.fetch = async (url, opt) => {
    if (opt && opt.method === 'POST') {
      const body = JSON.parse(opt.body)
      Object.keys(docRef).forEach(k => delete docRef[k])
      Object.assign(docRef, body)
      return { ok: true, status: 200, text: async () => JSON.stringify(docRef) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(JSON.parse(JSON.stringify(docRef))) }
  }
  vm.createContext(sb)
  vm.runInContext(CLOUD_SRC + '\n;CloudSync;window.__CS = CloudSync', sb)
  sb.CloudSync = sb.__CS
  sb.__docRef = docRef
  return sb
}

// 线上形状：两个营次（r1 标帜 / r2 艳中），指针 r1
function realDoc() {
  return {
    v: 1,
    chRoundCur: 'r1',
    chRounds: [
      { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, examOpen: true, startAt: 0, endAt: 0, at: 1790058244386 },
      { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: true, examOpen: true, startAt: 0, endAt: 0, at: 1790057352042 },
    ],
    base: {
      李梦园: {
        username: '李梦园', name: '李梦园', dept: 'dining/sig',
        chy: [
          { day: 1, si: 0, kind: 'test', correct: 18, total: 20, usedSec: 200, at: 1790000000000, rd: 'r1' },
          { day: 6, si: 0, kind: 'practice', correct: 30, total: 30, usedSec: 300, at: 1790010000000, rd: 'r1' },
          { day: 7, si: 0, kind: 'practice', correct: 10, total: 10, usedSec: 90, at: 1790020000000, rd: 'r1' },
        ],
      },
      任璐瑶: {
        username: '任璐瑶', name: '任璐瑶', dept: 'dining/yan',
        chy: [
          { day: 7, si: 0, kind: 'practice', correct: 10, total: 10, usedSec: 90, at: 1790020000000, rd: 'r2' },
        ],
      },
    },
    events: [],
  }
}

// 看板口径复刻（app.js renderDashChallengeBlock 同规则）：s7 与积分都跳过 cleared
function dashView(chy) {
  const t7 = (chy || []).find(x => x.kind === 'test' && x.day === 7 && !x.cleared)
  const firstByStage = {}
  ;(chy || []).forEach(x => {
    if (x.cleared) return
    const k = x.day + '-' + x.si
    if (!firstByStage[k] || (x.at || 0) < (firstByStage[k].at || 0)) firstByStage[k] = x
  })
  let pts = 0
  Object.keys(firstByStage).forEach(k => {
    const x = firstByStage[k]
    pts += (x.correct || 0) * 100 * ((Number(x.day) === 7 && x.kind === 'test') ? 3 : 1)
  })
  return { s7: t7 && t7.total ? Math.round(t7.correct / t7.total * 100) : null, pts }
}

// ---------- challenge.js 沙箱（整载，参照 test-v77） ----------
function makeChSandbox(session) {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm() { return true },
  }
  sb.window = sb
  sb.window.__els = {}
  sb.document = {
    addEventListener() {},
    getElementById(id) { return (sb.window.__els[id] = sb.window.__els[id] || { id, innerHTML: '' }) },
  }
  sb.alert = () => {}
  sb.AntiCheat = { start() {}, stop() {}, isActive() { return false }, getViolations() { return 0 }, dismiss() {}, isAdminUser() { return false } }
  sb.CloudSync = { enqueue() {}, _chExamOpen: true, _chOpen: true, _chOpenAt: Date.now(), _chRoundCurId: 'r1', _chRoundCurName: '标帜餐厅七天挑战第一期', _chRounds: [], _chOpenLocked: false }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  vm.runInContext(['visibleOptionIndexes', 'shuffleOptions', 'checkAnswer', 'safeQType', 'escAttr', 'escHtml'].map(fn => extractFn(APP_SRC, fn)).join('\n'), sb)
  vm.runInContext(
    'const TYPE_LABELS = new Proxy({}, { get: (_, k) => k });' +
    'const LETTERS = ["A", "B", "C", "D"];' +
    'function quizTitleHtml(q) { return "<div>" + (q.question || "") + "</div>" };' +
    'function autoplayListen() {}',
    sb
  )
  vm.runInContext(CH_SRC, sb)
  vm.runInContext('function chDeptKey(){ return "dining/sig" }', sb)
  // 登录态：challengeUid() 从这里来
  sb.localStorage.setItem('eq_session', JSON.stringify(session || { username: 'u1', name: '张三', id: 1 }))
  return sb
}

;(async () => {

console.log('=== 组 1：chyfix 覆盖补录恢复被重置（cleared）的成绩 ===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  // 先补录一条（走真实 setChallengeManualScore → events），重放进 base
  await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 18, total: 20 })
  const map = JSON.parse(JSON.stringify(doc.base))
  doc.events.forEach(ev => sb.CloudSync._apply(map, ev))
  let v = dashView(map['李梦园'].chy)
  assert('补录后 s7=90', v.s7 === 90, JSON.stringify(v))
  assert('补录后积分计入 D7 考试 3 倍权重', v.pts === 18 * 100 * 3 + 10 * 100 + 30 * 100 + 18 * 100, String(v.pts))
  // 管理员重置 → cleared 存根（exam 模式只清 test；practice 仍计分：30*100 + 10*100 = 4000）
  // ⚠️ 时间戳相对「现在」派生（详见 test-v105 同名注释）：写死绝对值会随时间失效。
  const resetTs = Date.now() + 1000
  sb.CloudSync._apply(map, { u: '李梦园', n: '李梦园', ty: 'chreset', ts: resetTs, d: { mode: 'exam', round: 'r1' } })
  v = dashView(map['李梦园'].chy)
  assert('重置后 s7 归空、考试积分归零（存根不计分，练习照常）', v.s7 === null && v.pts === 4000, JSON.stringify(v))
  // chyfix 覆盖补录 → 恢复成绩
  sb.CloudSync._apply(map, { u: '李梦园', n: '李梦园', ty: 'chyfix', ts: resetTs + 1000, d: { day: 7, si: 1, rd: 'r1', correct: 20, total: 20, usedSec: 0, manual: true } })
  const rec = map['李梦园'].chy.find(x => x.kind === 'test' && x.day === 7)
  assert('chyfix 命中 cleared 存根并清除 cleared', rec && !rec.cleared && rec.manual === true && rec.correct === 20, JSON.stringify(rec))
  v = dashView(map['李梦园'].chy)
  assert('恢复后 s7=100 且积分重新计入（20*100*3 + 练习 4000）', v.s7 === 100 && v.pts === 10000, JSON.stringify(v))
}

console.log('=== 组 2：chyfix 幂等（重放两次结果相同）===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 15, total: 20, usedSec: 120 })
  const map = JSON.parse(JSON.stringify(doc.base))
  doc.events.forEach(ev => sb.CloudSync._apply(map, ev))
  const fix = { u: '李梦园', n: '李梦园', ty: 'chyfix', ts: 1790110000000, d: { day: 7, si: 1, rd: 'r1', correct: 19, total: 20, usedSec: 80, manual: true } }
  sb.CloudSync._apply(map, fix)
  const once = JSON.stringify(map['李梦园'].chy)
  sb.CloudSync._apply(map, fix)
  assert('同一条 chyfix 重放两次结果相同', JSON.stringify(map['李梦园'].chy) === once)
  const rec = map['李梦园'].chy.find(x => x.kind === 'test' && x.day === 7)
  assert('覆写后 19/20 且无 cleared', rec && rec.correct === 19 && rec.usedSec === 80 && !rec.cleared, JSON.stringify(rec))
}

console.log('=== 组 3：chyfix 找不到 test 记录仍不凭空造（全新学员走非覆盖补录）===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  const map = JSON.parse(JSON.stringify(doc.base))
  // 李梦园无 D7 test；任璐瑶无任何 test
  const beforeLY = JSON.stringify(map['李梦园'].chy)
  const beforeRL = JSON.stringify(map['任璐瑶'].chy)
  sb.CloudSync._apply(map, { u: '李梦园', n: '李梦园', ty: 'chyfix', ts: 1790110000000, d: { day: 7, si: 1, rd: 'r1', correct: 20, total: 20, usedSec: 0, manual: true } })
  sb.CloudSync._apply(map, { u: '任璐瑶', n: '任璐瑶', ty: 'chyfix', ts: 1790110000001, d: { day: 7, si: 1, rd: 'r2', correct: 20, total: 20, usedSec: 0, manual: true } })
  assert('无 test 记录时 chyfix 静默忽略（李梦园）', JSON.stringify(map['李梦园'].chy) === beforeLY)
  assert('无 test 记录时 chyfix 静默忽略（任璐瑶）', JSON.stringify(map['任璐瑶'].chy) === beforeRL)
}

console.log('=== 组 4：非覆盖补录（chy 事件）对被重置学员作数 ===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 18, total: 20 })
  const map = JSON.parse(JSON.stringify(doc.base))
  doc.events.forEach(ev => sb.CloudSync._apply(map, ev))
  // 时间戳相对「现在」派生（同上）：重置在前、新记录在后，语义才是「重置后重考/新补录仍计分」。
  const resetTs2 = Date.now() + 1000
  sb.CloudSync._apply(map, { u: '李梦园', n: '李梦园', ty: 'chreset', ts: resetTs2, d: { mode: 'exam', round: 'r1' } })
  // 非覆盖再补一条（chy 事件 push 新记录，不动存根）
  sb.CloudSync._apply(map, { u: '李梦园', n: '李梦园', ty: 'chy', ts: resetTs2 + 1000, d: { day: 7, si: 1, kind: 'test', correct: 17, total: 20, usedSec: 100, rd: 'r1', manual: true } })
  const v = dashView(map['李梦园'].chy)
  assert('存根跳过、新记录计入 → s7=85', v.s7 === 85, JSON.stringify(v))
  const t7count = map['李梦园'].chy.filter(x => x.kind === 'test' && x.day === 7).length
  assert('存根与新记录并存（存根不删，积分只算新记录）', t7count === 2, String(t7count))
}

console.log('=== 组 5：chAbsorbManualScores（学员端本地进度吸收）===')
// 调用方式：整载后 chAbsorbManualScores 是沙箱内真函数（function 声明挂全局）；
// rows 从宿主挂到 sb.__rows 传入（提取函数体单独注入会因 challengeState 是模块级 let 而 ReferenceError）
const absorbIn = (sb, rows, expr) => {
  sb.__rows = rows
  return vm.runInContext('chAbsorbManualScores(window.__rows)' + (expr ? '; ' + expr : ''), sb)
}
{
  // 5a. 本地无记录 → 写入 done + manual
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 7, si: 1, kind: 'test', correct: 18, total: 20, usedSec: 0, at: 1790130000000, rd: '', manual: true },
    ] }]
    const changed = absorbIn(sb, rows)
    assert('吸收返回 changed=true', changed === true, String(changed))
    assert('本地阶段已标记完成', vm.runInContext('chStageDone(7, 1)', sb) === true)
    assert('本地阶段分数 18/20=90', vm.runInContext('chStageScore(7, 1)', sb) === 90)
    // 幂等：同一 rows 再吸收一次
    const before = vm.runInContext('JSON.stringify(challengeState.days)', sb)
    absorbIn(sb, rows)
    assert('同一 rows 重复吸收幂等', vm.runInContext('JSON.stringify(challengeState.days)', sb) === before)
  }
  // 5b. 本地已有真实成绩 → 不覆盖
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    vm.runInContext('challengeState.days[7] = { stages: { 1: { done: true, at: 1790100000000, correct: 20, total: 20, wrong: [] } } }; challengeSave()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 7, si: 1, kind: 'test', correct: 10, total: 20, usedSec: 0, at: 1790130000000, rd: '', manual: true },
    ] }]
    absorbIn(sb, rows)
    assert('学员真实成绩优先，manual 不覆盖', vm.runInContext('chStageScore(7, 1)', sb) === 100)
  }
  // 5c. 本地是 cleared 存根 → 覆盖恢复（与 chyfix v108 同口径）
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    vm.runInContext('challengeState.days[7] = { stages: { 1: { cleared: true, at: 1790100000000, total: 20 } } }; challengeSave()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 7, si: 1, kind: 'test', correct: 18, total: 20, usedSec: 0, at: 1790130000000, rd: '', manual: true },
    ] }]
    absorbIn(sb, rows)
    assert('cleared 存根被 manual 补录恢复', vm.runInContext('chStageDone(7, 1) && chStageScore(7, 1) === 90', sb) === true)
    assert('恢复后不再是存根', vm.runInContext('chStageCleared(7, 1)', sb) === false)
  }
  // 5d. 别的营次 / practice / 无 manual 的记录不吸收
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 7, si: 1, kind: 'test', correct: 18, total: 20, at: 1790130000000, rd: 'r2', manual: true },   // 别的营次
      { day: 5, si: 0, kind: 'practice', correct: 30, total: 30, at: 1790130000001, rd: '', manual: true }, // practice 无补录形态
      { day: 1, si: 0, kind: 'test', correct: 20, total: 20, at: 1790130000002, rd: '' },                    // 无 manual（真实上报）
    ] }]
    absorbIn(sb, rows)
    assert('别营次/practice/非 manual 一律不吸收', vm.runInContext('chStageDone(7, 1) || chStageDone(5, 0) || chStageDone(1, 0)', sb) === false)
  }
  // 5e. chyfix 改分后学员端同步（本地已 manual → 云端覆盖）
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    vm.runInContext('challengeState.days[7] = { stages: { 1: { done: true, at: 1790130000000, correct: 18, total: 20, wrong: [], manual: true } } }; challengeSave()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 7, si: 1, kind: 'test', correct: 20, total: 20, usedSec: 0, at: 1790130000000, rd: '', manual: true },
    ] }]
    absorbIn(sb, rows)
    assert('管理员改分（chyfix）后学员端同步为 20/20', vm.runInContext('chStageScore(7, 1)', sb) === 100)
  }
  // 5f. 别人的记录不吸收（username 不匹配）
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    const rows = [{ username: 'u2', name: '李四', chy: [
      { day: 7, si: 1, kind: 'test', correct: 18, total: 20, at: 1790130000000, rd: '', manual: true },
    ] }]
    const changed = absorbIn(sb, rows)
    assert('非本人记录 → 不吸收', changed === false)
  }
}

console.log('=== 组 6：接线与源码护栏（函数存在 ≠ 功能存在）===')
{
  assert('challenge.js 定义了 chAbsorbManualScores', CH_SRC.includes('function chAbsorbManualScores'))
  assert('chLoadLeaderboard 里真实调用（接线）',
    /const rows = await CloudSync\.getDashboardData\(\)/.test(CH_SRC)
    && /chAbsorbManualScores\(rows\)/.test(CH_SRC))
  assert('学员真实成绩优先（done 且非 manual 不覆盖）',
    CH_SRC.includes('if (rec && rec.done && !rec.manual) return'))
  assert('cleared 存根可被恢复（与 chyfix 同口径）', CH_SRC.includes('覆盖恢复成绩'))
  assert('仅非答题会话重渲染', CH_SRC.includes('if (!chs || chs.phase !== \'quiz\') renderChallenge()'))
  assert('cloud-store chyfix 定位不再跳过 cleared（v108）',
    /if \(!x \|\| x\.kind !== 'test'\) continue/.test(CLOUD_SRC)
    && !/if \(!x \|\| x\.kind !== 'test' \|\| x\.cleared\) continue/.test(CLOUD_SRC))
  assert('cloud-store chyfix 覆写不再保留 cleared 标记',
    !/\.\.\.\(x\.cleared \? \{ cleared: true \} : \{\}\)/.test(CLOUD_SRC))
}

console.log('')
const total = n
console.log(testFailed ? `❌ ${total} 断言中有失败项` : `✅ 全部通过（${total} 断言）`)
process.exit(testFailed ? 1 : 0)

})().catch(e => { console.log('CRASH', e && e.stack); process.exit(1) })
