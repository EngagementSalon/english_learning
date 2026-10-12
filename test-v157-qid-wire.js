// ====== test-v157-qid-wire：上传库题号（非数字）perq 上报丢失修复 ======
// 背景（2026-10-12 线上定位）：艳中餐厅看板「📌 挑战错题排行」整卡不渲染。
//   真因 = 挑战题池里艳中一道种子题都没有（bank-data.js cat12: sig 633 / bar 51 / ird 236 / yan 0），
//   艳中的挑战题全部来自「管理员上传库」doc.upq —— 其题号是 'u1792' 这类**字符串**
//   （cloud-store.js _upqUnpack: id: String(x.i)），而 reportPerQuestion 写死 Number(qid)：
//     Number('u1792') = NaN → JSON.stringify({qid:NaN}) → {"qid":null}
//     → 云端聚合 `if (d.qid != null)` 静默丢弃 → perQ/chQ 全空 → 错题卡无条件不渲染。
// 本套件守护：① 线格式转型函数 qidToWire 的行为；② 上报端到端（含 JSON 往返）；
//   ③ 云端聚合联动；④ 看板错题行端到端；⑤ 数字题号存量行为零变化；⑥ 版本号。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}
function done() {
  console.log(testFailed ? '\n❌ 有失败' : '\n✅ 全部通过')
  process.exit(testFailed ? 1 : 0)
}
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf-8')
// 去注释后取代码（★ 必须：本版新增注释里就写着 Number(qid) 的反例说明，
//   不断言剔除注释 = 护栏被自己的注释喂饱 → 假通过）
function codeOnly(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
  s = s.split('\n').map(line => {
    let inS = null, out = ''
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inS) { out += ch; if (ch === inS && line[i - 1] !== '\\') inS = null; continue }
      if (ch === '"' || ch === "'" || ch === '`') { inS = ch; out += ch; continue }
      if (ch === '/' && line[i + 1] === '/') break
      out += ch
    }
    return out
  }).join('\n')
  return s
}
const count = (s, sub) => s.split(sub).length - 1
function extractFn(src, name) {
  const i = src.indexOf('function ' + name)
  if (i < 0) return ''
  let d = 0, started = false
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1) }
  }
  return ''
}

const STORE_SRC = read('store.js')
const APP_SRC = read('app.js')
const COURSE_SRC = read('course-app.js')
const CLOUD_SRC = read('cloud-store.js')
const HTML_SRC = read('index.html')

// ---------- 沙箱构造（沿用 test-perq.js 范式） ----------
function makeCloudMock() {
  return { queue: [], enqueue(ev) { this.queue.push(ev) }, pushPending() { return Promise.resolve() } }
}
function makeStoreSandbox({ users, session, questions, cloudMock }) {
  const sb = {
    localStorage: {
      store: {
        eq_users: JSON.stringify(users || []),
        eq_counter: '100',
        eq_session: JSON.stringify(session || null),
        eq_questions: JSON.stringify(questions || []),
      },
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    setInterval() { return 0 }, clearInterval() {},
    setTimeout() { return 0 }, clearTimeout() {},
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    TextEncoder, Uint8Array, crypto,
    CloudSync: cloudMock,
    t: k => k,
  }
  vm.createContext(sb)
  vm.runInContext(STORE_SRC, sb)
  return sb
}
function loadCloudStore() {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    setInterval() { return 0 }, clearInterval() {},
    setTimeout() { return 0 }, clearTimeout() {},
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    TextEncoder, Uint8Array, crypto,
    CloudSync: makeCloudMock(),
  }
  vm.createContext(sb)
  vm.runInContext(CLOUD_SRC, sb)
  return vm.runInContext('CloudSync', sb)
}
const SESSION = { id: 1, username: 'cloud', name: '姬小钰', role: 'student' }
const USER = { id: 1, username: 'cloud', ph: 'x', salt: 'y', name: '姬小钰', dept: '饮食部·艳中餐厅', role: 'student', createdAt: 100 }

// ============================================================
console.log('\n组〇 源码契约护栏')

{
  const storeCode = codeOnly(STORE_SRC)
  const appCode = codeOnly(APP_SRC)
  const courseCode = codeOnly(COURSE_SRC)

  assert('store.js 定义了 qidToWire', storeCode.includes('function qidToWire('))
  assert('store.js 里 Number(qid) 已清零（代码区）', count(storeCode, 'Number(qid)') === 0, '实际 ' + count(storeCode, 'Number(qid)') + ' 处')
  const rep = extractFn(storeCode.replace(/\s+/g, ' '), 'reportPerQuestion')
  // 方法简写形式：reportPerQuestion(qid, ...) 不是 function 声明 → 用对象方法体定位
  const repBody = (() => {
    const i = storeCode.indexOf('reportPerQuestion(qid')
    if (i < 0) return ''
    return storeCode.slice(i, i + 900)
  })()
  assert('reportPerQuestion 走 qidToWire', repBody.includes('qidToWire(qid)'))
  assert('reportPerQuestion 对 null 题号提前 return', /wireQid == null\)\s*return/.test(repBody.replace(/\s+/g, ' ')) || repBody.includes('if (wireQid == null) return'))
  assert('reportPerQuestion 载荷用的是 wireQid 不是原始 qid', repBody.includes('qid: wireQid'))
  assert('course-app.js 里 Number(qid) 已清零（代码区）', count(codeOnly(COURSE_SRC), 'Number(qid)') === 0, '实际 ' + count(codeOnly(COURSE_SRC), 'Number(qid)') + ' 处')
  assert('course-app.js 走 qidToWire', courseCode.includes('qidToWire(qid)'))
  assert('app.js 里 qid: Number(qid) 已清零（两处看板行）', count(appCode, 'qid: Number(qid)') === 0, '实际 ' + count(appCode, 'qid: Number(qid)') + ' 处')
  assert('app.js 错题排行行用真实题号 q.id', appCode.includes('qid: q.id, question: q.question, type:'))
  assert('app.js 每题统计行用真实题号 q.id', appCode.includes('qid: q.id,\n      question: q.question,\n      category:'))
  assert('_upqUnpack 仍是 id: String(x.i)（题号契约未动）', codeOnly(CLOUD_SRC).includes('id: String(x.i)'))
  assert('云端聚合仍按 String(d.qid) 建键（兼容数字/字符串两种线格式）', codeOnly(CLOUD_SRC).includes('const qid = String(d.qid)'))
  // 存在性证据：挑战池（cat12）里艳中一道种子题都没有 → 艳中只能靠上传库 → 全站只有艳中会整卡缺失
  const bank = (() => {
    const sb = { console, JSON, Date, window: {} }
    vm.createContext(sb)
    vm.runInContext(read('bank-data.js') + '\n;globalThis.__B=BANK;', sb, { timeout: 20000 })
    return sb.__B
  })()
  const cat12 = (bank.questions || []).filter(q => Number(q.category_id) === 12)
  const yan12 = cat12.filter(q => q.dept === 'dining/yan').length
  const sig12 = cat12.filter(q => q.dept === 'dining/sig').length
  assert('cat12 挑战池：艳中 = 0（艳中挑战题全来自上传库）', yan12 === 0, '实际 ' + yan12)
  assert('cat12 挑战池：标帜 > 0（对照，说明别部门题号是数字）', sig12 > 0, '实际 ' + sig12)
  assert('种子库题号全是数字（全站唯一的字符串题号来源 = 上传库）', (bank.questions || []).every(q => typeof q.id === 'number'))
}

// ============================================================
console.log('\n组一 qidToWire 线格式转型（表驱动）')

{
  const sb = makeStoreSandbox({ users: [USER], session: SESSION, questions: [], cloudMock: makeCloudMock() })
  const f = vm.runInContext('qidToWire', sb)
  const cases = [
    [1792, 1792, 'number', '数字题号原样'],
    [0, 0, 'number', '数字 0 不丢（isFinite 判定）'],
    ['1792', 1792, 'number', '纯数字字符串 → 数字（存量键兼容）'],
    ['u1792', 'u1792', 'string', '上传库题号原样保留（★ 本版核心）'],
    [' u1792 ', 'u1792', 'string', '两端空白 trim'],
    ['u1792-w3', 'u1792-w3', 'string', '带连字符的字符串题号保留'],
    ['1792abc', '1792abc', 'string', '数字开头但非纯数字 → 字符串'],
    ['-5', -5, 'number', '负整数按数字（与 Number 行为一致）'],
    ['', null, 'object', '空串 → null（跳过上报）'],
    ['   ', null, 'object', '纯空白 → null'],
    [null, null, 'object', 'null → null'],
    [undefined, null, 'object', 'undefined → null'],
    [NaN, null, 'object', 'NaN → null（不再序列化成 null 载荷）'],
  ]
  cases.forEach(([inp, want, wantType, label]) => {
    const got = f(inp)
    assert(`${label}：${JSON.stringify(inp)} → ${JSON.stringify(want)}`,
      got === want && typeof got === wantType, `got ${JSON.stringify(got)} (${typeof got})`)
  })
}

// ============================================================
console.log('\n组二 上报端到端（真实 reportPerQuestion + JSON 往返）')

{
  const cloudMock = makeCloudMock()
  const sb = makeStoreSandbox({ users: [USER], session: SESSION, questions: [], cloudMock })
  const Store1 = vm.runInContext('Store', sb)
  const perq = () => cloudMock.queue.filter(e => e.ty === 'perq')

  // ① 挑战错答 + 上传库题号
  Store1.reportPerQuestion('u1792', false, true)
  assert('挑战错答（u 题号）上报 1 条', perq().length === 1)
  const d1 = perq()[0].d
  assert('载荷 qid = 字符串 "u1792"', d1.qid === 'u1792', JSON.stringify(d1))
  assert('载荷 ch = 1 且 correct = 0', d1.ch === 1 && d1.correct === 0)
  // ★ 核心判据：JSON 往返后题号仍在（修复前这里是 null → 云端丢弃）
  const wire1 = JSON.parse(JSON.stringify(d1))
  assert('★ JSON 往返后 qid 仍为 "u1792"（修复前为 null）', wire1.qid === 'u1792', JSON.stringify(wire1))
  assert('事件顶层带用户名', perq()[0].u === 'cloud')

  // ② 数字题号（存量行为零变化）
  cloudMock.queue.length = 0
  Store1.reportPerQuestion(1792, false, true)
  assert('数字题号仍发数字 1792（存量云端键零变化）', perq()[0].d.qid === 1792 && typeof perq()[0].d.qid === 'number', JSON.stringify(perq()[0].d))

  // ③ 练习答对（字符串题号）
  cloudMock.queue.length = 0
  Store1.reportPerQuestion('u1793', true, false)
  const d3 = perq()[0].d
  assert('练习答对：correct=1 且无 ch 标记', d3.correct === 1 && d3.ch === undefined, JSON.stringify(d3))
  assert('练习答对：qid 字符串保留', d3.qid === 'u1793')

  // ④ 题号缺失 → 不入队（不产生 null 垃圾事件）
  cloudMock.queue.length = 0
  Store1.reportPerQuestion(undefined, false, true)
  Store1.reportPerQuestion(null, true, false)
  Store1.reportPerQuestion('', false, true)
  assert('题号缺失（undefined/null/空串）一律不入队', perq().length === 0, '实际 ' + perq().length + ' 条')

  // ⑤ 全链路 addProgress（挑战错答自动转 ch 上报）
  cloudMock.queue.length = 0
  Store1.addProgress({ question_id: 'u1792', category_id: 12, dept: 'dining/yan', type: 'listen', correct: false, mode: 'practice', challenge: true })
  assert('addProgress（challenge + 答错）→ ch 上报且题号保留', perq().length === 1 && perq()[0].d.qid === 'u1792' && perq()[0].d.ch === 1, JSON.stringify(perq()))

  // ⑥ v75 语义未变：挑战答对不上报（chQ 省空间）
  cloudMock.queue.length = 0
  Store1.addProgress({ question_id: 'u1792', category_id: 12, dept: 'dining/yan', type: 'listen', correct: true, mode: 'practice', challenge: true })
  assert('挑战答对仍不上报（v75 省空间语义未变）', perq().length === 0, '实际 ' + perq().length + ' 条')

  // ⑦ 普通练习答错仍按 perQ 上报
  cloudMock.queue.length = 0
  Store1.addProgress({ question_id: 'u1799', category_id: 12, dept: 'dining/yan', type: 'listen', correct: false, mode: 'practice' })
  assert('普通练习答错按 perQ 上报（无 ch）', perq().length === 1 && !perq()[0].d.ch && perq()[0].d.qid === 'u1799')
}

// ============================================================
console.log('\n组三 云端聚合联动（真实 cloud-store _apply）')

{
  const CloudSync = loadCloudStore()
  const map = {}
  ;[
    { u: 'cloud', ty: 'register', d: { name: '姬小钰' } },
    { u: 'cloud', ty: 'perq', d: { qid: 'u1792', correct: 0, ch: 1 } },
    { u: 'cloud', ty: 'perq', d: { qid: 'u1792', correct: 0, ch: 1 } },
    { u: 'cloud', ty: 'perq', d: { qid: 'u1792', correct: 1, ch: 1 } },
    { u: 'cloud', ty: 'perq', d: { qid: 'u1793', correct: 0 } },
  ].forEach(ev => CloudSync._apply(map, ev))

  assert('字符串题号进 chQ：键 "u1792" 存在', !!(map.cloud.chQ && map.cloud.chQ['u1792']), JSON.stringify(map.cloud.chQ))
  assert('chQ["u1792"].total = 3（含挑战回顾答对 1 次，与旧行为一致）', map.cloud.chQ['u1792'].total === 3, JSON.stringify(map.cloud.chQ['u1792']))
  assert('chQ["u1792"].correct = 1', map.cloud.chQ['u1792'].correct === 1)
  assert('字符串题号进个人 perQ（答错）', !!(map.cloud.perQ && map.cloud.perQ['u1793'] && map.cloud.perQ['u1793'].total === 1))
  assert('全局 __q 也有该题（跨学员正确率）', !!(map.__q && map.__q['u1793']), JSON.stringify(map.__q))

  // 反证：修复前的畸形载荷（qid=null）确实被静默丢弃
  const map2 = {}
  ;[
    { u: 'cloud', ty: 'register', d: {} },
    { u: 'cloud', ty: 'perq', d: { qid: null, correct: 0, ch: 1 } },
  ].forEach(ev => CloudSync._apply(map2, ev))
  assert('★ 反证：qid=null 事件被云端丢弃（修复前的真实形态）', !map2.cloud.chQ && !Object.keys(map2.cloud.perQ || {}).length)

  // 数字/字符串两种线格式落到同一个键（存量数据不会被分裂）
  const map3 = {}
  ;[
    { u: 'a', ty: 'perq', d: { qid: 1792, correct: 1 } },
    { u: 'a', ty: 'perq', d: { qid: '1792', correct: 0 } },
  ].forEach(ev => CloudSync._apply(map3, ev))
  assert('数字 1792 与字符串 "1792" 落同一键（无分裂）', map3.__q['1792'] && map3.__q['1792'][1] === 2, JSON.stringify(map3.__q))
}

// ============================================================
console.log('\n组四 看板错题行端到端（cloud 聚合 → 错题表行）')

{
  const CloudSync = loadCloudStore()
  const map = {}
  ;[
    { u: 'cloud', ty: 'register', d: { name: '姬小钰' } },
    { u: 'cloud', ty: 'perq', d: { qid: 'u1792', correct: 0, ch: 1 } },
    { u: 'cloud', ty: 'perq', d: { qid: 'u1792', correct: 0, ch: 1 } },
    { u: 'cloud', ty: 'perq', d: { qid: 'u1795', correct: 0, ch: 1 } },
  ].forEach(ev => CloudSync._apply(map, ev))

  // 复刻 app.js 看板：跨学员合并 chQ → 只取题库里还存在的题 → 排序
  const questions = [
    { id: 'u1792', type: 'listen', question: 'All beverage consumption will be charged separately.' },
    { id: 'u1795', type: 'voicematch', question: '听力配对题' },
  ]
  const qMap = {}
  questions.forEach(q => { qMap[q.id] = q })
  const rows = [{ chQ: map.cloud.chQ }]
  const wrongAgg = {}
  rows.forEach(p => {
    Object.keys(p.chQ).forEach(qid => {
      const rec = p.chQ[qid]
      if (!rec) return
      const a = wrongAgg[qid] || (wrongAgg[qid] = { wrong: 0 })
      a.wrong += rec.total
    })
  })
  const wrongList = Object.keys(wrongAgg)
    .filter(qid => qMap[qid])
    .map(qid => ({ qid: qMap[qid].id, question: qMap[qid].question, wrong: wrongAgg[qid].wrong }))
    .sort((a, b) => b.wrong - a.wrong)

  assert('★ 错题排行非空（卡片会渲染）', wrongList.length === 2, JSON.stringify(wrongList))
  assert('行题号为真实字符串题号（不再是 NaN）', wrongList.every(x => typeof x.qid === 'string' && x.qid), JSON.stringify(wrongList.map(x => x.qid)))
  assert('错次按 total 累计（u1792 = 2）', wrongList.find(x => x.qid === 'u1792').wrong === 2)
  assert('排序：错次多的在前', wrongList[0].qid === 'u1792')
  assert('★ 反证：Number("u1792") 是 NaN（旧写法会渲染 #NaN）', Number.isNaN(Number('u1792')))
}

// ============================================================
console.log('\n组五 无回退护栏')

{
  const storeCode = codeOnly(STORE_SRC)
  assert('v75 省空间语义注释仍在（个人 perQ 只记错题）', codeOnly(STORE_SRC).includes('if (record.challenge)'))
  assert('reportPerQuestion 仍检查 session.username', storeCode.replace(/\s+/g, ' ').includes('if (!s || !s.username) return'))
  assert('reportPerQuestion 仍检查 CloudSync.enqueue', storeCode.replace(/\s+/g, ' ').includes("typeof CloudSync === 'undefined' || !CloudSync.enqueue"))
  assert('challenge 答对不上报的分支未被改坏', storeCode.replace(/\s+/g, ' ').includes('if (!record.correct) this.reportPerQuestion(record.question_id, false, true)'))
  assert('qidToWire 不做数字强转（红线注释在位）', STORE_SRC.includes('不做 Number 强转'))
  assert('看板错题表仍按 wrongAgg[qid].wrong 渲染', codeOnly(APP_SRC).includes('wrongAgg[qid].wrong'))
}

// ============================================================
console.log('\n组六 版本号')

{
  const vers = (HTML_SRC.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = [...new Set(vers)]
  assert('index.html 资源版本号出现 12 处且唯一', vers.length === 12 && uniq.length === 1, `出现 ${vers.length} 处，唯一值 ${uniq.join(',')}`)
  assert('index.html 资源版本号 = 157', uniq[0] === 157, String(uniq[0]))
  assert('index.html 无旧版本号残留', !/\?v=15[0-6]\b/.test(HTML_SRC))
}

done()
