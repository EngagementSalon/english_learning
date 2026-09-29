// v107：考试/挑战开关按期独立（bug4）
// 线上反馈：「确保考试开关出现在每个不同的营期下面，而不是一开都开」。
// 根因：数据层早已按期隔离（开关存营次的 open / examOpen 字段），但界面只有一张卡，
//       只读写 CloudSync._chExamOpen / _chOpen（= 指针那一期）→ 管理员永远只能操作当前指针期。
// 修法：① cloud-store setChallengeOpen / setChallengeExamOpen 支持 spec.roundId 精确落刀；
//       ② 看板按营次列表逐期渲染开关，每期各带「开放挑战」+「开放考试」。
//       【v118 反转】②的呈现形态变了：原为**独立卡片区**（#dashChGate），
//       现改为**营次管理表的两列**（dashChOpenCellHtml / dashChExamCellHtml）——
//       见第六段顶部注释（信息割裂 + 卡片区跟随部门筛选导致「其他餐厅看不到」的错觉）。
//       数据层与传参方式（roundId）未变，断言随呈现形态改写。
// 覆盖：① setChallengeExamOpen({open, roundId}) 只改目标期；② 同理 setChallengeOpen；
//      ③ 不改指针期时侧信道不被污染（学员端不会读错）；④ 未指定 roundId 保持旧的指针期行为；
//      ⑤ roundId 不存在时返回 noround 且不动数据；⑥ UI 按期渲染（v118：并入营次表两列）+ 两个按钮 + roundId 传参。
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

  console.log('=== 六、看板 UI：按期渲染开关（v118 起并入营次表两列）+ roundId 传参 ===')
  // ⚠️ 契约反转（v118 推翻 v107 的形态，改写本段；反转原因见 app.js 顶部 v118 注释）：
  //   v107 把两个开关做成**独立卡片区**（dashChGatePanelHtml 逐期出卡，挂在 #dashChGate）。
  //   实测问题：① 同一营次要跨两个面板看（表里看排期、卡里看开关），信息割裂；
  //             ② 卡片区**跟随看板部门筛选**（dashRoundsForGate 按 dashChDept 过滤），
  //                管理员切到「标帜餐厅」后只看到标帜那一期，误以为「其他餐厅的开关没了」。
  //   v118 把「挑战」「考试」各作一列并进**营次管理表**（全集视图，不随部门筛选），
  //   故断言随之改写为「单元格函数 + 列接线 + 不再存在独立卡片区」。
  ok(appSrc.includes('function dashChOpenCellHtml'), 'dashChOpenCellHtml 定义（挑战列单元格）')
  ok(appSrc.includes('function dashChExamCellHtml'), 'dashChExamCellHtml 定义（考试列单元格）')
  // 单元格函数体：两个按钮 + roundId + 徽章两态
  const cellOpen = (appSrc.match(/function dashChOpenCellHtml\(r\)[\s\S]*?\n\}/) || [''])[0]
  const cellExam = (appSrc.match(/function dashChExamCellHtml\(r\)[\s\S]*?\n\}/) || [''])[0]
  ok(cellOpen.length > 0 && cellExam.length > 0, '能取到两个单元格函数体')
  ok(cellOpen.includes('dashToggleChOpen(this)'), '挑战列含「开放挑战」按钮')
  ok(cellExam.includes('dashToggleChExam(this)'), '考试列含「开放考试」按钮')
  ok(cellOpen.includes('data-rid="${rid}"'), '挑战按钮带 data-rid（目标营次）')
  ok(cellExam.includes('data-rid="${rid}"'), '考试按钮带 data-rid（目标营次）')
  ok(cellOpen.includes("t('dashChOpenOn')") && cellOpen.includes("t('dashChOpenOff')"),
    '挑战开关徽章文案齐备（开/关两态）')
  ok(cellExam.includes("t('dashChExamOn')") && cellExam.includes("t('dashChExamOff')"),
    '考试开关徽章文案齐备（开/关两态）')
  ok(cellOpen.includes("t('dashChOpenHint')") && cellExam.includes("t('dashChExamHint')"),
    '两个按钮各带自己的 tooltip（复用既有 hint 键）')
  // 营次表接线：表头 7 列 + 行 7 个单元格，开关列在「开放时间」之后、「操作」之前
  // 函数体取到 dashRoundEmpty 那行结尾（该套件在函数体下方紧跟「收集新建表单里勾选的适用部门」注释）
  const panel = (appSrc.match(/function dashRoundsPanelHtml\(\)[\s\S]*?\(t\('dashRoundEmpty'\)\)[\s\S]{0,120}?\n\}\n/) ||
    [appSrc.slice(appSrc.indexOf('function dashRoundsPanelHtml'), appSrc.indexOf('function dashPickedDepts'))])[0]
  ok(panel.length > 0, '能取到 dashRoundsPanelHtml 函数体')
  const iOpenCol = panel.indexOf("t('dashChOpenTitle')")
  const iExamCol = panel.indexOf("t('dashChExamTitle')")
  ok(iOpenCol > 0 && iExamCol > iOpenCol, '表头含「挑战」「考试」两列且挑战在前')
  ok(panel.indexOf("t('dashRoundWindowLabel')") < iOpenCol, '开关列在「开放时间」之后')
  ok(iExamCol < panel.indexOf("t('dashRoundOpsLabel')"), '开关列在「操作」之前')
  ok(/\$\{dashChOpenCellHtml\(r\)\}[\s\S]{0,80}?\$\{dashChExamCellHtml\(r\)\}/.test(panel),
    '行内两个开关单元格顺序与表头一致（挑战 → 考试）')
  // 说明文案：含 v117 的「设为当前」说明 + v118 的开关列说明，且都在表格之前
  ok(panel.includes("t('dashRoundCurHint')"), '营次表保留「设为当前」说明（v117）')
  ok(panel.includes("t('dashRoundSwitchHint')"), '营次表含开关列说明（v118）')
  ok(panel.indexOf("t('dashRoundSwitchHint')") < panel.indexOf('<table class="admin-table"'),
    '开关列说明位于表格之前')
  // 处理函数传 roundId
  const tOpen = (appSrc.match(/async function dashToggleChOpen\(btn\)[\s\S]*?\n\}/) || [''])[0]
  const tExam = (appSrc.match(/async function dashToggleChExam\(btn\)[\s\S]*?\n\}/) || [''])[0]
  ok(tOpen.includes('btn.dataset.rid'), 'dashToggleChOpen 从 data-rid 取营次')
  ok(tOpen.includes('setChallengeOpen({ open: next, roundId: rid })'), 'dashToggleChOpen 传 roundId')
  ok(tExam.includes('btn.dataset.rid'), 'dashToggleChExam 从 data-rid 取营次')
  ok(tExam.includes('setChallengeExamOpen({ open: next, roundId: rid })'), 'dashToggleChExam 传 roundId')
  ok(tOpen.includes('dashRefreshRoundsPanel()'), '挑战开关成功后就地重绘营次表')
  ok(tExam.includes('dashRefreshRoundsPanel()'), '考试开关成功后就地重绘营次表')
  // 只在改指针期时动侧信道
  ok(/if \(rid === dashRoundCurId\(\)\) CloudSync\._chExamOpen = next/.test(tExam),
    '仅当改的是当前指针期时才同步 _chExamOpen（避免学员端读错期）')
  // 正反双向断言：新家有 / 老家没（v112/v113 纪律）
  ok(appSrc.includes('function dashRefreshRoundsPanel'), '新刷新函数 dashRefreshRoundsPanel 已定义')
  ok(/id="dashRoundsPanel"/.test(appSrc), '营次表容器 #dashRoundsPanel 仍是刷新目标')
  ok(!appSrc.includes('function dashChGatePanelHtml'), '独立开关面板 dashChGatePanelHtml 已移除')
  ok(!appSrc.includes('function dashChRoundGateCardHtml'), '独立单期卡 dashChRoundGateCardHtml 已移除')
  ok(!appSrc.includes('function dashRoundsForGate'), '按部门过滤的 dashRoundsForGate 已移除')
  ok(!/id="dashChGate"/.test(appSrc), '独立容器 id dashChGate 已移除')
  ok(!/\$\{dashChGatePanelHtml\(\)\}/.test(appSrc), '模板中不再调用 dashChGatePanelHtml')
  // 兼容入口保留（别名链不报错）：dashRefreshExamGate → dashRefreshChGate → dashRefreshRoundsPanel
  ok(appSrc.includes('function dashRefreshExamGate() { dashRefreshChGate() }'),
    '保留兼容入口 dashRefreshExamGate → dashRefreshChGate')
  ok(appSrc.includes('function dashRefreshChGate() { dashRefreshRoundsPanel() }'),
    '保留兼容入口 dashRefreshChGate → dashRefreshRoundsPanel')
  ok(!appSrc.includes('function dashChExamGateHtml'), '旧单卡 dashChExamGateHtml 已移除')
  ok(!appSrc.includes('function dashChOpenGateHtml'), '旧单卡 dashChOpenGateHtml 已移除')
  ok(!appSrc.includes('id="dashChExamGate"'), '旧容器 id dashChExamGate 已移除')

  console.log('=== 七、i18n 键成对 ===')
  const i18nSrc = read('i18n.js')
  ;['dashChGatePanelTitle', 'dashChGatePanelHint', 'dashChGateCurTag', 'dashChGateNoRound',
    'dashChOpenTitle', 'dashChExamTitle', 'dashChOpenOn', 'dashChOpenOff', 'dashChExamOn', 'dashChExamOff',
    'dashRoundSwitchHint'].forEach(k => {
    eq((i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 2, `i18n ${k} 中英成对`)
  })

  console.log('')
  console.log(`PASS ${PASS} / FAIL ${FAIL}`)
  if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
  process.exit(FAIL ? 1 : 0)
})()
