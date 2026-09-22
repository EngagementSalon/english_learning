// ====== 测试 v105：管理员手动补录挑战考试成绩 ======
// 线上事故（2026-09-22，见 v104）：营次在学员页面打开之后才创建 → 内存缓存不刷新 →
// chOpenLocked() 恒 true → 开始考试被总闸拦下 → 云端零 chy 上报。
// 但学员界面上进度与历史成绩照常渲染（本机存储），学员以为自己考完了、管理员查不到。
// 让学员重考是首选；学员已离场/不便重考时，需要管理员补录通道 —— 本测试锁死它。
//
// 要点：
// ① setChallengeManualScore 按**学员自己拥有的营次**逐条落刀（v103 口径，绝不读全局指针）
// ② 写入的事件形状与真实上报（Store.reportChallengeStage → ty:'chy'）完全一致
// ③ 全新学员（无任何记录）回落当前指针营次
// ④ 答对数越界被夹紧、usedSec 非负
// ⑤ chyfix 覆写最近一条 test，不碰 practice，找不到目标不凭空造记录
// ⑥ manual 标记贯通：事件 → _apply → 看板读取
// ⑦ 看板接线：按钮真的在模板里被调用（v100 教训：函数存在 ≠ 功能存在）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

const CLOUD_SRC = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const I18N_SRC = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

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
  // `const CloudSync` 是模块级绑定，不会自动挂到沙箱全局 → 显式挂一份供测试调用
  vm.runInContext(CLOUD_SRC + '\n;CloudSync;window.__CS = CloudSync', sb)
  sb.CloudSync = sb.__CS
  sb.__docRef = docRef
  return sb
}

// 线上形状：两个营次（r1 标帜 / r2 艳中），指针 r1
function realDoc() {
  return {
    v: 1,
    chOpen: true,
    chRoundCur: 'r1',
    chRounds: [
      { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, examOpen: true, startAt: 0, endAt: 0, at: 1790058244386 },
      { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: true, examOpen: true, startAt: 0, endAt: 0, at: 1790057352042 },
    ],
    base: {
      // 标帜学员：D1-D7 练习全做完，但**零 D7 考试成绩**（正是事故形态）
      李梦园: {
        username: '李梦园', name: '李梦园', dept: 'dining/sig',
        chy: [
          { day: 1, si: 0, kind: 'test', correct: 18, total: 20, usedSec: 200, at: 1790000000000, rd: 'r1' },
          { day: 6, si: 0, kind: 'practice', correct: 30, total: 30, usedSec: 300, at: 1790010000000, rd: 'r1' },
          { day: 7, si: 0, kind: 'practice', correct: 10, total: 10, usedSec: 90, at: 1790020000000, rd: 'r1' },
        ],
      },
      // 艳中学员：成绩在 r2，用于验证「不读全局指针、按各自营次落刀」
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

// 从云端文档重放（base + events）得到某学员的 chy —— 与看板读取口径一致。
// ⚠️ 必须用**同一个**沙箱实例依次 _apply：每条事件都新建沙箱会把前一条的效果丢掉。
function replayChy(doc, u) {
  const map = JSON.parse(JSON.stringify(doc.base || {}))
  const sb = makeCloudSandbox({ v: 1, base: map, events: [] })
  ;(doc.events || []).forEach(ev => sb.CloudSync._apply(map, ev))
  return (map[u] && map[u].chy) || []
}

// 测试主体必须 async（setChallengeManualScore 是 async，且要从沙箱外读结果）
;(async () => {

console.log('=== 组 1：setChallengeManualScore 与真实上报同形状 ===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  const res = await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 18, total: 20, usedSec: 0 })
  assert('返回 ok', res && res.ok === true, JSON.stringify(res))
  // ⚠️ _roundSlugKey('r1') === ''（第一期归一，v102 设计）→ 期望 '' 不是 'r1'
  assert('回显目标营次为学员自己的营次（r1 归一为 \'\'）', res.rounds && res.rounds.length === 1 && res.rounds[0] === '', JSON.stringify(res.rounds))
  const evs = doc.events.filter(e => e.ty === 'chy')
  assert('推送了 1 条 chy 事件', evs.length === 1, '实际 ' + evs.length)
  const d = evs[0] && evs[0].d
  assert('事件字段与 reportChallengeStage 一致（day/si/kind/correct/total/usedSec/rd）',
    d && d.day === 7 && d.si === 1 && d.kind === 'test' && d.correct === 18 && d.total === 20 && d.usedSec === 0 && d.rd === '',
    JSON.stringify(d))
  assert('事件带 manual 标记', d && d.manual === true)
  assert('事件带上传人姓名 n', evs[0].n === '李梦园', evs[0].n)
}

console.log('\n=== 组 2：按学员自己拥有的营次落刀（v103 口径，绝不读全局指针）===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  // 指针是 r1，但任璐瑶的记录都在 r2 → 必须写 r2，不能写 r1
  const res = await sb.CloudSync.setChallengeManualScore(['任璐瑶'], { day: 7, si: 1, correct: 20, total: 20 })
  assert('目标营次 = r2（不是全局指针 r1）', res.rounds.length === 1 && res.rounds[0] === 'r2', JSON.stringify(res.rounds))
  const ev = doc.events.find(e => e.ty === 'chy')
  assert('事件 rd = r2', ev && ev.d.rd === 'r2', JSON.stringify(ev && ev.d))
  assert('没有往 r1 写任何记录', !doc.events.some(e => e.ty === 'chy' && e.d.rd === 'r1'))
}

console.log('\n=== 组 3：批量 + 多营次学员各写各的 ===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  const res = await sb.CloudSync.setChallengeManualScore(['李梦园', '任璐瑶'], { day: 7, si: 1, correct: 20, total: 20 })
  assert('两名学员都覆盖到', res.count === 2, JSON.stringify(res))
  assert('产出两个营次（r1 归一为 \'\' 与 r2）', res.rounds.slice().sort().join(',') === ',r2', JSON.stringify(res.rounds))
  const evs = doc.events.filter(e => e.ty === 'chy')
  assert('共 2 条事件', evs.length === 2, '实际 ' + evs.length)
  assert('李梦园 → r1（归一为 \'\'）', evs.some(e => e.u === '李梦园' && e.d.rd === ''))
  assert('任璐瑶 → r2', evs.some(e => e.u === '任璐瑶' && e.d.rd === 'r2'))
}

console.log('\n=== 组 4：全新学员回落当前指针营次 ===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  const res = await sb.CloudSync.setChallengeManualScore(['查无此人'], { day: 7, si: 1, correct: 15, total: 20 })
  assert('回落到指针营次 r1（归一为 \'\'）', res.rounds.length === 1 && res.rounds[0] === '', JSON.stringify(res.rounds))
}

console.log('\n=== 组 5：入参校验（越界夹紧 / 非负 / 空用户）===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  const over = await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 99, total: 20 })
  assert('答对数超上限被夹紧到 total', over.correct === 20, '实际 ' + over.correct)
  const neg = await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: -5, total: 20 })
  assert('答对数负值被夹紧到 0', neg.correct === 0, '实际 ' + neg.correct)
  const negT = await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 10, total: 20, usedSec: -30 })
  assert('usedSec 负值被夹紧到 0', negT.usedSec === 0, '实际 ' + negT.usedSec)
  const none = await sb.CloudSync.setChallengeManualScore([], { day: 7, si: 1 })
  assert('空用户名列表 → ok:false / nouser', none.ok === false && none.reason === 'nouser', JSON.stringify(none))
  const missing = await sb.CloudSync.setChallengeManualScore(['李梦园'], {})
  assert('day/si 缺省为 Day7 期末考试（7 / 1）', missing.day === 7 && missing.si === 1, JSON.stringify(missing))
}

console.log('\n=== 组 6：manual 标记贯通到聚合表（_apply）===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 18, total: 20, usedSec: 0 })
  const chy = replayChy(doc, '李梦园')
  const t7 = chy.filter(x => x.kind === 'test' && x.day === 7)
  assert('聚合表里出现了 Day7 成绩', t7.length === 1, '实际 ' + t7.length)
  assert('分数正确（18/20）', t7[0] && t7[0].correct === 18 && t7[0].total === 20, JSON.stringify(t7[0]))
  assert('带 manual 标记（看板可打「手动」徽章）', t7[0] && t7[0].manual === true)
  assert('rd 为第一期归一值 \'\'', t7[0] && t7[0].rd === '', JSON.stringify(t7[0] && t7[0].rd))
  assert('练习记录未被影响', chy.filter(x => x.kind === 'practice').length === 2)
  // 看板同口径算分
  const score = Math.round(t7[0].correct / t7[0].total * 100)
  assert('看板口径算出 90 分', score === 90, String(score))
}

console.log('\n=== 组 7：chyfix 覆写（录错了再改）===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 9, total: 20, usedSec: 0 })
  let chy = replayChy(doc, '李梦园')
  assert('先有一条 9/20', chy.filter(x => x.day === 7 && x.kind === 'test' && x.correct === 9).length === 1)
  // 改成 20/20
  const fix = await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 20, total: 20, usedSec: 0, overwrite: true })
  assert('overwrite 返回 ok', fix && fix.ok === true, JSON.stringify(fix))
  assert('推的是 chyfix 而非 chy', doc.events.some(e => e.ty === 'chyfix') && doc.events.filter(e => e.ty === 'chy').length === 1)
  chy = replayChy(doc, '李梦园')
  const t7 = chy.filter(x => x.day === 7 && x.kind === 'test')
  assert('仍只有一条 Day7 成绩（覆写不是新增）', t7.length === 1, '实际 ' + t7.length)
  assert('分数被改写为 20/20', t7[0].correct === 20 && t7[0].total === 20, JSON.stringify(t7[0]))
  assert('覆写后仍带 manual 标记', t7[0].manual === true)
  assert('练习记录依然完好', chy.filter(x => x.kind === 'practice').length === 2)
}

console.log('\n=== 组 8：chyfix 的边界（不碰 practice / 无目标不造记录 / 幂等）===')
{
  // 练习阶段的 chyfix 不得误伤同 day 的 test
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 18, total: 20 })
  await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 0, correct: 5, total: 10, kind: 'practice', overwrite: true })
  const chy = replayChy(doc, '李梦园')
  const t7 = chy.filter(x => x.kind === 'test' && x.day === 7)
  assert('work: 对 practice 阶段的 chyfix 未影响 test 成绩', t7.length === 1 && t7[0].correct === 18, JSON.stringify(t7))
  const p70 = chy.filter(x => x.kind === 'practice' && x.day === 7 && x.si === 0)
  assert('practice 记录原样保留（未生成 test 覆盖它）', p70.length === 1 && p70[0].correct === 10, JSON.stringify(p70))

  // 无目标记录时不凭空造
  const doc2 = realDoc()
  const sb2 = makeCloudSandbox(doc2)
  await sb2.CloudSync.setChallengeManualScore(['任璐瑶'], { day: 7, si: 1, correct: 20, total: 20, overwrite: true })
  const chy2 = replayChy(doc2, '任璐瑶')
  assert('无 test 记录时 chyfix 不凭空造成绩', chy2.filter(x => x.kind === 'test').length === 0, JSON.stringify(chy2))

  // 幂等：同一条 chyfix 重放两次结果相同
  const doc3 = realDoc()
  const sb3 = makeCloudSandbox(doc3)
  await sb3.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 18, total: 20 })
  const fixEv = { u: '李梦园', n: '李梦园', ty: 'chyfix', ts: 1790099999999, d: { day: 7, si: 1, rd: 'r1', correct: 20, total: 20, usedSec: 0, manual: true } }
  const map1 = JSON.parse(JSON.stringify(doc3.base))
  sb3.CloudSync._apply(map1, fixEv)
  const once = JSON.stringify(map1['李梦园'].chy)
  sb3.CloudSync._apply(map1, fixEv)
  assert('同一条 chyfix 重放两次结果相同（幂等）', JSON.stringify(map1['李梦园'].chy) === once)
}

console.log('\n=== 组 9：chyfix 覆盖补录可恢复被重置（cleared）的成绩（v108 语义）===')
{
  const doc = realDoc()
  const sb = makeCloudSandbox(doc)
  await sb.CloudSync.setChallengeManualScore(['李梦园'], { day: 7, si: 1, correct: 18, total: 20 })
  // ⚠️ 真实管线：补录只进 events 队列，要等折叠/重放才落到 base。这里按「base + events 重放」
  //    （看板读取口径）先把它落进 base，再执行重置，顺序不能反——否则重置会作用在空数组上。
  const map = JSON.parse(JSON.stringify(doc.base))
  doc.events.forEach(ev => sb.CloudSync._apply(map, ev))
  assert('重放后 base 里已有补录的 18/20', map['李梦园'].chy.some(x => x.kind === 'test' && x.correct === 18))
  // 管理员重置该营次考试成绩 → 成绩变 cleared 存根
  sb.CloudSync._apply(map, { u: '李梦园', n: '李梦园', ty: 'chreset', ts: 1790100000000, d: { mode: 'exam', round: 'r1' } })
  const before = map['李梦园'].chy.filter(x => x.day === 7 && x.kind === 'test')[0]
  assert('重置后成绩已清零并标记 cleared', before && before.cleared === true && before.correct === 0, JSON.stringify(before))
  // v108：再对已 cleared 的记录做 chyfix → 覆盖补录 = 以管理员录入为准 → 恢复成绩（清 cleared）
  sb.CloudSync._apply(map, { u: '李梦园', n: '李梦园', ty: 'chyfix', ts: 1790110000000, d: { day: 7, si: 1, rd: 'r1', correct: 20, total: 20, usedSec: 0, manual: true } })
  const after = map['李梦园'].chy.filter(x => x.day === 7 && x.kind === 'test')[0]
  assert('覆盖补录恢复成绩（cleared 已清、分数生效）',
    after && after.correct === 20 && after.total === 20 && !after.cleared && after.manual === true, JSON.stringify(after))
}

console.log('\n=== 组 10：源码级护栏与看板接线（v100 教训：函数存在 ≠ 功能存在）===')
{
  assert('cloud-store.js 定义了 setChallengeManualScore',
    /async setChallengeManualScore\s*\(/.test(CLOUD_SRC))
  assert('cloud-store.js 有 chyfix 分支', /case 'chyfix':/.test(CLOUD_SRC))
  assert('chy 事件写入保留 manual 标记', /d\.manual \? \{ manual: true \}/.test(CLOUD_SRC))
  assert('setChallengeManualScore 不读全局指针落刀（用 _roundCurrent 仅作全新学员回落）',
    /const cur = _roundCurrent\(doc\)/.test(CLOUD_SRC.slice(CLOUD_SRC.indexOf('async setChallengeManualScore'))))
  assert('写入走 enqueue（不直接写 base，避免被旧快照覆盖）',
    /this\.enqueue\(\{ u, n: names\[u\], ty: 'chy'/m.test(CLOUD_SRC)
    && /this\.enqueue\(\{ u, n: names\[u\], ty: 'chyfix'/m.test(CLOUD_SRC))
  assert('补录不直接改 base（全程只 enqueue + pushPending）', (() => {
    const body = CLOUD_SRC.slice(CLOUD_SRC.indexOf('async setChallengeManualScore'))
      .slice(0, CLOUD_SRC.slice(CLOUD_SRC.indexOf('async setChallengeManualScore')).indexOf('\n  // 从最近一次') > 0
        ? CLOUD_SRC.slice(CLOUD_SRC.indexOf('async setChallengeManualScore')).indexOf('\n  // 从最近一次')
        : 4000)
    return !/doc\.base\[[^\]]*\]\s*=/.test(body)
  })())

  // 看板接线：按钮必须真的在模板里被调用
  assert('app.js 定义了 dashManualScoreOpen',
    /function dashManualScoreOpen\s*\(/.test(APP_SRC))
  assert('看板模板里真的渲染了补录按钮（接线断言）',
    /id="dashChManualBtn_\$\{pi\}"/.test(APP_SRC))
  assert('看板模板里按钮调用了 dashManualScoreFromBtn',
    /onclick="dashManualScoreFromBtn\(this\)"/.test(APP_SRC))
  assert('批量补录按钮真的在模板里被调用',
    /\$\{lack7 > 0 \?/.test(APP_SRC) && /onclick="dashManualScoreBatch\(\)"/.test(APP_SRC))
  assert('成绩格带 manual 徽章逻辑', /function|const/.test(APP_SRC) && /dashChManualBadge/.test(APP_SRC))
  assert('按钮参数走 data-* 而非内联引号拼接（v85 教训）',
    /data-u="\$\{escAttr\(p\.username\)\}"/.test(APP_SRC)
    && !/onclick="dashManualScoreOpen\('/.test(APP_SRC))
  assert('_chDashRows 已声明并赋值', /let _chDashRows = \[\]/.test(APP_SRC) && /_chDashRows = list/.test(APP_SRC))
}

console.log('\n=== 组 11：i18n 键成对 ===')
{
  const keys = ['dashChManualBtn', 'dashChManualTitle', 'dashChManualDay', 'dashChManualDay7', 'dashChManualDay1',
    'dashChManualCorrect', 'dashChManualSec', 'dashChManualOverwrite', 'dashChManualOverwriteConfirm',
    'dashChManualSubmit', 'dashChManualCancel', 'dashChManualWorking', 'dashChManualOk', 'dashChManualFail',
    'dashChManualWarn', 'dashChManualBadge', 'dashChManualBadgeHint', 'dashChManualMultiLabel',
    'dashChManualLack', 'dashChManualBatchBtn', 'dashChManualBatchEmpty', 'dashChManualBatchConfirm']
  let bad = []
  keys.forEach(k => {
    const n = (I18N_SRC.match(new RegExp('\\b' + k + ':', 'g')) || []).length
    if (n !== 2) bad.push(k + '(' + n + ')')
  })
  assert('全部 ' + keys.length + ' 个键 zh/en 成对', bad.length === 0, bad.join(', '))
}

console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
process.exit(testFailed ? 1 : 0)

})().catch(e => { console.error('ERR', e && e.message); process.exit(1) })
