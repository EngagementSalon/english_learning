// ====== 测试 v103：重置「跨营次误删」修复 ======
// 线上真实事故：r1 标帜餐厅（dining/sig）与 r2 艳中餐厅（dining/yan）并存，指针 chRoundCur='r1'。
// 管理员给「艳中餐厅学员」点重置 → v88/v99 按全局指针取 round='r1'，而该学员考试记录 rd='r2'
// → inRound 全判否 → 走 else 整表清空分支 → 学员刚考完的 Day7 期末成绩被永久删除。
//
// 本测试锁死两件事：
// ① setChallengeReset 按**学员自己拥有的营次**逐条落刀（不再读全局指针）
// ② _apply('chreset') 的爆炸半径守卫：口径错位时宁可不清，也不整表清空
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

const CLOUD_SRC = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')

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
  vm.runInContext(CLOUD_SRC + '\n;CloudSync', sb)
  sb.__docRef = docRef          // 供测试从沙箱内读取当前云端文档（base + events 重放）
  return sb
}

// 线上真实 doc 形状：两个营次 + 指针 r1 + 一个艳中(r2)学员已考完 Day7 期末
function realDoc() {
  return {
    v: 1,
    chOpen: true,
    chRoundCur: 'r1',
    chRounds: [
      { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, examOpen: true, startAt: 0, endAt: 0, examStartAt: 0, examEndAt: 0, at: 1790058244386 },
      { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: true, examOpen: true, startAt: 1790006340000, endAt: 1790697540000, examStartAt: 0, examEndAt: 0, at: 1790057352042 },
    ],
    chRoundLevels: { r1: { chResets: {}, chResetModes: {} }, r2: { chResets: {}, chResetModes: {} } },
    base: {
      艳中学员: {
        username: '艳中学员', name: '艳中学员', dept: 'dining/yan',
        chy: [
          { day: 1, si: 0, kind: 'test', correct: 18, total: 20, usedSec: 200, at: 1790000000000, rd: 'r2' },
          { day: 6, si: 0, kind: 'practice', correct: 30, total: 30, usedSec: 300, at: 1790010000000, rd: 'r2' },
          { day: 7, si: 0, kind: 'practice', correct: 10, total: 10, usedSec: 90, at: 1790020000000, rd: 'r2' },
          { day: 7, si: 1, kind: 'test', correct: 19, total: 20, usedSec: 120, at: 1790030000000, rd: 'r2' },
        ],
      },
      标帜学员: {
        username: '标帜学员', name: '标帜学员', dept: 'dining/sig',
        chy: [
          { day: 1, si: 0, kind: 'test', correct: 20, total: 20, usedSec: 100, at: 1790000000000, rd: '' },
          { day: 7, si: 1, kind: 'test', correct: 17, total: 20, usedSec: 130, at: 1790030000000, rd: 'r1' },
        ],
      },
    },
    events: [],
  }
}

;(async () => {
  console.log('\n🧪 v103 重置跨营次误删修复')

  // ---------- [1] 回归：旧实现会整表清空（用源码级断言证明两者行为差异） ----------
  console.log('\n[1] 事故复现：口径错位时整表清空的爆炸半径')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    // 直接驱动 _apply：模拟旧口径（重置 round='r1'）打到 rd='r2' 的学员身上
    const doc = {
      base: {
        victim: {
          username: 'victim', name: 'v', chy: [
            { day: 7, si: 1, kind: 'test', correct: 19, total: 20, at: 100, rd: 'r2' },
            { day: 6, si: 0, kind: 'practice', correct: 30, total: 30, at: 90, rd: 'r2' },
          ],
        },
      },
    }
    vm.runInContext('window.__d = ' + JSON.stringify(doc), sb)
    // 旧口径事件：mode 缺省/ 'all' + round='r1' —— 守卫必须拦住
    vm.runInContext(`CloudSync._apply(window.__d.base, { u:'victim', ty:'chreset', ts: 200, d:{ mode:'all', round:'r1' } })`, sb)
    const left = vm.runInContext('window.__d.base.victim.chy.length', sb)
    assert('守卫生效：口径错位不再整表清空（记录保留 2 条）', left === 2, '实际 ' + left + ' 条')
    assert('Day7 期末成绩未被删除', vm.runInContext('window.__d.base.victim.chy.some(x => x.day === 7 && x.kind === "test")', sb))
  }

  // ---------- [2] 守卫不误伤：同营次整表清空仍然照常执行 ----------
  console.log('\n[2] 守卫不误伤：同营次「整表清空」仍照常执行')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    const doc = {
      base: {
        u1: {
          username: 'u1', name: 'u1', chy: [
            { day: 3, si: 0, kind: 'practice', correct: 28, total: 30, at: 100, rd: 'r1' },
            { day: 4, si: 0, kind: 'practice', correct: 29, total: 30, at: 110, rd: 'r1' },
          ],
          chQ: { 9: { correct: 0, total: 2 } },
        },
      },
    }
    vm.runInContext('window.__d = ' + JSON.stringify(doc), sb)
    vm.runInContext(`CloudSync._apply(window.__d.base, { u:'u1', ty:'chreset', ts: 200, d:{ mode:'all', round:'r1' } })`, sb)
    assert('全部为同营次（rd=r1）→ 正常清空到 0 条', vm.runInContext('window.__d.base.u1.chy.length', sb) === 0)
    assert('chQ 一并清空（rd=\'\' 口径）', vm.runInContext('JSON.stringify(window.__d.base.u1.chQ)', sb) === '{}')
  }

  // ---------- [3] 守卫不误伤：单营次学员全清仍是合法操作 ----------
  console.log('\n[3] 守卫不误伤：单营次学员清空（无别的营次）允许执行')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    const doc = {
      base: {
        solo: { username: 'solo', name: 'solo', chy: [{ day: 2, si: 0, kind: 'practice', correct: 20, total: 30, at: 5, rd: 'r1' }] },
      },
    }
    vm.runInContext('window.__d = ' + JSON.stringify(doc), sb)
    vm.runInContext(`CloudSync._apply(window.__d.base, { u:'solo', ty:'chreset', ts: 200, d:{ mode:'all', round:'r1' } })`, sb)
    assert('单营次学员被正常清空（0 条）', vm.runInContext('window.__d.base.solo.chy.length', sb) === 0)
  }

  // ---------- [4] 核心修复：重置按学员自己的营次落刀 ----------
  console.log('\n[4] setChallengeReset：按学员自己拥有的营次落刀（不读全局指针）')
  {
    const doc = realDoc()
    const sb = makeCloudSandbox(doc)
    // 指针是 r1，学员记录全是 r2 —— 旧实现会把重置打到 r1（=误删）
    const res = await vm.runInContext('CloudSync.setChallengeReset("艳中学员", "艳中学员")', sb)
    assert('返回 ok:true', res && res.ok === true, JSON.stringify(res))
    assert('目标营次 = 学员自己的 r2（不是指针的 r1）',
      res && Array.isArray(res.rounds) && res.rounds.length === 1 && res.rounds[0] === 'r2',
      JSON.stringify(res && res.rounds))
    assert('chRoundLevels.r2.chResets 已写入',
      Number(((doc.chRoundLevels || {}).r2 || {}).chResets?.艳中学员) > 0,
      JSON.stringify(doc.chRoundLevels))
    assert('chRoundLevels.r2.chResetModes = exam',
      (((doc.chRoundLevels || {}).r2 || {}).chResetModes || {}).艳中学员 === 'exam')
    assert('r1 容器未被误写', Number(((doc.chRoundLevels || {}).r1 || {}).chResets?.艳中学员 || 0) === 0)
    assert('顶层 chResets 未被误写（第一期专属）', Number((doc.chResets || {}).艳中学员 || 0) === 0)
    const evs = (doc.events || []).filter(e => e.ty === 'chreset')
    assert('推送了 1 条 chreset 事件', evs.length === 1, '实际 ' + evs.length)
    assert('事件 d.round = r2', evs[0] && evs[0].d && evs[0].d.round === 'r2', JSON.stringify(evs[0] && evs[0].d))
  }

  // ---------- [5] 端到端：重置后重放，成绩降级为存根且营次隔离 ----------
  console.log('\n[5] 端到端：重置 r2 学员 → 成绩归零，r1 学员不受影响')
  {
    const doc = realDoc()
    const sb = makeCloudSandbox(doc)
    await vm.runInContext('CloudSync.setChallengeReset("艳中学员", "艳中学员")', sb)
    await vm.runInContext('CloudSync.pushPending()', sb)
    // 用看板同口径重放：base + events
    vm.runInContext('window.__doc = window.__docRef', sb)
    const replayed = vm.runInContext(`
      (function(){
        const map = {}
        Object.keys(window.__doc.base || {}).forEach(u => { map[u] = Object.assign({}, window.__doc.base[u]) })
        ;(window.__doc.events || []).forEach(ev => CloudSync._apply(map, ev))
        return map
      })()
    `, sb)
    const yan = replayed && replayed['艳中学员']
    const sig = replayed && replayed['标帜学员']
    assert('艳中学员 Day7 考试分已归零（correct=0）',
      !!yan && yan.chy.some(x => x.day === 7 && x.kind === 'test' && x.cleared === true && x.correct === 0),
      JSON.stringify(yan && yan.chy.filter(x => x.kind === 'test')))
    assert('艳中学员 Day7 考试存根保留（进度/打卡不丢）',
      !!yan && yan.chy.some(x => x.day === 7 && x.si === 1 && x.kind === 'test' && x.at === 1790030000000))
    assert('艳中学员该营次练习记录保留',
      !!yan && yan.chy.some(x => x.day === 7 && x.kind === 'practice'))
    assert('标帜学员 r1 期末成绩完好（未被误伤）',
      !!sig && sig.chy.some(x => x.day === 7 && x.kind === 'test' && x.correct === 17 && !x.cleared),
      JSON.stringify(sig && sig.chy))
  }

  // ---------- [6] 全新学员（无记录）→ 回落当前指针营次 ----------
  console.log('\n[6] 全新学员无任何记录 → 回落当前指针营次（保留「先重置后考」语义）')
  {
    const doc = realDoc()
    doc.base.新学员 = { username: '新学员', name: '新学员', dept: 'dining/sig', chy: [] }
    const sb = makeCloudSandbox(doc)
    const res = await vm.runInContext('CloudSync.setChallengeReset("新学员", "新学员")', sb)
    assert('ok:true', res && res.ok === true, JSON.stringify(res))
    // 第一期归一后记录键是 ''（_roundSlugKey('r1') === ''），与 chy 里 rd 缺省的口径一致
    assert('目标 = 指针营次（第一期归一为 \'\'）', res && res.rounds && res.rounds.length === 1 && res.rounds[0] === '', JSON.stringify(res && res.rounds))
    assert('顶层 chResets 已写入（第一期即顶层）', Number((doc.chResets || {}).新学员) > 0, JSON.stringify(doc.chResets))
  }

  // ---------- [7] 跨营次学员：两条营次都写标记 + 两条事件 ----------
  console.log('\n[7] 跨营次学员（r1 与 r2 都有记录）→ 两条营次各写各的重置')
  {
    const doc = realDoc()
    doc.base.跨期学员 = {
      username: '跨期学员', name: '跨期学员', dept: 'dining/sig',
      chy: [
        { day: 1, si: 0, kind: 'test', correct: 20, total: 20, at: 100, rd: 'r1' },
        { day: 1, si: 0, kind: 'test', correct: 15, total: 20, at: 200, rd: 'r2' },
      ],
    }
    const sb = makeCloudSandbox(doc)
    const res = await vm.runInContext('CloudSync.setChallengeReset("跨期学员", "跨期学员")', sb)
    const rounds = (res && res.rounds) || []
    assert('目标含两个营次', rounds.length === 2 && rounds.indexOf('') >= 0 && rounds.indexOf('r2') >= 0, JSON.stringify(rounds))
    assert('第一期标记写入顶层', Number((doc.chResets || {}).跨期学员) > 0)
    assert('r2 标记写入 chRoundLevels.r2', Number((((doc.chRoundLevels || {}).r2 || {}).chResets || {}).跨期学员) > 0)
    assert('推送 2 条 chreset 事件',
      (doc.events || []).filter(e => e.ty === 'chreset').length === 2,
      String((doc.events || []).filter(e => e.ty === 'chreset').length))
  }

  // ---------- [8] 源码级防回归守卫 ----------
  console.log('\n[8] 源码级防回归守卫')
  {
    const body = CLOUD_SRC.slice(CLOUD_SRC.indexOf('async setChallengeReset'), CLOUD_SRC.indexOf('// ---------- 聚合 ----------'))
    assert('setChallengeReset 不再以 _roundCurrent 作唯一营次来源',
      !/let round = ''\s*\n[\s\S]{0,200}const cur = _roundCurrent\(doc\)\s*\n\s*round = cur \? cur\.id : ''/.test(body),
      '仍存在「round = 当前指针」的旧写法')
    assert('setChallengeReset 遍历学员自己的 chy 收集营次', body.indexOf('collect(brec.chy)') > 0 && body.indexOf("ev.ty === 'chy' && ev.u === u") > 0)
    assert('setChallengeReset 返回 rounds 数组', body.indexOf('rounds: targets') > 0)
    assert('_apply 的 chreset 含爆炸半径守卫', CLOUD_SRC.indexOf('wouldWipeAll && hasOtherRound') > 0)
    assert('守卫注释标注了事故来源', CLOUD_SRC.indexOf('v103 爆炸半径守卫') > 0)
  }

  console.log(testFailed ? '\n❌ v103 存在失败断言' : '\n✅ v103 全部通过')
  process.exit(testFailed ? 1 : 0)
})()
