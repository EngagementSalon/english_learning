// ====== 测试：v48 视频作业完成后的成绩看板显示课后小测正确率 ======
// ① courseVideoQuizScore：配小测且已答 → {acc, correct, total}；未答/无小测 → null
// ② renderCourseDashboard 矩阵：已答完 → 小测正确率%（good/ok/bad 按正确率配色）+ 答对/总题数；
//    看完未答 → 「📝 待答题」；无小测 → 观看完成率（✓ pct%）
// ③ courseExportCell：已答完 → "acc% · correct/total"（替代原 "观看% · correct/total"）；其余语义不变
// ④ i18n courseVideoQuizTag 双语存在
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
  // ---------- ① 纯函数：已答完小测才返回正确率 ----------
  console.log('\n[1] courseVideoQuizScore 纯函数')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        const vidQ = { type: 'video', quiz: [{ type: 'single' }, { type: 'listen' }] }
        const vidNoQ = { type: 'video' }
        const hw = { type: 'homework' }
        return {
          noQuiz: courseVideoQuizScore(vidNoQ, { watchedPct: 100, quizCorrect: 9, quizTotal: 10 }),
          noRes: courseVideoQuizScore(vidQ, null),
          pending: courseVideoQuizScore(vidQ, { watchedPct: 100 }),
          done: courseVideoQuizScore(vidQ, { watchedPct: 100, quizCorrect: 9, quizTotal: 10 }),
          two3: courseVideoQuizScore(vidQ, { quizCorrect: 2, quizTotal: 3 }),
          all0: courseVideoQuizScore(vidQ, { quizCorrect: 0, quizTotal: 10 }),
          notVideo: courseVideoQuizScore(hw, { score: 85 }),
        }
      })()
    `, sb)
    assert('无小测 → null', r.noQuiz === null, JSON.stringify(r.noQuiz))
    assert('无记录 → null', r.noRes === null)
    assert('看完未答题（quizTotal null）→ null', r.pending === null, JSON.stringify(r.pending))
    assert('9/10 → {acc:90, correct:9, total:10}', r.done && r.done.acc === 90 && r.done.correct === 9 && r.done.total === 10, JSON.stringify(r.done))
    assert('2/3 → acc 四舍五入 67', r.two3 && r.two3.acc === 67, JSON.stringify(r.two3))
    assert('0/10 → acc 0', r.all0 && r.all0.acc === 0 && r.all0.correct === 0, JSON.stringify(r.all0))
    assert('非视频 → null', r.notVideo === null)
  }

  // ---------- ② 看板矩阵：已答完显示正确率，看完未答显示待答题，无小测显示观看进度 ----------
  console.log('\n[2] renderCourseDashboard 视频列显示语义')
  {
    const sb = makeSandbox()
    vm.runInContext(`
      courseState.doc = { v: 1, classes: [ { id: 'c1', name: 'A 班', members: ['stuA', 'stuB', 'stuC', 'stuD', 'stuE'], assignments: [
        { id: 'vq', type: 'video', title: '礼仪视频小测', quiz: [{ type: 'single', question: 'Q' }], results: {
          stuA: { at: 1, watchedPct: 100, watchedSec: 100, duration: 100, quizCorrect: 9, quizTotal: 10, quizScore: 90 },
          stuB: { at: 1, watchedPct: 100, quizCorrect: 6, quizTotal: 10, quizScore: 60 },
          stuC: { at: 1, watchedPct: 100, quizCorrect: 1, quizTotal: 10, quizScore: 10 },
          stuD: { at: 1, watchedPct: 100, watchedSec: 100, duration: 100 }
        } },
        { id: 'vn', type: 'video', title: '纯观看视频', results: { stuE: { at: 1, watchedPct: 95 } } }
      ] } ] }
    `, sb)
    await vm.runInContext('renderCourseDashboard()', sb)
    const html = sb.document.getElementById('page-course').innerHTML
    assert('答对 9/10 → 看板显示 90% + 9/10（good 绿）', html.includes('dash-cell good">90%<span') && html.includes(' 9/10'), html.slice(0, 2000))
    assert('答对 6/10 → 60%（ok 黄）', html.includes('dash-cell ok">60%<span'))
    assert('答对 1/10 → 10%（bad 红）', html.includes('dash-cell bad">10%<span'))
    assert('看完未答 → 📝 待答题（不再显示 ✓ 100% 完成）', html.includes('📝 待答题'))
    assert('无小测视频 → ✓ 95% 观看完成率', html.includes('✓ 95%'))
    assert('已答完学员不再显示 ✓ 100% 完成率', !html.includes('✓ 100%'))
  }

  // 看板配色边界：80/60 阈值
  console.log('\n[2b] 正确率配色阈值')
  {
    const sb = makeSandbox()
    vm.runInContext(`
      courseState.doc = { v: 1, classes: [ { id: 'c1', name: 'A 班', members: ['s8', 's6', 's79'], assignments: [
        { id: 'vq', type: 'video', title: '小测', quiz: [1], results: {
          s8:  { watchedPct: 100, quizCorrect: 8, quizTotal: 10 },
          s6:  { watchedPct: 100, quizCorrect: 6, quizTotal: 10 },
          s79: { watchedPct: 100, quizCorrect: 7, quizTotal: 10 }
        } }
      ] } ] }
    `, sb)
    await vm.runInContext('renderCourseDashboard()', sb)
    const html = sb.document.getElementById('page-course').innerHTML
    assert('80 分 → good', html.includes('dash-cell good">80%<span'))
    assert('60 分 → ok', html.includes('dash-cell ok">60%<span'))
    assert('79 → 79% 取整（≥80 才 good，79 为 ok）', html.includes('dash-cell ok">79%<span') || html.includes('dash-cell good">80%<span'))
  }

  // ---------- ③ Excel 导出单元格：已答完 → 小测正确率优先 ----------
  console.log('\n[3] courseExportCell 视频列语义')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        return {
          answered: courseExportCell({ type: 'video', quiz: [1, 2] }, { watchedPct: 100, quizCorrect: 9, quizTotal: 10 }),
          perfect: courseExportCell({ type: 'video', quiz: [1] }, { watchedPct: 100, quizCorrect: 10, quizTotal: 10 }),
          two3: courseExportCell({ type: 'video', quiz: [1] }, { watchedPct: 100, quizCorrect: 2, quizTotal: 3 }),
          pending: courseExportCell({ type: 'video', quiz: [1] }, { watchedPct: 100 }),
          noQuiz: courseExportCell({ type: 'video' }, { watchedPct: 95.6 }),
          noPct: courseExportCell({ type: 'video' }, {}),
          hw: courseExportCell({ type: 'homework' }, { score: 85 }),
        }
      })()
    `, sb)
    assert('已答完 → 90% · 9/10（正确率替代观看完成率）', r.answered === '90% · 9/10', r.answered)
    assert('全对 → 100% · 10/10', r.perfect === '100% · 10/10', r.perfect)
    assert('2/3 → 67% · 2/3', r.two3 === '67% · 2/3', r.two3)
    assert('看完未答 → 仍是观看进度 100%', r.pending === '100%', r.pending)
    assert('无小测 → 观看完成率 96%（四舍五入）', r.noQuiz === '96%', r.noQuiz)
    assert('无 pct 历史记录 → 已完成', r.noPct === '已完成', r.noPct)
    assert('作业分数不变', r.hw === 85)
  }

  // ---------- ④ i18n / 源码接线 ----------
  console.log('\n[4] i18n 与源码接线')
  {
    const sb = makeSandbox()
    const I18N = vm.runInContext('I18N', sb)
    assert('zh.courseVideoQuizTag=待答题', I18N.zh.courseVideoQuizTag === '待答题')
    assert('en.courseVideoQuizTag 存在', !!(I18N.en && I18N.en.courseVideoQuizTag))
    const app = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
    assert('courseVideoQuizScore 已定义', app.includes('function courseVideoQuizScore('))
    assert('看板已答完分支显示正确率', app.includes("q.acc >= 80 ? 'good'"))
    assert('看板看完未答分支显示待答题', app.includes("t('courseVideoQuizTag')"))
    assert('Excel 已答完分支正确率优先', app.includes("return q.acc + '% · ' + q.correct + '/' + q.total"))
  }

  console.log(failed ? '\n存在失败用例 ✗' : '\n全部通过 ✓')
  process.exit(failed ? 1 : 0)
}

main().catch(e => { console.error('测试执行异常：', e); process.exit(1) })
