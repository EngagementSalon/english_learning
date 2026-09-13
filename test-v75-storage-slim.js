// ====== 测试 v75：perQ 瘦身（只记错题）+ 全局 __q 正确率 + 存储用量指示条 ======
// ① _apply perq 新语义：__q[qid]=[correct,total] 全局聚合；个人 perQ 只记错题；ch 挑战错答照旧
// ② rename 合并：瘦身后 perQ（错题）正确合并；__q 不受 rename 影响
// ③ fetchSyncSummary/getDashboardData：__ 键不进用户名单；_lastQStats/_lastDocBytes 侧信道缓存
// ④ renderPerQBlock：__q 数据源渲染正确率/整体正确率；旧 perQ 补充 __q 缺失的题（防双算）
// ⑤ dashStorageBarHtml：无数据不渲染；有数据渲染进度条（<70% 绿 / 70-90% 黄 / ≥90% 红）
// ⑥ i18n dashStore* zh/en 成对
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
let n = 0
function assert(name, cond, msg) {
  n++
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}

// 仅加载 cloud-store.js 的沙箱（fetch mock 可注入云端文档）
function loadCloudStore(doc) {
  const sb = {
    console,
    localStorage: { store: {}, getItem(k) { return this.store[k] || null }, setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
    setInterval() { return 0 }, clearInterval() {},
    setTimeout() { return 0 }, clearTimeout() {},
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(doc) }),
    AbortController,
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb)
  return { sb, CloudSync: vm.runInContext('CloudSync', sb) }
}

// 整载沙箱（i18n/bank-data/store/cloud-store/app）——渲染层测试用
function makeFullSandbox() {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const sb = {
    console,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/120' },
    localStorage: { store: {}, getItem(k) { return this.store[k] || null }, setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => mkEl(),
      body: { appendChild() {} },
      title: '',
      addEventListener() {}, removeEventListener() {},
      visibilityState: 'visible',
    },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {} },
    alert() {}, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], base: {} }) }),
    AbortController,
    _getEl: getEl,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sb)
  return sb
}

;(async () => {
  console.log('\n🧪 v75 存储瘦身测试（perQ 只记错题 + __q 全局正确率 + 存储指示条）')

  // ---------- ① _apply 新语义 ----------
  console.log('\n[1] _apply perq：__q 全局聚合 + 个人只记错题')
  {
    const { CloudSync } = loadCloudStore({ v: 1, base: {}, events: [] })
    const map = {}
    ;[
      { u: 'a', ty: 'register', ts: 1, d: { name: 'A' } },
      { u: 'a', ty: 'perq', ts: 2, d: { qid: 100, correct: 1 } },
      { u: 'a', ty: 'perq', ts: 3, d: { qid: 100, correct: 0 } },
      { u: 'a', ty: 'perq', ts: 4, d: { qid: 200, correct: 0 } },
      { u: 'a', ty: 'perq', ts: 5, d: { qid: 200, correct: 0 } },
      { u: 'b', ty: 'perq', ts: 6, d: { qid: 100, correct: 1 } },
      { u: 'b', ty: 'perq', ts: 7, d: { qid: 100, correct: 1 } },
      { u: 'b', ty: 'perq', ts: 8, d: { qid: 100, correct: 0 } },
      { u: 'b', ty: 'perq', ts: 9, d: { qid: 300, correct: 1, ch: 1 } },   // 挑战错答？ch=1 且 correct=1（挑战回顾答对）→ 进 chQ
    ].forEach(ev => CloudSync._apply(map, ev))
    assert('__q[100] = [3, 5]（a 1对1错 + b 2对1错）', map.__q['100'][0] === 3 && map.__q['100'][1] === 5, JSON.stringify(map.__q['100']))
    assert('__q[200] = [0, 2]', map.__q['200'][0] === 0 && map.__q['200'][1] === 2)
    assert('__q[300] 不存在（ch 事件不进全局正确率）', !map.__q['300'])
    assert('a 的 perQ 只有错题：100 错 1 次 + 200 错 2 次', map.a.perQ['100'].correct === 0 && map.a.perQ['100'].total === 1 && map.a.perQ['200'].total === 2, JSON.stringify(map.a.perQ))
    assert('b 答对的 300（ch）不进 perQ，进 chQ', !map.b.perQ['300'] && map.b.chQ['300'].total === 1)
    assert('个人体积 = O(错题数)：a.perQ 仅 2 键', Object.keys(map.a.perQ).length === 2)
  }

  // ---------- ② rename 合并 ----------
  console.log('\n[2] rename 合并：错题明细随迁、__q 不受影响')
  {
    const { CloudSync } = loadCloudStore({ v: 1, base: {}, events: [] })
    const map = {}
    ;[
      { u: 'alice', ty: 'register', ts: 1, d: { name: 'Alice' } },
      { u: 'alice', ty: 'perq', ts: 2, d: { qid: 5, correct: 0 } },
      { u: 'alice', ty: 'perq', ts: 3, d: { qid: 5, correct: 0 } },
      { u: 'carol', ty: 'register', ts: 4, d: { name: 'Carol' } },
      { u: 'carol', ty: 'perq', ts: 5, d: { qid: 5, correct: 0 } },
      { u: 'alice', ty: 'rename', ts: 6, n: 'Carol', d: { nu: 'carol' } },
    ].forEach(ev => CloudSync._apply(map, ev))
    assert('carol 合并错题：perQ[5].total = 3（2+1）', map.carol.perQ['5'].total === 3 && map.carol.perQ['5'].correct === 0, JSON.stringify(map.carol.perQ))
    assert('__q[5] = [0, 3] 不受 rename 影响', map.__q['5'][0] === 0 && map.__q['5'][1] === 3)
    assert('旧用户名记录已删除', !map.alice)
  }

  // ---------- ③ fetchSyncSummary / getDashboardData 侧信道 ----------
  console.log('\n[3] 名单过滤 __q + _lastQStats/_lastDocBytes 缓存')
  {
    const doc = {
      v: 1,
      base: {
        alice: { username: 'alice', name: 'Alice', loginSec: 60, perQ: { '5': { correct: 0, total: 1 } } },
        __q: { '5': [2, 4] },
      },
      events: [
        { id: 'e1', u: 'bob', n: 'Bob', ty: 'register', ts: 10, d: { name: 'Bob' } },
        { id: 'e2', u: 'bob', ty: 'perq', ts: 11, d: { qid: '5', correct: 1 } },
      ],
    }
    const { sb, CloudSync } = loadCloudStore(doc)
    const rows = await CloudSync.getDashboardData()
    assert('rows 只含真实用户（__q 不混入）', rows.length === 2 && rows.every(r => r.username && r.username !== '__q'), JSON.stringify(rows.map(r => r.username)))
    assert('_lastQStats = base.__q + events 重放（[3, 5]）', CloudSync._lastQStats['5'][0] === 3 && CloudSync._lastQStats['5'][1] === 5, JSON.stringify(CloudSync._lastQStats))
    assert('_lastDocBytes = 云端文档字节数', CloudSync._lastDocBytes === JSON.stringify(doc).length)
    const sum = await CloudSync.fetchSyncSummary()
    assert('fetchSyncSummary.map 同样过滤 __q 且保留聚合', sum.ok && Object.keys(sum.map).filter(k => k.charAt(0) !== '_').length === 2 && sum.map.__q['5'][1] === 5)
    assert('sandbox 内未污染 localStorage 用户表', !sb.localStorage.getItem('eq_users'))
  }

  // ---------- ④ renderPerQBlock 渲染 ----------
  console.log('\n[4] 每题正确率看板（__q 数据源 + 旧 perQ 补充）')
  {
    const sb = makeFullSandbox()
    vm.runInContext(`
      CloudSync._lastQStats = { '8001': [8, 10], '8002': [2, 10] }
      CloudSync._lastDocBytes = 0
      // 旧数据（未迁移的完整 perQ）：__q 没有的题 8003 由 perQ 补充
      window.__rows = [{ username: 'old', perQ: { '8003': { correct: 5, total: 10 } } }]
    `, sb)
    vm.runInContext('renderPerQBlock(window.__rows)', sb)
    const html = vm.runInContext('document.getElementById("perQBlock").innerHTML', sb)
    assert('渲染 3 道有记录的题（8001/8002/8003）', html.includes('#8001') && html.includes('#8002') && html.includes('#8003'))
    assert('8001 正确率 80% / 8002 正确率 20%', html.includes('80%') && html.includes('20%'))
    assert('8003 由旧 perQ 补充：5/10 → 50%', html.includes('#8003') && html.includes('50%'))
    assert('整体正确率 50%（20 对 / 40 答）', html.includes('50%'))
    assert('__q 与 perQ 不双算（8001 total=10 非 11）', !html.includes('11</td>'))
  }

  // ---------- ⑤ dashStorageBarHtml ----------
  console.log('\n[5] 存储用量指示条')
  {
    const sb = makeFullSandbox()
    vm.runInContext('CloudSync._lastDocBytes = 0', sb)
    assert('无数据（0 字节）不渲染', vm.runInContext('dashStorageBarHtml()', sb) === '')
    const html13 = vm.runInContext('CloudSync._lastDocBytes = 137626; dashStorageBarHtml()', sb)
    assert('正常占用渲染 134 KB / 1 MB · 13%', html13.includes('134 KB / 1 MB · 13%') && html13.includes('#16a34a'), html13.slice(0, 200))
    const html75 = vm.runInContext('CloudSync._lastDocBytes = 786432; dashStorageBarHtml()', sb)
    assert('75% 转琥珀色', html75.includes('75%') && html75.includes('#d97706'))
    const html93 = vm.runInContext('CloudSync._lastDocBytes = 975175; dashStorageBarHtml()', sb)
    assert('93% 转红色告警', html93.includes('93%') && html93.includes('#dc2626'))
    assert('标题接 i18n dashStoreTitle', html13.includes('云端存储用量') || html13.includes('Cloud storage usage'))
    // 看板整体渲染不报错（admin 判定外的渲染函数直接调用）
    vm.runInContext('dashStorageBarHtml()', sb)
  }

  // ---------- ⑥ i18n ----------
  console.log('\n[6] i18n 双语')
  {
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    ;['dashStoreTitle', 'dashStoreHint'].forEach(k => {
      const cnt = (i18nSrc.match(new RegExp(k + ':', 'g')) || []).length
      assert(`i18n ${k} zh/en 成对（恰好 2 处）`, cnt === 2, 'count=' + cnt)
    })
    assert('中文文案正确', i18nSrc.includes("dashStoreTitle: '云端存储用量'") && i18nSrc.includes('上限 1 MB'))
    assert('英文文案正确', i18nSrc.includes("dashStoreTitle: 'Cloud storage usage'") && i18nSrc.includes('1 MB cap'))
  }

  console.log('\n' + n + ' assertions, ' + (testFailed ? '❌ FAILED' : '✅ ALL PASS'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
