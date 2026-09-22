// v107：考试/挑战开关按期独立（bug4）
// 线上反馈：「确保考试开关出现在每个不同的营期下面，而不是一开都开」。
// 根因：数据层早已按期隔离（开关存营次的 open / examOpen 字段），但界面只有一张卡，
//       只读写 CloudSync._chExamOpen / _chOpen（= 指针那一期）→ 管理员永远只能操作当前指针期。
// 修法：① cloud-store setChallengeOpen / setChallengeExamOpen 支持 spec.roundId 精确落刀；
//       ② 看板按营次列表逐期渲染一张卡，每期各带「开放挑战」+「开放考试」。
// 覆盖：① setChallengeExamOpen({open, roundId}) 只改目标期；② 同理 setChallengeOpen；
//      ③ 不改指针期时侧信道不被污染（学员端不会读错）；④ 未指定 roundId 保持旧的指针期行为；
//      ⑤ roundId 不存在时返回 noround 且不动数据；⑥ UI 逐期渲染 + 两个按钮 + roundId 传参。
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

// ---------- cloud-store 沙箱（最小依赖：只需 _getDoc/_putDoc + 全局 fetch 无关） ----------
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

// 两期营次：r1 = 标帜餐厅第一期，r2 = 艳中餐厅第一期
function mkDoc() {
  return {
    v: 1, base: {}, events: [],
    chRoundCur: 'r1',
    chRounds: [
      { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: false, examOpen: false, at: 1 },
      { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: true, examOpen: true, at: 2 },
    ],
  }
}
// 注入一个「真·读改写后端」：_getDoc 深拷贝返回，_putDoc 覆盖 —— 语义等价云端 doc
function wireDoc(sb, doc) {
  sb.__doc = JSON.parse(JSON.stringify(doc))
  sb.__puts = 0
  vm.runInContext('CloudSync._getDoc = async function(){ return JSON.parse(JSON.stringify(globalThis.__doc)) }', sb)
  vm.runInContext('CloudSync._putDoc = async function(d){ globalThis.__doc = JSON.parse(JSON.stringify(d)); globalThis.__puts++ ; return true }', sb)
  // 侧信道初值（模拟 _getDoc 拉取后的状态）
  vm.runInContext('CloudSync._chRounds = JSON.parse(JSON.stringify(globalThis.__doc.chRounds))', sb)
  vm.runInContext('CloudSync._chRoundCurId = globalThis.__doc.chRoundCur', sb)
  vm.runInContext('CloudSync._chExamOpen = ' + JSON.stringify(doc.chRounds[0].examOpen), sb)
  vm.runInContext('CloudSync._chOpen = ' + JSON.stringify(doc.chRounds[0].open), sb)
}
const getDoc = sb => sb.__doc
const roundOf = (sb, id) => (getDoc(sb).chRounds || []).find(r => r.id === id)

;(async () => {
  const appSrc = read('app.js')
  const csSrc = read('cloud-store.js')

  console.log('=== 一、cloud-store 支持 spec.roundId（静态接线）===')
  ok(/async setChallengeExamOpen\(open\)[\s\S]{0,900}?const wantRound = String\(spec\.roundId/.test(csSrc),
    'setChallengeExamOpen 读取 spec.roundId')
  ok(/async setChallengeOpen\(open\)[\s\S]{0,900}?const wantRound = String\(spec\.roundId/.test(csSrc),
    'setChallengeOpen 读取 spec.roundId')
  ok(csSrc.includes("return { ok: false, reason: 'noround' }"), 'roundId 不存在时返回 noround')

  console.log('=== 二、setChallengeExamOpen：只改目标期 ===')
  {
    const sb = makeSb()
    wireDoc(sb, mkDoc())
    // 打开第 2 期考试（r2 本来就开着 → 先关掉再打开，验证能精确改动非指针期）
    let res = await vm.runInContext('CloudSync.setChallengeExamOpen({ open: false, roundId: "r2" })', sb)
    ok(res && res.ok === true, '对 r2 关考试 → ok')
    eq(roundOf(sb, 'r2').examOpen, false, 'r2.examOpen 已关闭')
    eq(roundOf(sb, 'r1').examOpen, false, 'r1.examOpen 未被改动（仍 false）')

    // 打开 r2 考试 —— 指针仍是 r1，绝不能动 r1
    res = await vm.runInContext('CloudSync.setChallengeExamOpen({ open: true, roundId: "r2" })', sb)
    ok(res && res.ok === true, '对 r2 开考试 → ok')
    eq(roundOf(sb, 'r2').examOpen, true, 'r2.examOpen = true')
    eq(roundOf(sb, 'r1').examOpen, false, 'r1.examOpen 仍为 false（没被「一开都开」带开）')
    eq(getDoc(sb).chRounds.length, 2, '营次数量不变')

    // 侧信道不得被非指针期的改动污染（学员端读 _chExamOpen = 自己部门那期）
    eq(vm.runInContext('CloudSync._chExamOpen', sb), false,
      '改 r2（非指针期）→ 侧信道 _chExamOpen 不被污染（仍为 r1 的 false）')
    // 但侧信道里 r2 记录本身要更新（用于看板即时重渲染）
    const sideR2 = vm.runInContext('CloudSync._chRounds.find(function(r){return r.id==="r2"})', sb)
    eq(sideR2.examOpen, true, '侧信道 _chRounds 里 r2.examOpen 已更新')

    // 再改指针期 r1 → 侧信道要跟着动
    res = await vm.runInContext('CloudSync.setChallengeExamOpen({ open: true, roundId: "r1" })', sb)
    ok(res && res.ok === true, '对 r1（指针期）开考试 → ok')
    eq(roundOf(sb, 'r1').examOpen, true, 'r1.examOpen = true')
    eq(vm.runInContext('CloudSync._chExamOpen', sb), true, '改指针期 → 侧信道 _chExamOpen 同步为 true')
    eq(roundOf(sb, 'r2').examOpen, true, 'r2 不受影响')
  }

  console.log('=== 三、setChallengeOpen：只改目标期 ===')
  {
    const sb = makeSb()
    wireDoc(sb, mkDoc())
    // r1 挑战关、r2 挑战开。把 r1 打开 —— r2 必须保持开，且 r2 不能被误关
    let res = await vm.runInContext('CloudSync.setChallengeOpen({ open: true, roundId: "r1" })', sb)
    ok(res && res.ok === true, '对 r1 开挑战 → ok')
    eq(roundOf(sb, 'r1').open, true, 'r1.open = true')
    eq(roundOf(sb, 'r2').open, true, 'r2.open 保持 true（不受影响）')
    ok(Number(roundOf(sb, 'r1').at) > 0, 'r1 开放时写入 at 时间戳')

    // 关 r2 —— r1 必须保持开
    res = await vm.runInContext('CloudSync.setChallengeOpen({ open: false, roundId: "r2" })', sb)
    ok(res && res.ok === true, '对 r2 关挑战 → ok')
    eq(roundOf(sb, 'r2').open, false, 'r2.open = false')
    eq(roundOf(sb, 'r1').open, true, 'r1.open 保持 true（没被连带关闭）')

    // 排期字段也能按期写
    res = await vm.runInContext('CloudSync.setChallengeOpen({ open: true, roundId: "r2", startAt: 111, endAt: 222 })', sb)
    ok(res && res.ok === true, '对 r2 带排期开挑战 → ok')
    eq(roundOf(sb, 'r2').startAt, 111, 'r2.startAt 按期写入')
    eq(roundOf(sb, 'r2').endAt, 222, 'r2.endAt 按期写入')
    eq(roundOf(sb, 'r1').startAt, 0, 'r1 排期未被污染')
  }

  console.log('=== 四、不传 roundId → 保持旧的「指针期」行为（向后兼容）===')
  {
    const sb = makeSb()
    wireDoc(sb, mkDoc())   // 指针 = r1
    let res = await vm.runInContext('CloudSync.setChallengeExamOpen(true)', sb)
    ok(res && res.ok === true, '不传 roundId 开考试 → ok')
    eq(roundOf(sb, 'r1').examOpen, true, '改的是指针期 r1')
    eq(roundOf(sb, 'r2').examOpen, true, 'r2 未被动（原值 true）')
    eq(vm.runInContext('CloudSync._chExamOpen', sb), true, '侧信道同步')

    res = await vm.runInContext('CloudSync.setChallengeOpen(true)', sb)
    ok(res && res.ok === true, '不传 roundId 开挑战 → ok')
    eq(roundOf(sb, 'r1').open, true, '改的是指针期 r1')
    eq(roundOf(sb, 'r2').open, true, 'r2 未被动')

    // 布尔直传（最老调用形态）也要照旧работать
    const sb2 = makeSb(); wireDoc(sb2, mkDoc())
    const r2 = await vm.runInContext('CloudSync.setChallengeExamOpen(false)', sb2)
    ok(r2 && r2.ok === true, '布尔直传形态 setChallengeExamOpen(false) → ok')
    eq(roundOf(sb2, 'r1').examOpen, false, '布尔直传改指针期')
  }

  console.log('=== 五、roundId 不存在 → 明确失败且不动数据 ===')
  {
    const sb = makeSb()
    wireDoc(sb, mkDoc())
    const before = JSON.stringify(getDoc(sb).chRounds)
    const res = await vm.runInContext('CloudSync.setChallengeExamOpen({ open: true, roundId: "r99" })', sb)
    ok(res && res.ok === false && res.reason === 'noround', '不存在的 roundId → { ok:false, reason:"noround" }')
    eq(JSON.stringify(getDoc(sb).chRounds), before, '数据完全未改动')
    const res2 = await vm.runInContext('CloudSync.setChallengeOpen({ open: true, roundId: "r99" })', sb)
    ok(res2 && res2.ok === false && res2.reason === 'noround', 'setChallengeOpen 同样返回 noround')
    eq(JSON.stringify(getDoc(sb).chRounds), before, '数据仍未改动')
  }

  console.log('=== 六、看板 UI：按期逐卡 + roundId 传参 ===')
  ok(appSrc.includes('function dashChGatePanelHtml'), 'dashChGatePanelHtml 定义')
  ok(appSrc.includes('function dashChRoundGateCardHtml'), 'dashChRoundGateCardHtml 定义（单期卡）')
  ok(appSrc.includes('function dashRoundsForGate'), 'dashRoundsForGate 定义（按期读取）')
  // 逐期渲染：面板对 list 做 map
  ok(/dashChGatePanelHtml\(\)[\s\S]{0,900}?ordered\.map\(r => dashChRoundGateCardHtml/.test(appSrc),
    '面板按营次列表逐期出卡（ordered.map → dashChRoundGateCardHtml）')
  // 每期卡带两个按钮 + roundId
  const card = (appSrc.match(/function dashChRoundGateCardHtml\(r, isCur\)[\s\S]*?\n\}/) || [''])[0]
  ok(card.length > 0, '能取到单期卡函数体')
  ok(card.includes('dashToggleChOpen(this)'), '单期卡含「开放挑战」按钮')
  ok(card.includes('dashToggleChExam(this)'), '单期卡含「开放考试」按钮')
  ok(card.includes('data-rid="${rid}"'), '两个按钮都带 data-rid（目标营次）')
  // 徽章文案经 badge(on, onKey, offKey) 间接取键 → 断言键名做参数传入
  ok(card.includes("badge(open, 'dashChOpenOn', 'dashChOpenOff')"), '挑战开关徽章文案齐备（开/关两态）')
  ok(card.includes("badge(examOpen, 'dashChExamOn', 'dashChExamOff')"), '考试开关徽章文案齐备（开/关两态）')
  ok(card.includes('dashRoundDeptText(r)'), '单期卡显示适用部门')
  ok(card.includes('dashRoundWindowText(r)'), '单期卡显示起止时间')
  // 处理函数传 roundId
  const tOpen = (appSrc.match(/async function dashToggleChOpen\(btn\)[\s\S]*?\n\}/) || [''])[0]
  const tExam = (appSrc.match(/async function dashToggleChExam\(btn\)[\s\S]*?\n\}/) || [''])[0]
  ok(tOpen.includes('btn.dataset.rid'), 'dashToggleChOpen 从 data-rid 取营次')
  ok(tOpen.includes('setChallengeOpen({ open: next, roundId: rid })'), 'dashToggleChOpen 传 roundId')
  ok(tExam.includes('btn.dataset.rid'), 'dashToggleChExam 从 data-rid 取营次')
  ok(tExam.includes('setChallengeExamOpen({ open: next, roundId: rid })'), 'dashToggleChExam 传 roundId')
  ok(tOpen.includes('dashRefreshChGate()'), '挑战开关成功后就地刷新面板')
  ok(tExam.includes('dashRefreshChGate()'), '考试开关成功后就地刷新面板')
  // 只在改指针期时动侧信道
  ok(/if \(rid === dashRoundCurId\(\)\) CloudSync\._chExamOpen = next/.test(tExam),
    '仅当改的是当前指针期时才同步 _chExamOpen（避免学员端读错期）')
  // 视图插入
  ok(/<div id="dashChGate">\$\{dashChGatePanelHtml\(\)\}<\/div>/.test(appSrc), '看板插入 dashChGate 面板')
  ok(appSrc.indexOf('${dashChGatePanelHtml()}') > appSrc.indexOf('${dashRoundsPanelHtml()}'), '面板在营次管理之后')
  ok(appSrc.indexOf('${dashChGatePanelHtml()}') < appSrc.indexOf('<div id="dashChallengeBlock"></div>'), '面板在挑战统计之前')
  // 旧单卡已彻底移除
  ok(!appSrc.includes('function dashChExamGateHtml'), '旧单卡 dashChExamGateHtml 已移除')
  ok(!appSrc.includes('function dashChOpenGateHtml'), '旧单卡 dashChOpenGateHtml 已移除')
  ok(!appSrc.includes('id="dashChExamGate"'), '旧容器 id dashChExamGate 已移除')
  ok(appSrc.includes('function dashRefreshExamGate() { dashRefreshChGate() }'), '保留兼容入口 dashRefreshExamGate → dashRefreshChGate')

  console.log('=== 七、i18n 键成对 ===')
  const i18nSrc = read('i18n.js')
  ;['dashChGatePanelTitle', 'dashChGatePanelHint', 'dashChGateCurTag', 'dashChGateNoRound',
    'dashChOpenTitle', 'dashChExamTitle', 'dashChOpenOn', 'dashChOpenOff', 'dashChExamOn', 'dashChExamOff'].forEach(k => {
    eq((i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 2, `i18n ${k} 中英成对`)
  })

  console.log('')
  console.log(`PASS ${PASS} / FAIL ${FAIL}`)
  if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
  process.exit(FAIL ? 1 : 0)
})()
