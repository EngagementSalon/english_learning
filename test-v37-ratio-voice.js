// ====== v37 测试：AI 生成配额扩展看字选音 + 比例合计 100% 校验 ======
// A. courseRatioToTarget 四键换算
// B. courseReadGenInputs 合计 100% 校验（≠100 alert+null；=100 正常；全空混出）
// C. QGen.generate target.voicematch 精确产出；三键配额不产出 voicematch
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

// ============ vm 沙箱（同 test-course-draft-ratio 结构） ============
const elements = {}
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '',
    title: '', placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}
const getEl = id => elements[id] || (elements[id] = mkEl())

getEl('caGenTotal').value = '40'
getEl('caPctSingle').value = ''
getEl('caPctJudge').value = ''
getEl('caPctListen').value = ''
getEl('caPctVoicematch').value = ''

let alertMsg = null
const sandbox = {
  localStorage: {
    store: {},
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  TextEncoder,
  window: {
    addEventListener() {}, scrollTo() {},
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function () {},
    dispatchEvent() {}, CustomEvent: function () {},
  },
  document: {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    body: { appendChild() {} },
    title: '',
    addEventListener() {},
  },
  alert(m) { alertMsg = String(m) }, confirm() { return true }, prompt() { return null },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, RegExp, Set, Map, Promise,
  CloudSync: {
    status: 'online', onStatus() {}, enqueue() {},
    recalcCloudPlacementLevels: async () => ({}),
    getDashboardData: async () => ([]),
    flushDuration() {},
  },
  CourseStore: {
    status: 'online',
    newId: (p) => p + '_' + Date.now().toString(36) + '_t',
    findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
    findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
    getDoc: async () => ({ v: 1, classes: [] }),
    mutate: async (fn) => { return true },
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

// 加载顺序：i18n → bank-data → store → course-app
vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8'), sandbox)

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

;(async () => {
  console.log('\n🧪 A. courseRatioToTarget 四键换算')
  const c2t = (total, pct) => vm.runInContext(`courseRatioToTarget(${total}, ${JSON.stringify(pct)})`, sandbox)
  let t1 = c2t(60, { single: 60, judge: 30, listen: 10 })
  assert('60/30/10（无vm键）→ 36/18/6/vm0', t1 && t1.single === 36 && t1.judge === 18 && t1.listen === 6 && t1.voicematch === 0, JSON.stringify(t1))
  t1 = c2t(40, { single: 50, judge: null, listen: null, voicematch: 50 })
  assert('50/留空/留空/50 + 总40 → 20/0/0/20', t1 && t1.single === 20 && t1.judge === 0 && t1.listen === 0 && t1.voicematch === 20, JSON.stringify(t1))
  t1 = c2t(10, { voicematch: 100 })
  assert('仅看字选音 100% + 总10 → 0/0/0/10', t1 && t1.single === 0 && t1.judge === 0 && t1.listen === 0 && t1.voicematch === 10, JSON.stringify(t1))
  t1 = c2t(60, { single: 40, judge: 20, listen: 20, voicematch: 20 })
  assert('40/20/20/20 + 总60 → 24/12/12/12', t1 && t1.single === 24 && t1.judge === 12 && t1.listen === 12 && t1.voicematch === 12, JSON.stringify(t1))
  t1 = c2t(60, { single: null, judge: null, listen: null, voicematch: null })
  assert('全留空 → null（自动混出）', t1 === null, JSON.stringify(t1))
  t1 = c2t(60, { single: 0, judge: 0, listen: 0, voicematch: 0 })
  assert('全 0 → null（自动混出）', t1 === null, JSON.stringify(t1))
  t1 = c2t(60, { single: 50, judge: 30, listen: null })
  assert('三键 50/30/留空 → 38/23/0（按已填归一，兼容旧断言语义）', t1 && t1.single === 38 && t1.judge === 23 && t1.listen === 0, JSON.stringify(t1))

  console.log('\n🧪 B. courseReadGenInputs 合计 100% 校验')
  const rgi = (setup) => {
    alertMsg = null
    setup()
    return vm.runInContext(`courseReadGenInputs('caGenTotal', 'ca')`, sandbox)
  }
  // B1: 合计 100% → 正常返回四键 target
  let r = rgi(() => {
    getEl('caPctSingle').value = '40'; getEl('caPctJudge').value = '20'
    getEl('caPctListen').value = '20'; getEl('caPctVoicematch').value = '20'
  })
  assert('40/20/20/20 合计100 → 通过，无 alert', alertMsg === null, 'alert=' + alertMsg)
  assert('target 四键 = 16/8/8/8（总40）', r && r.target && r.target.single === 16 && r.target.judge === 8 && r.target.listen === 8 && r.target.voicematch === 8, JSON.stringify(r && r.target))
  assert('opt 携带 target', r && r.opt && r.opt.target && r.opt.target.voicematch === 8, JSON.stringify(r && r.opt))
  // B2: 合计 ≠ 100 → alert + null
  r = rgi(() => {
    getEl('caPctSingle').value = '60'; getEl('caPctJudge').value = '20'
    getEl('caPctListen').value = ''; getEl('caPctVoicematch').value = ''
  })
  assert('60/20 = 80% → alert 提示', alertMsg !== null && alertMsg.includes('100') && alertMsg.includes('80'), 'alert=' + alertMsg)
  assert('返回 null（调用处终止）', r === null, JSON.stringify(r))
  // B3: 合计超 100 → 拦截
  r = rgi(() => {
    getEl('caPctSingle').value = '70'; getEl('caPctJudge').value = '70'
    getEl('caPctListen').value = ''; getEl('caPctVoicematch').value = ''
  })
  assert('70/70 = 140% → alert 拦截', alertMsg !== null && r === null, 'alert=' + alertMsg)
  // B4: 全留空 → 混出（无 target），无 alert
  r = rgi(() => {
    getEl('caPctSingle').value = ''; getEl('caPctJudge').value = ''
    getEl('caPctListen').value = ''; getEl('caPctVoicematch').value = ''
  })
  assert('全留空 → 无 alert、无 target（混出）', alertMsg === null && r && r.opt && !r.opt.target, JSON.stringify(r && r.opt))
  // B5: 四类读值包含 voicematch 输入框
  r = rgi(() => {
    getEl('caPctSingle').value = ''; getEl('caPctJudge').value = ''
    getEl('caPctListen').value = ''; getEl('caPctVoicematch').value = '100'
  })
  assert('仅看字选音 100 → 通过且 target.vm=40', r && r.target && r.target.voicematch === 40 && r.target.single === 0, JSON.stringify(r && r.target))
  // B6: 边界值裁剪（>100 按 100 算 → 合计校验仍生效）
  r = rgi(() => {
    getEl('caPctSingle').value = '150'; getEl('caPctJudge').value = ''
    getEl('caPctListen').value = ''; getEl('caPctVoicematch').value = ''
  })
  assert('150 裁剪为 100 → 合计 100 通过，target.single=总题数', r && r.target && r.target.single === 40, JSON.stringify(r && r.target))

  console.log('\n🧪 C. QGen.generate 配额含看字选音')
  const QGen = require('./qgen.js')
  // 构造素材充足文本（同 test-course-draft-ratio）：10 术语定义 + 20 词对 + 24 句双语
  const defs = ['Bistro：小餐馆', 'Concierge：礼宾部', 'Check-in：办理入住', 'Check-out：办理退房', 'Turndown：开夜床', 'Amenity：客房设施', 'Up-sell：向上销售', 'Overbooking：超额预订', 'Complimentary：免费赠送', 'Minibar：迷你吧']
  const gloss = ['reservation（预订）', 'escort（护送）', 'registration（登记）', 'arrival（抵达）', 'lobby（大堂）', 'suite（套房）', 'buffet（自助餐）', 'housekeeping（客房部）', 'laundry（洗衣）', 'valet（代客泊车）', 'banquet（宴会）', 'coupon（优惠券）', 'invoice（发票）', 'luggage（行李）', 'voucher（凭证）', 'refreshment（茶点）', 'switchboard（总机）', 'deposit（押金）', 'extension（分机）', 'porter（行李员）']
  const sents = []
  for (let i = 0; i < 12; i++) {
    sents.push('May I take your order sir. 先生请问需要点餐吗。')
    sents.push('Please wait a moment. 请稍等片刻。')
  }
  const richText = defs.join('\n') + '\n' + gloss.join('\n') + '\n' + sents.join('\n')
  const cnt = (qs, ty) => qs.filter(x => x.type === ty).length

  // C1: 四键配额精确产出
  const r1 = QGen.generate(richText, { max: 60, target: { single: 20, judge: 10, listen: 5, voicematch: 10 } })
  const c1 = { s: cnt(r1.questions, 'single'), j: cnt(r1.questions, 'judge'), l: cnt(r1.questions, 'listen'), v: cnt(r1.questions, 'voicematch') }
  assert('四键配额精确 20/10/5/10', c1.s === 20 && c1.j === 10 && c1.l === 5 && c1.v === 10, JSON.stringify(c1))
  // C2: voicematch 题格式正确
  const vmq = r1.questions.filter(q => q.type === 'voicematch')
  assert('voicematch 题 answer 指向题干文本所在选项', vmq.every(q => q.answer.length === 1 && q.options[q.answer[0]] === q.question),
    JSON.stringify(vmq.slice(0, 2).map(q => ({ q: q.question, a: q.options[q.answer[0]] }))))
  assert('voicematch 题干 ≤70 字符', vmq.every(q => q.question.length <= 70), vmq.map(q => q.question.length).join(','))
  assert('voicematch 选项无重复', vmq.every(q => new Set(q.options).size === q.options.length), '')
  // C3: 输出分组顺序（single → judge → listen → voicematch）
  const types = r1.questions.map(q => q.type)
  const firstIdx = ty => types.indexOf(ty)
  assert('分组顺序 single → judge → listen → voicematch',
    firstIdx('single') < firstIdx('judge') && firstIdx('judge') < firstIdx('listen') && firstIdx('listen') < firstIdx('voicematch'),
    types.join(','))
  // C4: 仅看字选音配额
  const r2 = QGen.generate(richText, { max: 60, target: { voicematch: 8 } })
  assert('仅 voicematch 配额 → 全部为 voicematch 且 8 题', r2.questions.length === 8 && r2.questions.every(q => q.type === 'voicematch'),
    `n=${r2.questions.length} types=${[...new Set(r2.questions.map(q => q.type))].join(',')}`)
  // C5: 三键配额（无 vm 键）不产出 voicematch（v36 行为保留）
  const r3 = QGen.generate(richText, { max: 40, target: { single: 3, judge: 3, listen: 3 } })
  assert('三键配额不产出 voicematch', r3.questions.every(q => ['single', 'judge', 'listen'].includes(q.type)),
    [...new Set(r3.questions.map(q => q.type))].join(','))
  // C6: 混出模式（无 target）仍产出 voicematch
  const r4 = QGen.generate(richText, { max: 60 })
  assert('混出模式仍产出 voicematch', r4.questions.some(q => q.type === 'voicematch'), [...new Set(r4.questions.map(q => q.type))].join(','))

  console.log('\n🧪 D. i18n 词条')
  const hasVoice = vm.runInContext(`['zh','en'].every(L => { const d = I18N[L]; return d.courseRatioVoice && typeof d.courseRatioSumErr === 'function' && d.courseRatioHint.includes('100') })`, sandbox)
  assert('courseRatioVoice / courseRatioSumErr / courseRatioHint 双语齐全', hasVoice, '')
  const zhErr = vm.runInContext(`I18N.zh.courseRatioSumErr(80)`, sandbox)
  assert('错误提示含当前合计值', zhErr.includes('80'), zhErr)

  console.log(failed ? '\n❌ 有失败项' : '\n✅ 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
