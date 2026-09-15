// ====== 测试 v83：管理员重置某学员的七天挑战 ======
// ① CloudSync.setChallengeReset：doc.chResets[用户名] 打时间戳（写后校验）+ 推送 chreset 事件；失败重试后 ok:false
// ② _apply('chreset')：清空该学员 chy / chQ，不影响其他学员与全局 __q、普通 perQ；重置后新 chy 正常累计
// ③ 学员端 chCheckRemoteReset：云端标记更新 → 清空本地进度、记录已处理标记、只触发一次；无标记/旧标记不动
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
function makeChSandbox(chResets, localStore) {
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
    __resets: chResets,      // 须在 CloudSync 定义前就位（const CloudSync 捕获的是此刻的值）
    __user: 'alice',
  }
  sb.window = sb
  vm.createContext(sb)
  // 依赖：challengeUid（会话用户名）、challengeSave、Store
  vm.runInContext(`
    const CHALLENGE_KEY = 'eq_challenge_v2'
    let challengeState = null
    let chs = { phase: 'quiz' }
    function challengeSave() { localStorage.setItem(CHALLENGE_KEY, JSON.stringify(challengeState)) }
    const Store = { getSession: () => ({ username: window.__user || 'alice' }) }
    const CloudSync = { _chResets: window.__resets }
  `, sb)
  const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
  vm.runInContext(extractFn(chSrc, 'challengeUid'), sb)
  vm.runInContext(extractFn(chSrc, 'chCheckRemoteReset'), sb)
  vm.runInContext(extractFn(chSrc, 'chResetNoticeActive'), sb)
  vm.runInContext('let _chResetNotice = false\nlet _chResetNoticeAt = 0', sb)
  return sb
}

;(async () => {
  console.log('\n🧪 v83 重置七天挑战测试')

  // ---------- ① setChallengeReset ----------
  console.log('\n[1] CloudSync.setChallengeReset（云端标记 + chreset 事件）')
  {
    const doc = { v: 1, base: { alice: { username: 'alice', chy: [{ day: 1, si: 0, kind: 'test', correct: 8, total: 20, at: 100 }], chQ: { 9: { correct: 0, total: 2 } } } }, events: [] }
    const sb = makeCloudSandbox(doc)
    const res = await vm.runInContext('CloudSync.setChallengeReset("alice", "Alice")', sb)
    assert('返回 ok:true', res && res.ok === true, JSON.stringify(res))
    assert('doc.chResets.alice 写入时间戳', Number(doc.chResets && doc.chResets.alice) > 0, JSON.stringify(doc.chResets))
    const ev = (doc.events || []).find(e => e.ty === 'chreset')
    assert('推送了 chreset 事件（带用户名与时间戳）', !!ev && ev.u === 'alice' && ev.ts === doc.chResets.alice, JSON.stringify(doc.events))
    assert('侧信道 _chResets 已同步', vm.runInContext('CloudSync._chResets.alice', sb) === doc.chResets.alice)
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
  console.log('\n[2] _apply：chreset 清空该学员挑战数据')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    const out = vm.runInContext(`
      const map = {
        alice: { username: 'alice', chy: [{ day: 1, si: 0, kind: 'test', correct: 8, total: 20, at: 1 }],
                 chQ: { 9: { correct: 0, total: 2 } }, perQ: { 77: { correct: 0, total: 1 } } },
        bob: { username: 'bob', chy: [{ day: 2, si: 0, kind: 'practice', correct: 10, total: 30, at: 2 }] },
        __q: { 9: [3, 5] },
      }
      CloudSync._apply(map, { u: 'alice', ty: 'chreset', ts: 500, d: {} })
      // 重置后重新上报的 chy 正常累计
      CloudSync._apply(map, { u: 'alice', ty: 'chy', ts: 600, d: { day: 1, si: 0, kind: 'test', correct: 5, total: 20, usedSec: 100 } })
      window.__m = map
    `, sb)
    assert('alice.chy 清零后仅剩重置后的新记录', vm.runInContext('window.__m.alice.chy.length === 1 && window.__m.alice.chy[0].correct === 5', sb))
    assert('alice.chQ 已清空', vm.runInContext('Object.keys(window.__m.alice.chQ).length === 0', sb))
    assert('alice.perQ（普通练习明细）不受影响', vm.runInContext('window.__m.alice.perQ["77"].total === 1', sb))
    assert('全局 __q 不受影响', vm.runInContext('window.__m.__q["9"][0] === 3 && window.__m.__q["9"][1] === 5', sb))
    assert('其他学员（bob）数据不动', vm.runInContext('window.__m.bob.chy.length === 1', sb))
    assert('记录 chResetAt = 事件时间', vm.runInContext('window.__m.alice.chResetAt === 500', sb))
  }

  // ---------- ③ 学员端本地清空 ----------
  console.log('\n[3] chCheckRemoteReset：本地进度清空（只触发一次）')
  {
    const localStore = { eq_challenge_v2: JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true }, 1: { done: true } }, } } }) }
    const sb = makeChSandbox({ alice: 1700000000000 }, localStore)
    const fired = vm.runInContext('chCheckRemoteReset()', sb)
    assert('云端重置标记更新 → 返回 true（触发重置）', fired === true)
    assert('本地挑战进度已清空', (() => {
      const st = JSON.parse(localStore.eq_challenge_v2)
      return st.uid === 'alice' && Object.keys(st.days).length === 0
    })(), localStore.eq_challenge_v2)
    assert('已处理标记落盘（按用户）', localStore['eq_ch_reset_seen_alice'] === '1700000000000', String(localStore['eq_ch_reset_seen_alice']))
    assert('提示态激活（10 分钟内可见）', vm.runInContext('chResetNoticeActive()', sb) === true)
    assert('再次调用不重复触发', vm.runInContext('chCheckRemoteReset()', sb) === false)
  }
  {
    // 无标记 / 旧标记 → 不动本地进度
    const st = JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true } } } } })
    const s1 = { eq_challenge_v2: st }
    const sb1 = makeChSandbox({}, s1)
    assert('云端无该学员标记 → 不重置', vm.runInContext('chCheckRemoteReset()', sb1) === false && JSON.parse(s1.eq_challenge_v2).days['1'] !== undefined)
    const s2 = { eq_challenge_v2: st, eq_ch_reset_seen_alice: '1800000000000' }
    const sb2 = makeChSandbox({ alice: 1700000000000 }, s2)   // 云端更旧（已被处理过）
    assert('云端标记不比本地新 → 不重置（保进度）', vm.runInContext('chCheckRemoteReset()', sb2) === false && JSON.parse(s2.eq_challenge_v2).days['1'] !== undefined)
    assert('未登录/其他学员标记不影响本人', (() => {
      const s3 = { eq_challenge_v2: st }
      const sb3 = makeChSandbox({ bob: 1900000000000 }, s3)
      return vm.runInContext('chCheckRemoteReset()', sb3) === false && JSON.parse(s3.eq_challenge_v2).days['1'] !== undefined
    })())
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
  assert('cloud-store 侧信道与写后校验齐备', cloudSrc.includes('this._chResets = (doc.chResets') && cloudSrc.includes("case 'chreset':") && cloudSrc.includes('check.chResets'))
  const keys = ['dashChThOps:', 'dashChResetBtn:', 'dashChResetWorking:', 'dashChResetConfirm:', 'dashChResetOk:', 'dashChResetFail:', 'dashChResetHint:', 'chResetNotice:', 'chResetNoticeHint:']
  const bad = keys.filter(k => i18nSrc.split(k).length - 1 !== 2)
  assert('i18n 9 键 zh/en 成对', bad.length === 0, bad.join(','))

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ v83 重置挑战测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
