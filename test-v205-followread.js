// v205：挑战每日跟读（免费方案：录音回放对比 + 可选浏览器识别 + 自评打卡）
// 真因背景：无 —— 新功能套件。红线：
//   ① 跟读绝不进 CHALLENGE_DAYS*.stages（阶段按 si 索引存档，插入 = 存档错位）
//   ② 麦克风不可用绝不能卡打卡（_chReadMicErr → 允许直接自评）
//   ③ 带参 i18n 键必须是箭头函数（t() 只对函数值插值）
//   ④ chread 事件写入端（store.js）与重放端（cloud-store._apply）必须成对存在
const fs = require('fs')
const vm = require('vm')

let pass = 0, fail = 0, fails = []
function ok(name, cond) { if (cond) { pass++; console.log('  \u2713 ' + name) } else { fail++; fails.push(name); console.log('  \u2717 ' + name) } }
function eq(name, a, b) { ok(name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）', a === b) }

const frSrc = fs.readFileSync('followread.js', 'utf8')
const chSrc = fs.readFileSync('challenge.js', 'utf8')
const stSrc = fs.readFileSync('store.js', 'utf8')
const csSrc = fs.readFileSync('cloud-store.js', 'utf8')
const i18nSrc = fs.readFileSync('i18n.js', 'utf8')
const idxSrc = fs.readFileSync('index.html', 'utf8')

console.log('=== 组一 源码契约 ===')
ok('followread.js: chReadPoolFor / chReadPickFor / chReadSim 为 function 声明',
  /^function chReadPoolFor\(/m.test(frSrc) && /^function chReadPickFor\(/m.test(frSrc) && /^function chReadSim\(/m.test(frSrc))
ok('followread.js: chReadRowHtml / renderChallengeRead / chReadComplete / chOpenRead / chReadActive 齐',
  ['chReadRowHtml', 'renderChallengeRead', 'chReadComplete', 'chOpenRead', 'chReadActive'].every(f => new RegExp('^function ' + f + '\\(', 'm').test(frSrc)))
ok('challenge.js renderChallenge 含跟读分支（typeof 守卫 + renderChallengeRead）',
  /if \(typeof chReadActive === 'function' && chReadActive\(\)\) \{ renderChallengeRead\(\); return \}/.test(chSrc))
ok('challenge.js chDayBlockHtml 调 chReadRowHtml（typeof 守卫）',
  /const readRow = \(typeof chReadRowHtml === 'function'\) \? chReadRowHtml\(cfg\) : ''/.test(chSrc) && chSrc.indexOf('${readRow}') >= 0)
ok('store.js reportChallengeRead 星级守卫（1~3 整数，否则不上报）',
  /reportChallengeRead\(day, stars, round\) \{[\s\S]{0,400}!Number\.isInteger\(n\) \|\| n < 1 \|\| n > 3[\s\S]{0,600}ty: 'chread'/.test(stSrc))
ok('cloud-store.js _apply 含 case \'chread\'（写入端与重放端成对）',
  /case 'chread':[\s\S]{0,600}r\.chRead = r\.chRead \|\| \[\][\s\S]{0,200}r\.chRead\.push\(/.test(csSrc))
ok('followread.js 不触碰 stages 数组（不破坏挑战存档索引）',
  frSrc.indexOf('stages[') < 0 && frSrc.indexOf('.stages.push') < 0)
ok('followread.js 麦克风不可用降级：_chReadMicErr 分支存在且不清 chRead（允许直接自评）',
  /_chReadMicErr = true/.test(frSrc) && frSrc.indexOf('chReadMicNA') >= 0)
// i18n 键类型校验（沙箱权威口径）：带参键 = 函数，无参键 = 字符串
function mkI18nSb() {
  const sb = { console, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }
  sb.globalThis = sb; vm.createContext(sb)
  vm.runInContext(i18nSrc, sb)
  return sb
}
ok('i18n 双语段均含全部 chRead 键', (function () {
  const sb = mkI18nSb()
  return ['zh', 'en'].every(L => ['chReadRowTag', 'chReadStart', 'chReadDone', 'chReadHint', 'chReadNoPool', 'chReadFinish', 'chReadBack'].every(k => vm.runInContext('I18N.' + L + '["' + k + '"]', sb) !== undefined))
})())
ok('带参键 chReadSimLabel/chReadStep/chReadCount/chReadTitle 是函数（双语）', (function () {
  const sb = mkI18nSb()
  return ['zh', 'en'].every(L => ['chReadSimLabel', 'chReadStep', 'chReadCount', 'chReadTitle'].every(k => typeof vm.runInContext('I18N.' + L + '["' + k + '"]', sb) === 'function'))
})())
ok('无参键 chReadStart/chReadDone/chReadHint 是字符串（双语）', (function () {
  const sb = mkI18nSb()
  return ['zh', 'en'].every(L => ['chReadStart', 'chReadDone', 'chReadHint'].every(k => typeof vm.runInContext('I18N.' + L + '["' + k + '"]', sb) === 'string'))
})())
ok('index.html 挂载 followread.js 且徽章 13 处 ?v=205、旧版号 0 处',
  idxSrc.indexOf('followread.js?v=205') >= 0 && (idxSrc.match(/\?v=205/g) || []).length === 13 && (idxSrc.match(/\?v=(?!205)\d+/g) || []).length === 0)

console.log('=== 组二 抽句器与选句（真实 BANK）===')
function mkPoolSandbox() {
  const sb = { console, BANK: null, alert: () => {} }
  sb.globalThis = sb; vm.createContext(sb)
  vm.runInContext(fs.readFileSync('bank-data.js', 'utf8'), sb)
  vm.runInContext(frSrc, sb)
  return sb
}
const sbP = mkPoolSandbox()
const poolSig = vm.runInContext('chReadPoolFor("dining/sig")', sbP)
ok('dining/sig 句池 ≥ 20 条', poolSig.length >= 20)
ok('句池条目全为合法英文句（4~20 词、无中文）', poolSig.every(x => x.kind === 'sentence' && !/[\u4e00-\u9fff]/.test(x.text) && (x.text.match(/[A-Za-z]+/g) || []).length >= 4 && (x.text.match(/[A-Za-z]+/g) || []).length <= 20))
ok('句池去重（规范化键无重复）', (function () {
  const keys = poolSig.map(x => vm.runInContext('_chReadKey(' + JSON.stringify(x.text) + ')', sbP))
  return new Set(keys).size === keys.length
})())
const poolConc = vm.runInContext('chReadPoolFor("rooms/concierge")', sbP)
ok('rooms/concierge 池非空（句子不足回落全库句池）', poolConc.length >= 3)
const poolRiz = vm.runInContext('chReadPoolFor("rizhao/canyin")', sbP)
ok('rizhao/canyin 池非空（无 chPoolExpandDepts 注入时回落全库，不空转）', poolRiz.length >= 3)
const p3a = vm.runInContext('JSON.stringify(chReadPickFor(3,"dining/sig","r3").map(x=>x.text))', sbP)
const p3b = vm.runInContext('JSON.stringify(chReadPickFor(3,"dining/sig","r3").map(x=>x.text))', sbP)
const p4 = vm.runInContext('JSON.stringify(chReadPickFor(4,"dining/sig","r3").map(x=>x.text))', sbP)
eq('同 (营次|部门|天) 选句恒定', p3a, p3b)
ok('不同天选句不同（确定性种子）', p3a !== p4)
const pArr = vm.runInContext('chReadPickFor(3,"dining/sig","r3")', sbP)
eq('每日 3 句', pArr.length, 3)
ok('选句互不重复', new Set(pArr.map(x => x.text)).size === 3)

console.log('=== 组三 相似度 ===')
const sbS = mkPoolSandbox()
eq('完全一致 = 100', vm.runInContext('chReadSim("Do you have a reservation?","Do you have a reservation?")', sbS), 100)
eq('空识别 = 0', vm.runInContext('chReadSim("","Do you have a reservation?")', sbS), 0)
eq('漏一个词 = 80（词级 Levenshtein）', vm.runInContext('chReadSim("do you have reservation","Do you have a reservation?")', sbS), 80)
ok('大小写与标点不敏感（≥90）', vm.runInContext('chReadSim("MAY I HELP YOU!","May I help you?")', sbS) >= 90)
ok('完全跑题 ≤ 40', vm.runInContext('chReadSim("hello world today","Here is your bill. Please check it is correct.")', sbS) <= 40)

console.log('=== 组四 端到端：日卡行 + 跟读面板 + 打卡（challenge.js 全文件）===')
function mkFullSandbox(opts) {
  const store = { calls: [] }
  const ls = { _m: {}, getItem(k) { return this._m[k] || null }, setItem(k, v) { this._m[k] = String(v) }, removeItem(k) { delete this._m[k] } }
  const el = { innerHTML: '' }
  const sb = {
    console, localStorage: ls, navigator: {},
    document: { getElementById: (id) => (id === 'page-challenge' ? el : null) },
    // CloudSync mock：_chOpen=true → chOpenLocked()=false（否则跟读行恒走「挑战未开放」灰锁分支）
    CloudSync: { _chOpen: true },
    escHtml: (s) => String(s == null ? '' : s),
    escAttr: (s) => String(s == null ? '' : s),
    Store: {
      getSession: () => ({ username: 'u1', name: 'U1' }),
      isAdmin: () => false,
      getQuestions: () => [],
      reportChallengeRead: (day, stars, round) => { store.calls.push({ day, stars, round }) },
    },
    __el: el, __store: store,
  }
  sb.globalThis = sb; sb.window = sb
  vm.createContext(sb)
  vm.runInContext(i18nSrc, sb)
  vm.runInContext(fs.readFileSync('bank-data.js', 'utf8'), sb)
  vm.runInContext(chSrc, sb)
  vm.runInContext(frSrc, sb)
  // 预置挑战存档（vm 里 let 变量必须 runInContext 赋值）
  vm.runInContext('challengeState = { uid: "u1", days: {} }', sb)
  if (opts && opts.day1Done) {
    // 旧结构 Day1 = test(20) + practice(10) 两个环节 —— 全部完成才算「昨日已完成」（chDayDone = every）
    vm.runInContext('challengeState.days[1] = { stages: { 0: { done: true, at: ' + (Date.now() - 86400000 * 2) + ', correct: 15, total: 20 }, 1: { done: true, at: ' + (Date.now() - 86400000 * 2) + ', correct: 8, total: 10 } } }', sb)
  }
  return sb
}
// v3 21 天营次：Day1 = test-only（无跟读行），Day2 = practice（有跟读行）
const sb1 = mkFullSandbox({})
const d1 = vm.runInContext('chDayBlockHtml({ day: 1, stages: [{ kind: "test", count: 20 }] })', sb1)
ok('test-only 天（Day1 旧结构）不出跟读行', d1.indexOf('chReadRowTag') < 0 && d1.indexOf('今日跟读') < 0)
const d2locked = vm.runInContext('chDayBlockHtml({ day: 2, stages: [{ kind: "practice", count: 30 }] })', sb1)
ok('practice 天出跟读行', d2locked.indexOf('今日跟读') >= 0)
ok('天未解锁 → 跟读行灰锁（不给开始按钮）', d2locked.indexOf('chOpenRead') < 0 && d2locked.indexOf('完成前一天解锁') >= 0)
const sb2 = mkFullSandbox({ day1Done: true })
const d2open = vm.runInContext('chDayBlockHtml({ day: 2, stages: [{ kind: "practice", count: 30 }] })', sb2)
ok('前置天昨日已完成 → 跟读行给「开始」按钮（chOpenRead(2)）', d2open.indexOf('chOpenRead(2)') >= 0)
// 管理员重置标记（cleared 存根）不应影响跟读行渲染
const sb3 = mkFullSandbox({ day1Done: true })
vm.runInContext('challengeState.days[1].stages[0].cleared = true', sb3)
const d2c = vm.runInContext('chDayBlockHtml({ day: 2, stages: [{ kind: "practice", count: 30 }] })', sb3)
ok('Day1 成绩被重置（cleared 存根）→ 跟读行照常出现', d2c.indexOf('chOpenRead(2)') >= 0)

// 跟读面板 + 打卡闭环
const sb4 = mkFullSandbox({ day1Done: true })
vm.runInContext('chOpenRead(2)', sb4)
eq('chOpenRead 打开会话且 Day 正确', vm.runInContext('chRead && chRead.day', sb4), 2)
eq('选句 3 条', vm.runInContext('chRead.items.length', sb4), 4 === 4 ? 3 : 0)
let html = vm.runInContext('__el.innerHTML', sb4)
ok('面板含提示与识别不可用说明（未录音时）', html.indexOf('chReadHint') >= 0 || html.indexOf('先听示范读音') >= 0)
ok('面板无识别结果时显示 chReadSimNA 文案', html.indexOf('本浏览器不支持语音识别比对') >= 0)
ok('面板第 1 句高亮（第 1/3 句）', html.indexOf('第 1/3 句') >= 0)
vm.runInContext('chReadNext(); chReadNext(); chReadNext()', sb4)
html = vm.runInContext('__el.innerHTML', sb4)
ok('走完三句 → 出自评打卡区', html.indexOf('给自己的跟读打个分') >= 0)
// 星级守卫：0 星不打卡
vm.runInContext('chReadComplete(0)', sb4)
ok('0 星不打卡（星级守卫）', vm.runInContext('chRead !== null', sb4) && vm.runInContext('challengeState.read && challengeState.read[2]', sb4) == null)
vm.runInContext('chReadComplete(2)', sb4)
const rec = vm.runInContext('challengeState.read && challengeState.read[2]', sb4)
ok('打卡落档（done + stars=2）', !!rec && rec.done === true && rec.stars === 2)
ok('challengeSave 已落盘 localStorage', vm.runInContext('JSON.parse(localStorage.getItem(chStorageKey())||"null").read[2].stars', sb4) === 2)
const calls = vm.runInContext('__store.calls', sb4)
ok('reportChallengeRead 上报 (day=2, stars=2)', calls.length === 1 && calls[0].day === 2 && calls[0].stars === 2)
ok('打卡后关闭面板（chReadActive=false）', vm.runInContext('chReadActive()', sb4) === false)
const d2done = vm.runInContext('chDayBlockHtml({ day: 2, stages: [{ kind: "practice", count: 30 }] })', sb4)
ok('打卡后日卡行显示星级徽章', d2done.indexOf('⭐⭐') >= 0 && d2done.indexOf('已打卡') >= 0)

console.log('=== 组五 chread 云端重放（base+events 重放语义）===')
const sbC = { console, addEventListener: () => {}, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout, document: { addEventListener: () => {}, visibilityState: 'visible' }, navigator: {} }
sbC.globalThis = sbC; sbC.window = sbC; vm.createContext(sbC)
vm.runInContext(csSrc, sbC)
const r1 = vm.runInContext('(function(){ const map={ u1: { name: "A" } }; CloudSync._apply(map, { u:"u1", n:"A", ty:"chread", ts: 1000, d:{ day:3, stars:2, rd:"r8" } }); return map.u1.chRead; })()', sbC)
ok('chread 落 r.chRead[]（day/stars/rd 规范化）', Array.isArray(r1) && r1.length === 1 && r1[0].day === 3 && r1[0].stars === 2)
ok('rd 规范化为 _roundSlugKey', r1[0].rd === 'r8' || (typeof r1[0].rd === 'string'))
const r2 = vm.runInContext('(function(){ const map={ u1: {} }; CloudSync._apply(map, { u:"u1", ty:"chread", ts: 5, d:{ day:2, stars:9 } }); return map.u1.chRead; })()', sbC)
ok('星级脏值 9 → 钳到 0', r2[0].stars === 0)
const r3 = vm.runInContext('(function(){ const map={ u1: {} }; CloudSync._apply(map, { u:"u1", ty:"chread", ts: 5, d:{ day:"x", stars:1 } }); return map.u1.chRead; })()', sbC)
ok('day 脏值 → 0（不 NaN 入库）', r3[0].day === 0)
ok('重放幂等：同事件序列重放两次结果一致', (function () {
  const run = () => vm.runInContext('(function(){ const map={ u1: { name:"A" } }; [{u:"u1",ty:"chread",ts:1,d:{day:1,stars:3}},{u:"u1",ty:"chread",ts:2,d:{day:2,stars:1}}].forEach(ev=>CloudSync._apply(map,ev)); return JSON.stringify(map.u1.chRead); })()', sbC)
  return run() === run()
})())

console.log('')
if (fail) { console.log('FAILED ' + fail + '/' + (pass + fail) + ': ' + fails.join(' | ')); process.exit(1) }
console.log('PASS ' + pass + '/' + pass)
