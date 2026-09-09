// ====== 测试 v50：成绩看板每个任务显示全班错题率（作业/测评/视频小测） ======
// ① courseTaskWrongRate 纯函数：作业/测评按学员最终记录 correct/total；视频配小测按已答学员 quiz；
//    线下课/无小测视频/无人作答/无 correct 老记录 → null
// ② renderCourseDashboard 表格底部 tfoot 汇总行：每列 ✗ rate% + 小字 wrong/total，配色 ≤20 绿/≤40 黄/>40 红
// ③ courseWrongRateText（Excel 汇总行）与 courseExportExcel rows 接线
// ④ i18n courseDashWrongRate 双语 + 源码接线
// ⑤ style.css：tfoot 分隔线 + tfoot 首格随学员列 sticky
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {},
  }
}

function makeSandbox() {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = {}
  const sandbox = {
    console,
    localStorage: {
      store: lsStore,
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { const el = mkEl(); el.click = () => { sandbox._clicked = el }; return el },
      body: { appendChild() {} }, title: '',
      hidden: false,
      addEventListener() {}, removeEventListener() {},
      visibilityState: 'visible',
    },
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {},
      speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] },
      SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() },
    },
    alert(m) { sandbox._lastAlert = String(m) }, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder, Uint8Array, DataView, Int32Array, Buffer,
    Blob: class { constructor(parts) { this.parts = parts } },
    URL: { createObjectURL: b => b, revokeObjectURL() {} },
    fetch: async () => { throw new Error('network down') },
    AbortController,
    CloudSync: { status: 'online', onStatus() {}, enqueue() {}, addDuration() {}, flushDuration() {}, pushPending: async () => {} },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('course-store.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  return sandbox
}

async function main() {
  // ---------- ① courseTaskWrongRate 纯函数 ----------
  console.log('\n[1] courseTaskWrongRate 纯函数')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        const hw = { type: 'homework', results: {
          u1: { correct: 8, total: 10 }, u2: { correct: 5, total: 10 }, u3: { correct: 9, total: 10 }
        } }
        const hwRetake = { type: 'homework', results: {
          u1: { correct: 9, total: 10, attempts: 3 }, u2: { correct: 10, total: 10, attempts: 2 }
        } }
        const ex = { type: 'exam', results: { u1: { correct: 2, total: 10 }, u2: { correct: 3, total: 5 } } }
        const vq = { type: 'video', quiz: [1, 2], results: {
          a: { quizCorrect: 9, quizTotal: 10 }, b: { quizCorrect: 6, quizTotal: 10 }, c: { watchedPct: 100 }
        } }
        const vn = { type: 'video', results: { a: { watchedPct: 95 }, b: { watchedPct: 100 } } }
        const vnQuizEmpty = { type: 'video', quiz: [], results: { a: { quizCorrect: 3, quizTotal: 5 } } }
        const off = { type: 'offline', results: { a: { done: true } } }
        const oldNoCorrect = { type: 'homework', results: { u1: { score: 80 } } }
        const empty = { type: 'homework', results: {} }
        const perfect = { type: 'homework', results: { u1: { correct: 10, total: 10 }, u2: { correct: 10, total: 10 } } }
        return {
          hw: courseTaskWrongRate(hw),
          retake: courseTaskWrongRate(hwRetake),
          ex: courseTaskWrongRate(ex),
          vq: courseTaskWrongRate(vq),
          vn: courseTaskWrongRate(vn),
          vqEmpty: courseTaskWrongRate(vnQuizEmpty),
          off: courseTaskWrongRate(off),
          old: courseTaskWrongRate(oldNoCorrect),
          empty: courseTaskWrongRate(empty),
          perfect: courseTaskWrongRate(perfect),
        }
      })()
    `, sb)
    assert('作业 8/30 错 → {wrong:8, total:30, rate:27, n:3}', r.hw && r.hw.wrong === 8 && r.hw.total === 30 && r.hw.rate === 27 && r.hw.n === 3, JSON.stringify(r.hw))
    assert('作业重做多次按最终记录计（不重复分母）', r.retake && r.retake.wrong === 1 && r.retake.total === 20 && r.retake.n === 2, JSON.stringify(r.retake))
    assert('测评 2/10 + 3/5 → wrong 10 total 15 rate 67', r.ex && r.ex.wrong === 10 && r.ex.total === 15 && r.ex.rate === 67, JSON.stringify(r.ex))
    assert('视频小测：已答 a9/10 b6/10 → wrong5 total20 rate25 n2（c 未答不计）', r.vq && r.vq.wrong === 5 && r.vq.total === 20 && r.vq.rate === 25 && r.vq.n === 2, JSON.stringify(r.vq))
    assert('无小测视频（仅观看记录）→ null', r.vn === null, JSON.stringify(r.vn))
    assert('视频 quiz 为空数组 → null', r.vqEmpty === null, JSON.stringify(r.vqEmpty))
    assert('线下课 → null', r.off === null, JSON.stringify(r.off))
    assert('老记录无 correct/total → null', r.old === null, JSON.stringify(r.old))
    assert('无人作答 → null', r.empty === null, JSON.stringify(r.empty))
    assert('全对 → wrong0 total20 rate0', r.perfect && r.perfect.wrong === 0 && r.perfect.rate === 0, JSON.stringify(r.perfect))
  }

  // ---------- ①b 配色阈值 ----------
  console.log('\n[1b] courseWrongRateCls 阈值')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => [0, 20, 21, 40, 41, 100].map(v => courseWrongRateCls(v)))()
    `, sb)
    assert('0 → good', r[0] === 'good')
    assert('20 → good（≤20 绿）', r[1] === 'good', r[1])
    assert('21 → ok', r[2] === 'ok', r[2])
    assert('40 → ok', r[3] === 'ok', r[3])
    assert('41 → bad', r[4] === 'bad', r[4])
    assert('100 → bad', r[5] === 'bad', r[5])
  }

  // ---------- ② 看板 tfoot 汇总行 ----------
  console.log('\n[2] renderCourseDashboard 底部错题率汇总行')
  {
    const sb = makeSandbox()
    vm.runInContext(`
      courseState.doc = { v: 1, classes: [ { id: 'c1', name: '餐饮班', members: ['u1', 'u2', 'u3', 'u4'], assignments: [
        { id: 'hw', type: 'homework', title: '餐具作业', results: {
          u1: { correct: 8, total: 10, score: 80 }, u2: { correct: 5, total: 10, score: 50 }, u3: { correct: 9, total: 10, score: 90 }
        } },
        { id: 'vq', type: 'video', title: '礼仪视频小测', quiz: [1], results: {
          u1: { watchedPct: 100, quizCorrect: 9, quizTotal: 10 }, u2: { watchedPct: 100, quizCorrect: 6, quizTotal: 10 }, u3: { watchedPct: 100 }
        } },
        { id: 'vn', type: 'video', title: '纯观看', results: { u4: { watchedPct: 95 } } },
        { id: 'off', type: 'offline', title: '线下课', results: { u4: { done: true } } },
        { id: 'pf', type: 'homework', title: '满分作业', results: { u1: { correct: 10, total: 10, score: 100 }, u2: { correct: 10, total: 10, score: 100 } } },
        { id: 'bd', type: 'homework', title: '惨败作业', results: { u1: { correct: 1, total: 10, score: 10 } } }
      ] } ] }
    `, sb)
    await vm.runInContext('renderCourseDashboard()', sb)
    const html = sb.document.getElementById('page-course').innerHTML
    assert('表格含 tfoot 汇总行', html.includes('<tfoot>'))
    assert('汇总行标签：✗ 全班错题率', html.includes('dash-lbl-cell">✗ 全班错题率'))
    assert('作业 8/30 → ✗ 27% + 小字 8/30（ok 黄）', html.includes('dash-cell ok">✗ 27%<span') && html.includes(' 8/30</span>'), html.slice(0, 4000))
    assert('视频小测 5/20 → ✗ 25% + 5/20', html.includes('✗ 25%') && html.includes(' 5/20</span>'))
    assert('无小测视频 → —', (html.match(/dash-cell">—<\/td>/g) || []).length >= 1)
    assert('线下课 → —', (html.match(/dash-cell">—<\/td>/g) || []).length >= 2)
    assert('满分作业 → ✗ 0%（good 绿）', html.includes('dash-cell good">✗ 0%<span') && html.includes(' 0/20</span>'))
    assert('高错题率 90% → bad 红', html.includes('dash-cell bad">✗ 90%<span'))
    assert('学员个人行不受影响：u1 80分、u2 50分仍显示', html.includes('80分') && html.includes('50分'))
  }

  // ---------- ③ Excel 汇总 helper ----------
  console.log('\n[3] courseWrongRateText 与 Excel 接线')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        return {
          hw: courseWrongRateText({ type: 'homework', results: { u1: { correct: 8, total: 10 }, u2: { correct: 5, total: 10 }, u3: { correct: 9, total: 10 } } }),
          none: courseWrongRateText({ type: 'video', results: { u1: { watchedPct: 95 } } }),
          perfect: courseWrongRateText({ type: 'homework', results: { u1: { correct: 10, total: 10 } } }),
        }
      })()
    `, sb)
    assert('作业 → ✗ 27% (8/30)', r.hw === '✗ 27% (8/30)', r.hw)
    assert('无作答 → —', r.none === '—', r.none)
    assert('全对 → ✗ 0% (0/10)', r.perfect === '✗ 0% (0/10)', r.perfect)
    const app = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
    assert('Excel rows 末尾追加汇总行', /rows\.push\(\[`✗ \$\{t\('courseDashWrongRate'\)\}`\]\.concat\(assigns\.map\(a => courseWrongRateText\(a\)\)\)/.test(app))
  }

  // ---------- ④ i18n / 源码接线 ----------
  console.log('\n[4] i18n 与源码接线')
  {
    const sb = makeSandbox()
    const I18N = vm.runInContext('I18N', sb)
    assert('zh.courseDashWrongRate=全班错题率', I18N.zh.courseDashWrongRate === '全班错题率')
    assert('en.courseDashWrongRate 存在', !!(I18N.en && I18N.en.courseDashWrongRate))
    const app = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
    assert('courseTaskWrongRate 已定义', app.includes('function courseTaskWrongRate('))
    assert('courseWrongRateText 已定义', app.includes('function courseWrongRateText('))
    assert('看板含 tfoot 渲染', app.includes('<tfoot>'))
    assert('看板汇总行引用 i18n', app.includes("t('courseDashWrongRate')"))
  }

  // ---------- ⑤ style.css：汇总行样式 + sticky ----------
  console.log('\n[5] style.css 汇总行样式')
  {
    const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf-8')
    assert('tfoot td 有顶部粗分隔线', /\.dash-table tfoot td\s*{[^}]*border-top:\s*2px solid var\(--border\)/.test(css))
    assert('汇总行字号 12px', /\.dash-table tfoot td\s*{[^}]*font-size:\s*12px/.test(css))
    assert('标签格样式 dash-lbl-cell', css.includes('.dash-table tfoot td.dash-lbl-cell'))
    assert('tfoot 首格随学员列 sticky（含 td:first-child）', css.includes('.dash-table tfoot td:first-child'))
  }

  console.log(failed ? '\n存在失败用例 ✗' : '\n全部通过 ✓')
  process.exit(failed ? 1 : 0)
}

main().catch(e => { console.error('测试执行异常：', e); process.exit(1) })
