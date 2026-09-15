// ====== 测试 v83：管理员重置某学员的挑战记录（v84 收窄为「只重置考试成绩」） ======
// ① CloudSync.setChallengeReset：doc.chResets[用户名] 时间戳 + chResetModes[用户名]='exam'（写后校验）
//    + 推送 chreset 事件（d.mode='exam'）；失败重试后 ok:false
// ② _apply('chreset')：
//    mode='exam' → 测试记录降级为「已重置存根」（保留 day/si/at 供进度与打卡统计，分数清零），练习记录与 chQ 保留
//    无 mode（v83 旧事件）→ 兼容整表清空 chy/chQ
//    两者都不影响其他学员、全局 __q、普通 perQ；重置后新的 chy 正常累计
// ③ 学员端 chCheckRemoteReset：按 chResetModes 分流——exam 只降级本地测试阶段（练习与天数链保留）；
//    无 mode→整表清空；无考试成绩可清→静默；标记只处理一次；CloudSync 缺失不崩
// ④ 管理端接线：明细表操作列 + dashResetChUser 定义与调用 + i18n 键成对
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
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
// 与 challenge.js CHALLENGE_DAYS 对应的阶段结构（Day1/Day7 各 2 阶段，其余 1 阶段）
const DAYS_MINI = [
  { day: 1, stages: [{ kind: 'test', count: 20 }, { kind: 'practice', count: 10 }] },
  { day: 2, stages: [{ kind: 'practice', count: 30 }] },
  { day: 3, stages: [{ kind: 'practice', count: 30 }] },
  { day: 4, stages: [{ kind: 'practice', count: 30 }] },
  { day: 5, stages: [{ kind: 'practice', count: 30 }] },
  { day: 6, stages: [{ kind: 'practice', count: 30 }] },
  { day: 7, stages: [{ kind: 'practice', count: 10 }, { kind: 'test', count: 20 }] },
]

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
  // 云端：GET 返回当前 doc 深拷贝（带 events 校验），POST 覆盖
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8') + '\n;CloudSync', sb)
  return sb
}

// ---------- 学员端沙箱（challenge.js 的重置检测相关函数） ----------
function makeChSandbox(chResets, localStore, chResetModes) {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Date, Set,
    localStorage: {
      store: localStore,
      getItem(k) { return this.store[k] == null ? null : this.store[k] },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: { getElementById() { return null } },
    setTimeout, clearTimeout,
    __resets: chResets,          // 须在 CloudSync 定义前就位（const CloudSync 捕获的是此刻的值）
    __resetModes: chResetModes || {},
    __user: 'alice',
  }
  sb.window = sb
  vm.createContext(sb)
  // 依赖：challengeUid（会话用户名）、challengeSave、Store、CHALLENGE_DAYS
  vm.runInContext(`
    const CHALLENGE_KEY = 'eq_challenge_v2'
    const CHALLENGE_DAYS = ${JSON.stringify(DAYS_MINI)}
    let challengeState = null
    let chs = { phase: 'quiz' }
    function challengeSave() { localStorage.setItem(CHALLENGE_KEY, JSON.stringify(challengeState)) }
    // 测试用：模拟 challengeLoad 的本地进度载入（真实流程由 challengeLoad 完成）
    function __loadState() { try { challengeState = JSON.parse(localStorage.getItem(CHALLENGE_KEY) || 'null') } catch (e) { challengeState = null } }
    const Store = { getSession: () => ({ username: window.__user || 'alice' }) }
    const CloudSync = { _chResets: window.__resets, _chResetModes: window.__resetModes }
  `, sb)
  const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
  vm.runInContext(extractFn(chSrc, 'challengeUid'), sb)
  vm.runInContext(extractFn(chSrc, 'chClearExamStageRecs'), sb)
  vm.runInContext(extractFn(chSrc, 'chCheckRemoteReset'), sb)
  vm.runInContext(extractFn(chSrc, 'chResetNoticeActive'), sb)
  vm.runInContext(extractFn(chSrc, 'chResetNoticeIsExam'), sb)
  vm.runInContext('let _chResetNotice = false\nlet _chResetNoticeMode = \'\'\nlet _chResetNoticeAt = 0', sb)
  return sb
}

;(async () => {
  console.log('\n🧪 v83 重置挑战测试（v84 口径：只重置考试成绩）')

  // ---------- ① setChallengeReset ----------
  console.log('\n[1] CloudSync.setChallengeReset（云端标记 + exam 模式 + chreset 事件）')
  {
    const doc = { v: 1, base: { alice: { username: 'alice', chy: [{ day: 1, si: 0, kind: 'test', correct: 8, total: 20, at: 100 }], chQ: { 9: { correct: 0, total: 2 } } } }, events: [] }
    const sb = makeCloudSandbox(doc)
    const res = await vm.runInContext('CloudSync.setChallengeReset("alice", "Alice")', sb)
    assert('返回 ok:true', res && res.ok === true, JSON.stringify(res))
    assert('doc.chResets.alice 写入时间戳', Number(doc.chResets && doc.chResets.alice) > 0, JSON.stringify(doc.chResets))
    assert('doc.chResetModes.alice = exam（只重置考试成绩）', (doc.chResetModes || {}).alice === 'exam', JSON.stringify(doc.chResetModes))
    const ev = (doc.events || []).find(e => e.ty === 'chreset')
    assert('推送了 chreset 事件（带用户名、时间戳与 mode）', !!ev && ev.u === 'alice' && ev.ts === doc.chResets.alice && ev.d && ev.d.mode === 'exam', JSON.stringify(doc.events))
    assert('侧信道 _chResets 已同步', vm.runInContext('CloudSync._chResets.alice', sb) === doc.chResets.alice)
    assert('侧信道 _chResetModes 已同步', vm.runInContext('CloudSync._chResetModes.alice', sb) === 'exam')
  }
  {
    // 空用户名拒绝
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    const res = await vm.runInContext('CloudSync.setChallengeReset("", "")', sb)
    assert('空用户名 → ok:false reason:nouser', res && res.ok === false && res.reason === 'nouser')
  }
  {
    // 网络失败（GET 直接 500）→ 重试后 ok:false，不写坏文档
    const doc = { v: 1, base: {}, events: [] }
    const sb = makeCloudSandbox(doc)
    vm.runInContext('window.fetch = async () => ({ ok: false, status: 500, text: async () => "" })', sb)
    const res = await vm.runInContext('CloudSync.setChallengeReset("bob", "Bob")', sb)
    assert('写入校验失败 → ok:false reason:network（4 次重试）', res && res.ok === false && res.reason === 'network', JSON.stringify(res))
    assert('失败不产生 chreset 事件', !(doc.events || []).some(e => e.ty === 'chreset'))
  }

  // ---------- ② _apply('chreset') ----------
  console.log('\n[2] _apply：exam 模式只清考试成绩（进度/打卡/错题保留）')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    vm.runInContext(`
      const map = {
        alice: { username: 'alice', chy: [
            { day: 1, si: 0, kind: 'test', correct: 8, total: 20, usedSec: 300, at: 1 },
            { day: 1, si: 1, kind: 'practice', correct: 9, total: 10, usedSec: 120, at: 2 },
            { day: 7, si: 1, kind: 'test', correct: 18, total: 20, usedSec: 400, at: 3 }],
          chQ: { 9: { correct: 0, total: 2 } }, perQ: { 77: { correct: 0, total: 1 } } },
        bob: { username: 'bob', chy: [{ day: 2, si: 0, kind: 'practice', correct: 10, total: 30, at: 2 }] },
        __q: { 9: [3, 5] },
      }
      CloudSync._apply(map, { u: 'alice', ty: 'chreset', ts: 500, d: { mode: 'exam' } })
      window.__m = map
    `, sb)
    const chy = vm.runInContext('window.__m.alice.chy', sb)
    assert('测试记录保留（条数不变，进度与打卡统计不丢）', chy.length === 3)
    const t1 = chy.find(x => x.day === 1 && x.kind === 'test')
    assert('Day1 测试 → 存根：分数清零 + cleared 标记', t1 && t1.cleared === true && t1.correct === 0 && t1.total === 0 && t1.usedSec === 0, JSON.stringify(t1))
    assert('存根保留 day/si/kind/at（进度链与打卡不受影响）', t1.day === 1 && t1.si === 0 && t1.kind === 'test' && t1.at === 1)
    const t7 = chy.find(x => x.day === 7 && x.kind === 'test')
    assert('Day7 期末测试同样被清分（3 倍权重部分不再计分）', t7 && t7.cleared === true && t7.correct === 0 && t7.total === 0)
    const p = chy.find(x => x.kind === 'practice')
    assert('练习阶段记录原样保留（分数与用时不变）', p.correct === 9 && p.total === 10 && p.usedSec === 120 && !p.cleared)
    assert('挑战错题 chQ 保留（只重置考试成绩）', vm.runInContext('window.__m.alice.chQ["9"].total === 2', sb))
    assert('perQ（普通练习明细）不受影响', vm.runInContext('window.__m.alice.perQ["77"].total === 1', sb))
    assert('全局 __q 不受影响', vm.runInContext('window.__m.__q["9"][0] === 3 && window.__m.__q["9"][1] === 5', sb))
    assert('其他学员（bob）数据不动', vm.runInContext('window.__m.bob.chy.length === 1', sb))
    assert('记录 chResetAt / chResetMode', vm.runInContext('window.__m.alice.chResetAt === 500 && window.__m.alice.chResetMode === "exam"', sb))
    // 重考后新记录正常追加
    vm.runInContext(`CloudSync._apply(window.__m, { u: 'alice', ty: 'chy', ts: 600, d: { day: 1, si: 0, kind: 'test', correct: 15, total: 20, usedSec: 200 } })`, sb)
    const chy2 = vm.runInContext('window.__m.alice.chy', sb)
    assert('重考新记录正常追加（4 条，未被重置规则吞掉）', chy2.length === 4 && chy2[3].correct === 15 && !chy2[3].cleared)
    // 重复重放同一 chreset 事件：幂等（存根已 cleared，不会把重考成绩也清掉）
    vm.runInContext(`CloudSync._apply(window.__m, { u: 'alice', ty: 'chreset', ts: 500, d: { mode: 'exam' } })`, sb)
    const chy3 = vm.runInContext('window.__m.alice.chy', sb)
    assert('事件重放幂等（存根不再变化，重考成绩保留）', chy3.length === 4 && chy3[3].correct === 15 && chy3[3].cleared === undefined)
  }
  {
    // v83 旧事件（无 mode 字段）→ 兼容整表清空
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    vm.runInContext(`
      const map = { alice: { username: 'alice',
        chy: [{ day: 1, si: 0, kind: 'test', correct: 8, total: 20, at: 1 }, { day: 2, si: 0, kind: 'practice', correct: 10, total: 30, at: 2 }],
        chQ: { 9: { correct: 0, total: 2 } } } }
      CloudSync._apply(map, { u: 'alice', ty: 'chreset', ts: 700, d: {} })
      window.__m = map
    `, sb)
    assert('v83 旧事件（无 mode）→ 整表清空（向后兼容）', vm.runInContext('window.__m.alice.chy.length === 0 && Object.keys(window.__m.alice.chQ).length === 0', sb))
    assert('记录模式为 all', vm.runInContext('window.__m.alice.chResetMode === "all"', sb))
  }

  // ---------- ③ 学员端本地处理 ----------
  console.log('\n[3] chCheckRemoteReset：exam 模式只清本地考试成绩')
  {
    const localStore = {
      eq_challenge_v2: JSON.stringify({
        uid: 'alice',
        days: {
          1: { stages: { 0: { done: true, at: 5, correct: 8, total: 20, wrong: ['7'] }, 1: { done: true, at: 9, correct: 9, total: 10, wrong: [] } } },
          2: { stages: { 0: { done: true, at: 20, correct: 28, total: 30, wrong: ['5'] } } },
        },
      }),
    }
    const sb = makeChSandbox({ alice: 1700000000000 }, localStore, { alice: 'exam' })
    const fired = vm.runInContext('__loadState(); chCheckRemoteReset()', sb)
    assert('云端重置标记更新 → 返回 true（触发重置）', fired === true)
    const st = JSON.parse(localStore.eq_challenge_v2)
    const day1 = st.days['1'].stages
    assert('Day1 测试阶段 → 存根（分数清空、done 去除= 可重考）', day1['0'].cleared === true && !day1['0'].done, JSON.stringify(day1['0']))
    assert('存根保留完成时间与题量（进度条/天数链不受影响）', day1['0'].at === 5 && day1['0'].total === 20)
    assert('Day1 练习阶段原样保留', day1['1'].done === true && day1['1'].correct === 9 && day1['1'].wrong.length === 0)
    assert('其他天（Day2）进度原样保留', st.days['2'].stages['0'].done === true && st.days['2'].stages['0'].correct === 28)
    assert('已处理标记落盘（按用户）', localStore['eq_ch_reset_seen_alice'] === '1700000000000', String(localStore['eq_ch_reset_seen_alice']))
    assert('提示态激活且为考试成绩模式', vm.runInContext('chResetNoticeActive()', sb) === true && vm.runInContext('chResetNoticeIsExam()', sb) === true)
    assert('再次调用不重复触发', vm.runInContext('chCheckRemoteReset()', sb) === false)
  }
  {
    // v83 旧标记（无模式记录）→ 兼容整表清空，提示为通用文案
    const localStore = { eq_challenge_v2: JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true }, 1: { done: true } } } } }) }
    const sb = makeChSandbox({ alice: 1700000000000 }, localStore, {})
    assert('旧标记（无模式）→ 整表清空 + 通用提示', vm.runInContext('__loadState(); chCheckRemoteReset()', sb) === true
      && JSON.parse(localStore.eq_challenge_v2).days && Object.keys(JSON.parse(localStore.eq_challenge_v2).days).length === 0
      && vm.runInContext('chResetNoticeIsExam()', sb) === false)
  }
  {
    // 该学员还没有考试成绩 → 静默（不打扰），但标记照样处理掉
    const localStore = { eq_challenge_v2: JSON.stringify({ uid: 'alice', days: { 2: { stages: { 0: { done: true } } } } }) }
    const sb = makeChSandbox({ alice: 1700000000000 }, localStore, { alice: 'exam' })
    assert('无考试成绩可清 → 返回 false（不弹提示）', vm.runInContext('__loadState(); chCheckRemoteReset()', sb) === false)
    assert('标记已消费（不再重复检查）', localStore['eq_ch_reset_seen_alice'] === '1700000000000' && vm.runInContext('chCheckRemoteReset()', sb) === false)
    assert('未完成的记录不被动', JSON.parse(localStore.eq_challenge_v2).days['2'].stages['0'].done === true)
  }
  {
    // 无标记 / 旧标记 / 他人标记 → 不动本地进度
    const mk = () => JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true } } } } })
    const s1 = { eq_challenge_v2: mk() }
    const sb1 = makeChSandbox({}, s1, {})
    assert('云端无该学员标记 → 不重置', vm.runInContext('chCheckRemoteReset()', sb1) === false && JSON.parse(s1.eq_challenge_v2).days['1'] !== undefined)
    const s2 = { eq_challenge_v2: mk(), eq_ch_reset_seen_alice: '1800000000000' }
    const sb2 = makeChSandbox({ alice: 1700000000000 }, s2, { alice: 'exam' })   // 云端更旧（已被处理过）
    assert('云端标记不比本地新 → 不重置（保进度）', vm.runInContext('chCheckRemoteReset()', sb2) === false && JSON.parse(s2.eq_challenge_v2).days['1'] !== undefined)
    const s3 = { eq_challenge_v2: mk() }
    const sb3 = makeChSandbox({ bob: 1900000000000 }, s3, { bob: 'exam' })
    assert('未登录/其他学员标记不影响本人', vm.runInContext('chCheckRemoteReset()', sb3) === false && JSON.parse(s3.eq_challenge_v2).days['1'] !== undefined)
  }
  {
    // CloudSync 不存在（老缓存/测试环境）→ 不崩
    const sb = {
      console, JSON, Object, Array, String, Number, Math, Date,
      localStorage: { store: {}, getItem() { return null }, setItem() {}, removeItem() {} },
      document: { getElementById: () => null }, setTimeout, clearTimeout,
    }
    sb.window = sb
    vm.createContext(sb)
    const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
    vm.runInContext(`
      let challengeState = null
      let chs = null
      function challengeUid() { return 'alice' }
    `, sb)
    vm.runInContext(extractFn(chSrc, 'chClearExamStageRecs'), sb)
    vm.runInContext(extractFn(chSrc, 'chCheckRemoteReset'), sb)
    assert('CloudSync 未定义 → 返回 false 不抛错', vm.runInContext('chCheckRemoteReset()', sb) === false)
  }

  // ---------- ④ 接线与 i18n ----------
  console.log('\n[4] 管理端接线与 i18n')
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
  const cloudSrc = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
  assert('app.js 定义 dashResetChUser 并调用 setChallengeReset', appSrc.includes('async function dashResetChUser') && appSrc.includes('CloudSync.setChallengeReset(username, name)'))
  assert('明细表含操作列与重置按钮（按行索引 id）', appSrc.includes('dashChThOps') && appSrc.includes('dashChResetBtn_${pi}') && appSrc.includes("dashResetChUser(${JSON.stringify(p.username)}"))
  assert('重置按钮带二次确认（confirm）', /async function dashResetChUser[\s\S]{0,300}?confirm\(t\('dashChResetConfirm'/.test(appSrc))
  assert('challenge.js 在 challengeLoad / chLoadLeaderboard 中检测重置', /function challengeLoad[\s\S]{0,900}?return chCheckRemoteReset\(\)/.test(chSrc) && chSrc.includes('if (chCheckRemoteReset()) renderChallenge()'))
  assert('cloud-store 侧信道与写后校验齐备', cloudSrc.includes('this._chResets = (doc.chResets') && cloudSrc.includes('this._chResetModes = (doc.chResetModes')
    && cloudSrc.includes("case 'chreset':") && cloudSrc.includes('check.chResets'))
  const keys = ['dashChThOps:', 'dashChResetBtn:', 'dashChResetWorking:', 'dashChResetConfirm:', 'dashChResetOk:', 'dashChResetFail:', 'dashChResetHint:', 'chResetNotice:', 'chResetNoticeHint:', 'chResetExamNotice:', 'chResetExamNoticeHint:', 'chResetExamRetake:']
  const bad = keys.filter(k => i18nSrc.split(k).length - 1 !== 2)
  assert('i18n 12 键 zh/en 成对', bad.length === 0, bad.join(','))

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ v83 重置挑战测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
