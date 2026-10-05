// ====== 测试 v140：七天挑战云端进度恢复（换设备/浏览器不再从 Day1 重来） ======
// 用户痛点：挑战进度权威在本机 localStorage，换设备后挑战页从 Day1 重新显示未完成（云端成绩还在看板）。
// v140 把 v108 的 chAbsorbManualScores 泛化为 chAbsorbCloudProgress：
//   积分榜拉取时把本人当前营次的全部未重置云端 chy 记录（练习+考试、补录或真实上报）恢复进本地进度。
// 口径：真实成绩优先 > 云端补录 > 重置存根恢复；别营次 / cleared 记录不恢复；幂等。
// 沙箱骨架沿用 test-v108（challenge.js 整载 + eq_session 登录态）。
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

const CH_SRC = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')

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

const absorbIn = (sb, rows, expr) => {
  sb.__rows = rows
  return vm.runInContext('chAbsorbCloudProgress(window.__rows)' + (expr ? '; ' + expr : ''), sb)
}

;(async () => {
  console.log('\n🧪 v140 七天挑战云端进度恢复')

  // ---------- ① 主场景：换设备后全量恢复 ----------
  console.log('\n[1] 换设备主场景：空本地 + 云端练习/考试混合记录 → 全部恢复')
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    assert('恢复前本地为空（新设备）', vm.runInContext('Object.keys(challengeState.days).length', sb) === 0)
    const rows = [{ username: 'u1', name: '张三', dept: 'dining/sig', chy: [
      { day: 1, si: 0, kind: 'test', correct: 18, total: 20, usedSec: 200, at: 1790000000000, rd: '' },
      { day: 1, si: 1, kind: 'practice', correct: 10, total: 10, usedSec: 60, at: 1790000100000, rd: '' },
      { day: 3, si: 0, kind: 'practice', correct: 25, total: 30, usedSec: 150, at: 1790020000000, rd: '' },
      { day: 7, si: 0, kind: 'practice', correct: 10, total: 10, usedSec: 90, at: 1790030000000, rd: '' },
      { day: 7, si: 1, kind: 'test', correct: 16, total: 20, usedSec: 300, at: 1790031000000, rd: '' },
    ] }]
    const changed = absorbIn(sb, rows)
    assert('吸收返回 changed=true', changed === true, String(changed))
    assert('Day1 摸底考恢复（18/20=90）', vm.runInContext('chStageDone(1, 0) && chStageScore(1, 0) === 90', sb) === true)
    assert('Day1 练习恢复（10/10=100）', vm.runInContext('chStageDone(1, 1) && chStageScore(1, 1) === 100', sb) === true)
    assert('Day3 练习恢复（25/30）', vm.runInContext('chStageDone(3, 0) && chStageScore(3, 0) === Math.round(25 / 30 * 100)', sb) === true)
    assert('Day7 期末考恢复（16/20=80）', vm.runInContext('chStageDone(7, 1) && chStageScore(7, 1) === 80', sb) === true)
    assert('恢复记录统一打 restored 标记', vm.runInContext(
      '[["1","0"],["1","1"],["3","0"],["7","0"],["7","1"]].every(k => challengeState.days[k[0]].stages[k[1]].restored === true)', sb) === true)
    assert('恢复记录落盘（challengeSave）', vm.runInContext(
      'JSON.parse(localStorage.getItem(chStorageKey())).days["7"].stages["1"].done === true', sb) === true)
    // 幂等：同一 rows 再吸收一次
    const before = vm.runInContext('JSON.stringify(challengeState.days)', sb)
    absorbIn(sb, rows)
    assert('同一 rows 重复吸收幂等', vm.runInContext('JSON.stringify(challengeState.days)', sb) === before)
  }

  // ---------- ② 不该恢复的记录 ----------
  console.log('\n[2] 隔离与重置语义')
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 2, si: 0, kind: 'practice', correct: 10, total: 10, at: 1790000000000, rd: 'r2' },  // 别的营次
      { day: 3, si: 0, kind: 'test', correct: 0, total: 0, at: 1790000000001, rd: '', cleared: true }, // 已重置存根
      { day: 4, si: 0, kind: 'practice', correct: 5, total: 10, at: 1790000000002, rd: '' },     // 正常恢复
    ] }]
    absorbIn(sb, rows)
    assert('别营次不恢复', vm.runInContext('chStageDone(2, 0)', sb) === false)
    assert('cleared 云端存根不恢复', vm.runInContext('chStageDone(3, 0)', sb) === false)
    assert('当前营次正常记录恢复', vm.runInContext('chStageDone(4, 0)', sb) === true)
  }

  // ---------- ③ 优先级：本地真实成绩 > 云端 ----------
  console.log('\n[3] 优先级与覆盖规则')
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    vm.runInContext('challengeState.days[7] = { stages: { 1: { done: true, at: 1790100000000, correct: 20, total: 20, wrong: [] } } }; challengeSave()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 7, si: 1, kind: 'test', correct: 10, total: 20, at: 1790130000000, rd: '' },
    ] }]
    absorbIn(sb, rows)
    assert('本地真实成绩优先，云端不覆盖（仍 20/20）', vm.runInContext('chStageScore(7, 1)', sb) === 100)
  }
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    vm.runInContext('challengeState.days[7] = { stages: { 1: { cleared: true, at: 1790100000000, total: 20 } } }; challengeSave()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 7, si: 1, kind: 'test', correct: 18, total: 20, at: 1790130000000, rd: '' },  // 重考后的真实成绩
    ] }]
    absorbIn(sb, rows)
    assert('本地重置存根被云端重考成绩恢复（18/20=90）', vm.runInContext('chStageDone(7, 1) && chStageScore(7, 1) === 90', sb) === true)
    assert('恢复后不再是存根', vm.runInContext('chStageCleared(7, 1)', sb) === false)
  }
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    vm.runInContext('challengeState.days[7] = { stages: { 1: { done: true, at: 1790130000000, correct: 18, total: 20, wrong: [], manual: true } } }; challengeSave()', sb)
    const rows = [{ username: 'u1', name: '张三', chy: [
      { day: 7, si: 1, kind: 'test', correct: 20, total: 20, at: 1790130000000, rd: '', manual: true },  // chyfix 改分
    ] }]
    absorbIn(sb, rows)
    assert('本地补录 + 云端补录改分 → 云端覆盖（20/20，v108 口径延续）', vm.runInContext('chStageScore(7, 1)', sb) === 100)
  }
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    const rows = [{ username: 'u2', name: '李四', chy: [
      { day: 1, si: 0, kind: 'test', correct: 18, total: 20, at: 1790130000000, rd: '' },
    ] }]
    const changed = absorbIn(sb, rows)
    assert('非本人记录 → 不吸收', changed === false)
  }

  // ---------- ④ 接线与源码护栏 ----------
  console.log('\n[4] 接线与源码护栏（函数存在 ≠ 功能存在）')
  assert('challenge.js 定义 chAbsorbCloudProgress', CH_SRC.includes('function chAbsorbCloudProgress'))
  assert('chLoadLeaderboard 真实调用（接线）',
    /chAbsorbCloudProgress\(rows\)/.test(CH_SRC))
  assert('cleared 云端记录不恢复（重置语义优先）', /if \(!x \|\| x\.cleared\) return/.test(CH_SRC))
  assert('当前营次过滤（rd 归一比对）', CH_SRC.includes("chRoundSlug(String((x && x.rd) || '')) !== wantSlug"))
  assert('仅非答题会话重渲染', CH_SRC.includes("if (!chs || chs.phase !== 'quiz') renderChallenge()"))
  assert('旧函数名 chAbsorbManualScores 不再残留（契约已反转）', !/function chAbsorbManualScores/.test(CH_SRC))

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ v140 云端进度恢复测试全部通过')
  console.log(`（共 ${n} 条断言）`)
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
