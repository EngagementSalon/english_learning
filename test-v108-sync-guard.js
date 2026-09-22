// v108：成绩同步三保险（bug5「确保以后不会再有成绩进不来或者做完题我这里不同步」）
// 用户三项全选：① 上报失败自动重试到成功；② 成绩本地留底 + 管理员核对；③ 交卷后界面明确显示「已同步」。
// 覆盖：
//   一、退避阶梯：CLOUD_RETRY_LADDER 存在且 pushPending 失败后排下一轮（成功后归零）
//   二、同步状态：syncState 三态（synced / pending / error）口径 + 变化时通知监听者
//   三、成绩底账：chy 事件入队即登记（不删）、成功回填 sent、上限裁剪、幂等
//   四、核对：reconcileScores 找出云端缺失（base / events / 本机队列三处都算「已知」）
//   五、补录：reconcilePushScores 用幂等 id 推 chy，重复调用不产生重复成绩
//   六、UI 接线：学员结果页徽章（考试 + 挑战）、状态变化就刷、管理员核对入口与弹窗
//   七、i18n 键成对
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let PASS = 0, FAIL = 0
const fails = []
function ok(cond, name, extra) {
  if (cond) { PASS++; return true }
  FAIL++; fails.push(name + (extra ? ' | ' + extra : ''))
  return false
}
function eq(a, b, name) { return ok(JSON.stringify(a) === JSON.stringify(b), name, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`) }

const DIR = __dirname
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8')

function makeSb(doc) {
  const sb = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
    document: { getElementById: () => null, addEventListener() {}, visibilityState: 'visible' },
    window: { addEventListener() {} },
    localStorage: { store: {}, getItem(k) { return this.store[k] || null }, setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(read('cloud-store.js'), sb)
  return sb
}
function mkDoc() {
  return {
    v: 1, base: {}, events: [],
    chRoundCur: 'r1',
    chRounds: [{ id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, examOpen: true, at: 1 }],
  }
}
// 注入「真·读改写后端」；okPut=false → 模拟云端写入失败（网络异常）
function wireDoc(sb, doc, opts) {
  const o = opts || {}
  sb.__doc = JSON.parse(JSON.stringify(doc))
  sb.__puts = 0
  sb.__failPut = !!o.failPut
  vm.runInContext('CloudSync._getDoc = async function(){ return JSON.parse(JSON.stringify(globalThis.__doc)) }', sb)
  vm.runInContext('CloudSync._putDoc = async function(d){ if (globalThis.__failPut) throw new Error("cloud PUT 502"); globalThis.__doc = JSON.parse(JSON.stringify(d)); globalThis.__puts++ ; return true }', sb)
  vm.runInContext('CloudSync._chRounds = JSON.parse(JSON.stringify(globalThis.__doc.chRounds))', sb)
  vm.runInContext('CloudSync._chRoundCurId = globalThis.__doc.chRoundCur', sb)
  vm.runInContext('CloudSync._chExamOpen = true', sb)
  vm.runInContext('CloudSync._chOpen = true', sb)
}
const q = sb => vm.runInContext('CloudSync._queue()', sb)
const ledger = sb => vm.runInContext('CloudSync.getScoreLedger()', sb)
const docEvents = sb => (sb.__doc.events || [])

;(async () => {
  const csSrc = read('cloud-store.js')
  const appSrc = read('app.js')
  const chSrc = read('challenge.js')
  const i18nSrc = read('i18n.js')

  console.log('=== 一、退避重试阶梯 ===')
  ok(/const CLOUD_RETRY_LADDER = \[5000, 15000, 60000, 300000\]/.test(csSrc), '退避阶梯常量 5s/15s/60s/5min')
  ok(csSrc.includes('_scheduleRetry()'), '_scheduleRetry 定义并被调用')
  ok(/if \(allDone\) \{\s*this\._clearRetry\(\)/.test(csSrc), '队列清空 → 归零阶梯')
  ok(/else if \(!silent\) \{\s*this\._scheduleRetry\(\)/.test(csSrc), '仍有残留 → 排下一轮重试')
  ok(csSrc.includes('const step = Math.min(this._retryStep, CLOUD_RETRY_LADDER.length - 1)'),
    '阶梯到底后固定用最后一级（不无限退避）')
  ok(csSrc.includes("window.addEventListener('online'"), '网络恢复事件 → 立刻重推')
  ok(csSrc.includes('this._reschedulePush(300)'), '切回前台/网络恢复 → 清阶梯立刻重试')
  {
    // 实跑：云端写失败 → pushPending 后队列仍在，且已排下一轮（_retryStep 前进）
    const sb = makeSb(mkDoc())
    wireDoc(sb, mkDoc(), { failPut: true })
    vm.runInContext('CloudSync.setUser("u1", "学员一")', sb)
    vm.runInContext('CloudSync.enqueue({ u: "u1", n: "学员一", ty: "chy", d: { day: 7, si: 1, kind: "test", correct: 18, total: 20, usedSec: 120, rd: "r1" } })', sb)
    eq(q(sb).length, 1, '事件已入队')
    await vm.runInContext('CloudSync.pushPending()', sb)
    eq(q(sb).length, 1, '云端写失败 → 事件仍留在队列（不丢）')
    ok(vm.runInContext('CloudSync._retryStep', sb) >= 1, '失败后阶梯前进（已排下一轮重试）')
    ok(vm.runInContext('CloudSync.syncState()', sb) === 'error', '队列非空 + 离线 → syncState = error')
    // 网络恢复 → 重推成功 → 队列清空、阶梯归零
    vm.runInContext('globalThis.__failPut = false', sb)
    await vm.runInContext('CloudSync.pushPending()', sb)
    eq(q(sb).length, 0, '网络恢复后重推 → 队列清空')
    eq(vm.runInContext('CloudSync._retryStep', sb), 0, '成功 → 阶梯归零')
    ok(vm.runInContext('CloudSync.syncState()', sb) === 'synced', '队列空 + 在线 → syncState = synced')
    ok(docEvents(sb).some(e => e.ty === 'chy' && e.d && e.d.correct === 18), '成绩已写入云端')
    vm.runInContext('CloudSync._clearRetry()', sb)   // 清理定时器
  }

  console.log('=== 二、同步状态三态 + 监听通知 ===')
  ok(appSrc.includes('function syncBadgeHtml'), 'syncBadgeHtml 定义')
  ok(/syncState\(\) \{[\s\S]{0,600}?return this\.status === 'offline' \? 'error' : 'synced'/.test(csSrc),
    'syncState：队列空 + 在线 → synced')
  ok(csSrc.includes("if (n > 0) return this.status === 'offline' ? 'error' : 'pending'"),
    'syncState：队列非空 → pending / error')
  ok(csSrc.includes('_notifySyncState()') && csSrc.includes('onSyncState(cb)'), '状态变化通知：onSyncState + _notifySyncState')
  {
    const sb = makeSb(mkDoc())
    wireDoc(sb, mkDoc())
    // 新沙箱 status 初始为 'offline'（未探测过云端）→ 队列有数据时如实报 error。
    // 先成功推送一次让 status 变 'online'，再看「队列有数据但连接正常」= pending。
    vm.runInContext('CloudSync.enqueue({ u: "u0", n: "B", ty: "duration", d: { sec: 10 } })', sb)
    await vm.runInContext('CloudSync.pushPending()', sb)
    eq(vm.runInContext('CloudSync.syncState()', sb), 'synced', '连接正常 + 队列空 → synced')
    vm.runInContext('CloudSync.enqueue({ u: "u1", n: "A", ty: "chy", d: { day: 1, si: 0, kind: "test", correct: 3, total: 10, rd: "r1" } })', sb)
    eq(vm.runInContext('CloudSync.syncState()', sb), 'pending', '连接正常 + 队列有数据 → pending')
    await vm.runInContext('CloudSync.pushPending()', sb)
    eq(vm.runInContext('CloudSync.syncState()', sb), 'synced', '推送成功 → synced')
    vm.runInContext('CloudSync._clearRetry()', sb)
  }

  console.log('=== 三、成绩底账 ===')
  ok(csSrc.includes('this._ledgerMarkPending([ev])'), 'enqueue 时（不等推送）即登记底账')
  ok(csSrc.includes('_ledgerMarkPending(q0)'), 'pushPending 前兜底再登记一次（覆盖迁移/历史队列）')
  ok(csSrc.includes('_ledgerMarkSynced(this._queue())'), '推送成功后回填 sent')
  ok(/_ledgerWorthy\(ev\) \{ return !!\(ev && \(ev\.ty === 'chy' \|\| ev\.ty === 'exam' \|\| ev\.ty === 'placement'\)\) \}/.test(csSrc),
    '底账只收成绩类事件（chy / exam / placement）')
  {
    const sb = makeSb(mkDoc())
    wireDoc(sb, mkDoc())
    vm.runInContext('CloudSync.enqueue({ u: "u1", n: "甲", ty: "duration", d: { sec: 300 } })', sb)
    eq(ledger(sb).length, 0, '时长事件不进底账')
    vm.runInContext('CloudSync.enqueue({ id: "chy_a", u: "u1", n: "甲", ty: "chy", d: { day: 7, si: 1, kind: "test", correct: 20, total: 20, usedSec: 60, rd: "r1" } })', sb)
    eq(ledger(sb).length, 1, 'chy 事件进底账')
    eq(ledger(sb)[0].sent, false, '尚未上报 → sent = false')
    eq(ledger(sb)[0].id, 'chy_a', '底账 id 与云端事件 id 一致（幂等锚点）')
    eq(ledger(sb)[0].d.correct, 20, '底账保留作答数据（补录用）')
    // 重复入队同一 id 不产生第二条底账
    vm.runInContext('CloudSync._ledgerMarkPending([{ id: "chy_a", u: "u1", ty: "chy", d: { day: 7 } }])', sb)
    eq(ledger(sb).length, 1, '同一 id 重复登记 → 底账不重复')
    // 推送成功 → sent 回填，条目仍在（底账不可删）
    await vm.runInContext('CloudSync.pushPending()', sb)
    eq(ledger(sb).length, 1, '推送成功后底账条目仍保留（本地留底）')
    eq(ledger(sb)[0].sent, true, '推送成功 → sent = true')
    vm.runInContext('CloudSync._clearRetry()', sb)
  }
  {
    // 上限裁剪：未上报的永不丢
    const sb = makeSb(mkDoc())
    wireDoc(sb, mkDoc())
    const many = []
    for (let i = 0; i < 700; i++) many.push({ id: 'x' + i, u: 'u1', ty: 'chy', ts: i, d: { day: 1, si: 0, kind: 'practice', correct: 1, total: 2, rd: 'r1' }, sent: true })
    many.push({ id: 'keepme', u: 'u1', ty: 'chy', ts: 999, d: { day: 7, si: 1, kind: 'test', correct: 5, total: 20, rd: 'r1' }, sent: false })
    vm.runInContext('CloudSync._saveLedger(' + JSON.stringify(many) + ')', sb)
    vm.runInContext('CloudSync._saveLedger(CloudSync._trimLedger(CloudSync._ledger()))', sb)
    const out = ledger(sb)
    ok(out.length <= 600, '底账裁剪到上限内', 'len=' + out.length)
    ok(out.some(x => x.id === 'keepme'), '未上报条目在裁剪中被保留')
  }

  console.log('=== 四、核对成绩：找出云端缺失 ===')
  {
    const sb = makeSb(mkDoc())
    const doc = mkDoc()
    // 云端已有：u1 的 Day1 摸底
    doc.events.push({ id: 'e1', u: 'u1', n: '甲', ty: 'chy', ts: 1, d: { day: 1, si: 0, kind: 'test', correct: 8, total: 10, rd: 'r1' } })
    // 云端 base 已有：u2 的 Day7 期末
    doc.base = { u2: { username: 'u2', name: '乙', role: 'student', chy: [{ day: 7, si: 1, kind: 'test', correct: 15, total: 20, usedSec: 300, at: 9, rd: 'r1' }] } }
    wireDoc(sb, doc)
    // 本机底账：三条 —— u1 Day1（云端有）、u1 Day7（云端无）、u2 Day7（云端 base 有）
    vm.runInContext('CloudSync._saveLedger(' + JSON.stringify([
      { id: 'L1', u: 'u1', n: '甲', ty: 'chy', ts: 2, d: { day: 1, si: 0, kind: 'test', correct: 8, total: 10, usedSec: 60, rd: 'r1' }, sent: true },
      { id: 'L2', u: 'u1', n: '甲', ty: 'chy', ts: 3, d: { day: 7, si: 1, kind: 'test', correct: 18, total: 20, usedSec: 200, rd: 'r1' }, sent: false },
      { id: 'L3', u: 'u2', n: '乙', ty: 'chy', ts: 4, d: { day: 7, si: 1, kind: 'test', correct: 15, total: 20, usedSec: 300, rd: 'r1' }, sent: true },
    ]) + ')', sb)
    const res = await vm.runInContext('CloudSync.reconcileScores()', sb)
    ok(res && res.ok === true, 'reconcileScores 返回 ok')
    eq(res.checked, 3, '核对 3 条底账成绩')
    eq(res.missing.length, 1, '只找出真正缺失的 1 条')
    eq(res.missing[0].u, 'u1', '缺失的是 u1')
    eq(res.missing[0].day, 7, '缺失的是 Day7')
    eq(res.missing[0].correct, 18, '补录数据取自底账原值')
    // 返回结构里的 rd 经 _roundSlugKey 归一（'r1' ≡ '第一期' ≡ 旧数据 ''）；补录事件 id 用底账原值
    eq(res.missing[0].rd, '', 'rd 经 _roundSlugKey 归一（r1 ≡ 第一期 ≡ 旧数据空串）')
    // 补录事件 id 用底账原值 rd 拼幂等键 —— 换一个干净沙箱单独验证（上面已写过一条）
    const sb3 = makeSb(mkDoc())
    wireDoc(sb3, mkDoc())
    const rawMissing = [{ u: 'u1', n: '甲', rd: 'r1', day: 7, si: 1, kind: 'test', correct: 18, total: 20, usedSec: 200, ts: 3 }]
    await vm.runInContext('CloudSync.reconcilePushScores(' + JSON.stringify(rawMissing) + ')', sb3)
    const rawRec = docEvents(sb3).filter(e => e.ty === 'chy')
    eq(rawRec.length, 1, '补录写入 chy 事件')
    ok(/^rec_u1_r1_7_1_test$/.test(rawRec[0].id), '补录事件 id 用底账 rd 原值拼幂等键')
    eq(rawRec[0].d.rd, 'r1', '事件负载保留底账原值 rd（云端 _apply 归一）')
    ok(rawRec[0].d.recovered === true, '补录记录带 recovered 标记（便于事后区分）')
    // 重复补录 → 幂等
    await vm.runInContext('CloudSync.reconcilePushScores(' + JSON.stringify(rawMissing) + ')', sb3)
    eq(docEvents(sb3).filter(e => e.ty === 'chy').length, 1, '重复补录不产生重复成绩（幂等）')
    vm.runInContext('CloudSync._clearRetry()', sb3)
    // 本机队列里的 chy 也算「已知」，不必重复补
    const sb2 = makeSb(mkDoc())
    wireDoc(sb2, mkDoc())
    vm.runInContext('CloudSync._saveLedger(' + JSON.stringify([
      { id: 'L9', u: 'u3', n: '丙', ty: 'chy', ts: 5, d: { day: 2, si: 0, kind: 'practice', correct: 9, total: 10, usedSec: 50, rd: 'r1' }, sent: false },
    ]) + ')', sb2)
    vm.runInContext('CloudSync.enqueue({ id: "L9", u: "u3", n: "丙", ty: "chy", d: { day: 2, si: 0, kind: "practice", correct: 9, total: 10, usedSec: 50, rd: "r1" } })', sb2)
    const res2 = await vm.runInContext('CloudSync.reconcileScores()', sb2)
    eq(res2.missing.length, 0, '本机队列里待上报的成绩不算缺失（避免重复补录）')
  }

  console.log('=== 五、补录：幂等写入 ===')
  {
    const sb = makeSb(mkDoc())
    wireDoc(sb, mkDoc())
    const missing = [{ u: 'u1', n: '甲', rd: 'r1', day: 7, si: 1, kind: 'test', correct: 18, total: 20, usedSec: 200, ts: 3 }]
    let out = await vm.runInContext('CloudSync.reconcilePushScores(' + JSON.stringify(missing) + ')', sb)
    ok(out && out.ok === true && out.pushed === 1, '补录返回 ok / pushed=1')
    const rec = docEvents(sb).filter(e => e.ty === 'chy')
    eq(rec.length, 1, '云端新增 1 条 chy 记录')
    // 幂等 id 直接用底账里的 rd 原值（'r1'）→ 与底账 id 同锚点
    ok(/^rec_u1_r1_7_1_test$/.test(rec[0].id), '补录事件 id 为幂等形式 rec_<学员>_<营次>_<day>_<si>_<kind>')
    eq(rec[0].d.correct, 18, '补录数据正确')
    ok(rec[0].d.recovered === true, '补录记录带 recovered 标记（便于事后区分）')
    // 重复补录同一批 → 幂等，云端不产生重复
    await vm.runInContext('CloudSync.reconcilePushScores(' + JSON.stringify(missing) + ')', sb)
    eq(docEvents(sb).filter(e => e.ty === 'chy').length, 1, '重复补录不产生重复成绩（幂等）')
    vm.runInContext('CloudSync._clearRetry()', sb)
  }

  console.log('=== 六、UI 接线 ===')
  ok(appSrc.includes('function retrySyncNow'), 'retrySyncNow（手动催一次上报）')
  ok(appSrc.includes('function refreshSyncBadges'), 'refreshSyncBadges（就地刷新徽章）')
  ok(appSrc.includes('function bindSyncBadgeListener'), 'bindSyncBadgeListener（状态变化自动刷）')
  ok(appSrc.includes('bindSyncBadgeListener()'), 'init 里注册了徽章监听')
  ok(appSrc.includes("onclick=\"retrySyncNow(this)\""), '徽章带「立即重试」按钮')
  // 考试结果页
  ok(appSrc.includes('data-sync-badge="1"') && appSrc.includes("syncBadgeHtml('syncBadgeExam')"), '在线考试结果页插入同步徽章')
  ok(appSrc.indexOf("syncBadgeHtml('syncBadgeExam')") > appSrc.indexOf('function renderExamResult'),
    '徽章在 renderExamResult 内')
  // 挑战结果页
  ok(chSrc.includes('data-sync-badge="1"') && chSrc.includes("syncBadgeHtml('syncBadgeCh')"), '七天挑战结果页插入同步徽章')
  ok(chSrc.indexOf("syncBadgeHtml('syncBadgeCh')") > chSrc.indexOf('function chRenderResult'),
    '徽章在 chRenderResult 内')
  // 管理员核对入口
  ok(appSrc.includes('function dashReconcileScores'), 'dashReconcileScores 定义')
  ok(appSrc.includes('function dashReconcileResultOpen'), 'dashReconcileResultOpen（缺失清单弹窗）')
  ok(appSrc.includes('function dashReconcilePush'), 'dashReconcilePush（补录）')
  ok(appSrc.includes('CloudSync.reconcileScores()'), '看板调用 CloudSync.reconcileScores')
  ok(appSrc.includes('CloudSync.reconcilePushScores(res.missing)'), '看板调用 CloudSync.reconcilePushScores')
  ok(appSrc.includes('onclick="dashReconcileScores(this)"'), '核对成绩按钮挂进挑战卡')
  ok(appSrc.includes("t('dashChReconcileLocalOnly')"), '看板如实标注「仅本机底账」')
  ok(appSrc.includes('dashReconcileOk'), '弹窗含缺失清单表格与补录按钮')

  console.log('=== 七、i18n 键成对 ===')
  ;['syncDone', 'syncPending', 'syncError', 'syncRetryNow', 'syncing',
    'dashChReconcileTitle', 'dashChReconcileHint', 'dashChReconcileBtn', 'dashChReconcileWorking',
    'dashChReconcileLocalOnly', 'dashChReconcileOk', 'dashChReconcileMissing', 'dashChReconcileFix',
    'dashChReconcileFixing', 'dashChReconcileFixed', 'dashChReconcileNone', 'dashChReconcileFail',
    'dashChReconcileConfirm', 'dashChReconcilePractice', 'dashChReconcileExam'].forEach(k => {
    eq((i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 2, `i18n ${k} 中英成对`)
  })

  console.log('')
  console.log(`PASS ${PASS} / FAIL ${FAIL}`)
  if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
  process.exit(FAIL ? 1 : 0)
})()
