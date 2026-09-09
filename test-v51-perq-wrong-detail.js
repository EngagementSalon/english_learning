// ====== 测试 v51：逐题错题率（per-question wrong rate）=====
// ① courseWrongIdxOf：由会话题目（带 _oi）与 answers 生成按原题序的错题下标 wq；未答=错；越界防御→null；全对→[]
// ② courseBuildResultEntry / courseVideoQuizBuildEntry：记录带 wq/qn；作业低分重做时明细跟随保留的最高分那次
// ③ courseWrongDetailable / courseTaskWrongDetail：只统计带明细且题数一致的记录；无明细/题集已变 → null
// ④ courseWrongDetailModal：有明细 → 逐题题干 + 错题率徽标；无明细 → 提示文案
// ⑤ i18n 双语键 + 行按钮 / 看板汇总格源码接线
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
    placeholder: '', value: '', readOnly: false, id: '',
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
    _created: [],
    localStorage: {
      store: lsStore,
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { const el = mkEl(); el.click = () => { sandbox._clicked = el }; sandbox._created.push(el); return el },
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

function source(p) { return fs.readFileSync(path.join(__dirname, p), 'utf-8') }

async function main() {
  // ---------- ① courseWrongIdxOf ----------
  console.log('\n[1] courseWrongIdxOf 逐题错题下标')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        // 模拟 shuffle 后会话：q._oi 指向原 assignment 下标，与 q 在数组中的位置无关
        const qz = {
          questions: [
            { _oi: 2, type: 'multiple', options: ['a', 'b', 'c'], answer: [0, 1] },
            { _oi: 0, type: 'single', options: ['x', 'y'], answer: [1] },
            { _oi: 1, type: 'fill', options: ['apple'] },
          ],
          answers: [[0], 0, 'Apple'],
        }
        const qzAllRight = {
          questions: [{ _oi: 0, type: 'single', options: ['x', 'y'], answer: [1] }, { _oi: 1, type: 'judge', options: ['T', 'F'], answer: [0] }],
          answers: [1, 0],
        }
        const qzUnanswered = {
          questions: [{ _oi: 0, type: 'single', options: ['x', 'y'], answer: [1] }],
          answers: [],
        }
        const qzOob = {
          questions: [{ _oi: 9, type: 'single', options: ['x', 'y'], answer: [1] }, { _oi: 1, type: 'single', options: ['x', 'y'], answer: [0] }],
          answers: [1, 0],
        }
        const qzNoOoi = {
          questions: [{ type: 'single', options: ['x', 'y'], answer: [1] }, { type: 'single', options: ['x', 'y'], answer: [1] }],
          answers: [0, 1],  // 无 _oi 时退回数组位置
        }
        return {
          a: courseWrongIdxOf(qz, 3),
          all: courseWrongIdxOf(qzAllRight, 2),
          un: courseWrongIdxOf(qzUnanswered, 1),
          oob: courseWrongIdxOf(qzOob, 2),
          nooi: courseWrongIdxOf(qzNoOoi, 2),
          empty: courseWrongIdxOf({ questions: [], answers: [] }, 0),
        }
      })()
    `, sb)
    assert('第0题错(multiple只选一半)、第2题错(fill答错) → wq=[0,2] 升序', r.a && r.a.qn === 3 && JSON.stringify(r.a.wq) === '[0,2]', JSON.stringify(r.a))
    assert('全对 → wq=[] 保留（有意义明细）', r.all && r.all.qn === 2 && JSON.stringify(r.all.wq) === '[]', JSON.stringify(r.all))
    assert('未答视为错 → wq=[0]', r.un && JSON.stringify(r.un.wq) === '[0]', JSON.stringify(r.un))
    assert('_oi 越界（作答期间题目被改）→ null 放弃明细', r.oob === null, JSON.stringify(r.oob))
    assert('无 _oi 时退回数组位置 → wq=[0]', r.nooi && JSON.stringify(r.nooi.wq) === '[0]', JSON.stringify(r.nooi))
    assert('空卷 → {wq:[], qn:0}', r.empty && r.empty.qn === 0, JSON.stringify(r.empty))
  }

  // ---------- ② 成绩条目存取明细 ----------
  console.log('\n[2] courseBuildResultEntry / courseVideoQuizBuildEntry 带 wq/qn')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        const a = { type: 'homework', deadline: 0 }
        const w = { wq: [1, 4], qn: 10 }
        const e1 = courseBuildResultEntry(a, null, 80, 8, 10, 100, 1000, w)
        // 低分重做：prev 高分且带明细 → 明细跟随 prev
        const prevH = { score: 90, correct: 9, total: 10, wq: [2], qn: 10, attempts: 1 }
        const e2 = courseBuildResultEntry(a, prevH, 70, 7, 10, 50, 2000, { wq: [0, 1, 3], qn: 10 })
        // prev 高分但无明细（旧版记录）→ 本次低分明细被丢弃
        const e3 = courseBuildResultEntry(a, { score: 90, correct: 9, total: 10, attempts: 1 }, 60, 6, 10, 50, 3000, { wq: [5], qn: 10 })
        // 本次更高分 → 明细取本次
        const e4 = courseBuildResultEntry(a, { score: 50, correct: 5, total: 10, wq: [1], qn: 10, attempts: 1 }, 90, 9, 10, 50, 4000, { wq: [3], qn: 10 })
        // wrong=null（明细生成失败）→ 无 wq 字段
        const e5 = courseBuildResultEntry(a, null, 80, 8, 10, 50, 5000, null)
        // 视频小测
        const va = { type: 'video', quiz: [1, 2] }
        const v1 = courseVideoQuizBuildEntry(va, null, { watchedPct: 92 }, 9, 10, 6000, { wq: [7], qn: 10 })
        // 视频重答且本次明细失败 → 旧明细清除防错位
        const vPrev = { watchedPct: 95, quizTotal: 10, quizCorrect: 8, wq: [2], qn: 10, quizAt: 100 }
        const v2 = courseVideoQuizBuildEntry(va, vPrev, { watchedPct: 96 }, 10, 10, 7000, null)
        return { e1, e2, e3, e4, e5, v1, v2 }
      })()
    `, sb)
    assert('作业带明细：e1.wq=[1,4] qn=10', r.e1 && JSON.stringify(r.e1.wq) === '[1,4]' && r.e1.qn === 10, JSON.stringify(r.e1))
    assert('低分重做 → 分数取 prev(90)，明细跟随 prev.wq=[2]', r.e2 && r.e2.score === 90 && JSON.stringify(r.e2.wq) === '[2]', JSON.stringify(r.e2))
    assert('prev 无明细 → 本次低分明细被丢弃（无 wq 键）', r.e3 && r.e3.score === 90 && !('wq' in r.e3) && !('qn' in r.e3), JSON.stringify(r.e3))
    assert('本次更高分 → 明细取本次 wq=[3]', r.e4 && r.e4.score === 90 && JSON.stringify(r.e4.wq) === '[3]', JSON.stringify(r.e4))
    assert('wrong=null → 无 wq/qn', r.e5 && !('wq' in r.e5) && !('qn' in r.e5), JSON.stringify(r.e5))
    assert('视频小测带明细 → wq=[7] qn=10', r.v1 && JSON.stringify(r.v1.wq) === '[7]' && r.v1.qn === 10, JSON.stringify(r.v1))
    assert('视频重答明细失败 → 清除 prev 旧明细', r.v2 && !('wq' in r.v2) && !('qn' in r.v2) && r.v2.quizTotal === 10, JSON.stringify(r.v2))
  }

  // ---------- ③ 逐题聚合 ----------
  console.log('\n[3] courseWrongDetailable / courseTaskWrongDetail 聚合')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        const hw = { type: 'homework', questions: [{}, {}, {}], results: {
          u1: { correct: 3, total: 3, wq: [], qn: 3 },
          u2: { correct: 1, total: 3, wq: [0, 2], qn: 3 },
          u3: { correct: 3, total: 3 },               // 老记录无明细 → 跳过
          u4: { correct: 1, total: 3, wq: [0], qn: 2 },  // qn 与当前题数 3 不符（题集变过）→ 跳过
        } }
        const vq = { type: 'video', quiz: [{}, {}, {}], results: {
          s1: { quizTotal: 3, quizCorrect: 3, wq: [], qn: 3 },
          s2: { quizTotal: 3, quizCorrect: 2, wq: [2], qn: 3 },
          s3: { quizTotal: 3, quizCorrect: 1, wq: [1], qn: 3 },
        } }
        const onlyOld = { type: 'homework', questions: [{}, {}], results: { u1: { correct: 2, total: 2 } } }
        const noData = { type: 'homework', questions: [{}, {}], results: {} }
        const changed = { type: 'homework', questions: [{}, {}, {}, {}], results: { u1: { correct: 3, total: 4, wq: [1], qn: 3 } } }
        return {
          hw: courseTaskWrongDetail(hw),
          vq: courseTaskWrongDetail(vq),
          onlyOld: courseTaskWrongDetail(onlyOld),
          noData: courseTaskWrongDetail(noData),
          changed: courseTaskWrongDetail(changed),
          det: {
            hwOk: courseWrongDetailable(hw),
            vqOk: courseWrongDetailable(vq),
            vidNoQuiz: courseWrongDetailable({ type: 'video', results: {} }),
            vidQuizEmpty: courseWrongDetailable({ type: 'video', quiz: [], results: {} }),
            offline: courseWrongDetailable({ type: 'offline' }),
            emptyQ: courseWrongDetailable({ type: 'homework', questions: [] }),
          },
        }
      })()
    `, sb)
    assert('作业逐题：u1全对+u2错0/2 → q0 错1/2=50%, q1 0%, q2 50%；n=2', r.hw && r.hw.n === 2 && r.hw.per[0].wrong === 1 && r.hw.per[0].ans === 2 && r.hw.per[0].rate === 50 && r.hw.per[1].wrong === 0 && r.hw.per[1].rate === 0 && r.hw.per[2].wrong === 1, JSON.stringify(r.hw))
    assert('视频小测：s2错第2题、s3错第1题 → q1 错1/3=33%, q2 错1/3=33%, q0 0%；n=3', r.vq && r.vq.n === 3 && r.vq.per[0].wrong === 0 && r.vq.per[1].wrong === 1 && r.vq.per[1].rate === 33 && r.vq.per[2].wrong === 1 && r.vq.per[2].rate === 33, JSON.stringify(r.vq))
    assert('全是老记录（无 wq）→ null', r.onlyOld === null, JSON.stringify(r.onlyOld))
    assert('无人作答 → null', r.noData === null, JSON.stringify(r.noData))
    assert('作答后题集由 3 变 4 → 明细错位跳过 → null', r.changed === null, JSON.stringify(r.changed))
    assert('作业/视频小测可看；无小测视频 / 线下课 / 空题 → false', r.det.hwOk === true && r.det.vqOk === true && r.det.vidNoQuiz === false && r.det.vidQuizEmpty === false && r.det.offline === false && r.det.emptyQ === false, JSON.stringify(r.det))
  }

  // ---------- ④ 弹窗渲染 ----------
  console.log('\n[4] courseWrongDetailModal 弹窗（有/无明细）')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        const classes = [{
          id: 'c1', members: [], assignments: [{
            id: 'a1', type: 'homework', title: '餐具英语作业',
            questions: [
              { type: 'single', question: 'What is a spoon used for?', options: ['eat', 'sleep'], answer: [0] },
              { type: 'single', question: 'How do you say 杯子 in English?', options: ['cup', 'plate'], answer: [0] },
            ],
            results: {
              u1: { score: 50, correct: 1, total: 2, wq: [1], qn: 2 },
              u2: { score: 100, correct: 2, total: 2, wq: [], qn: 2 },
            },
          }],
        }]
        courseState.doc = { classes }
        courseWrongDetailModal('c1', 'a1')
        const m1 = _created[_created.length - 1]
        const old = [{
          id: 'c2', members: [], assignments: [{
            id: 'a2', type: 'homework', title: '旧作业', questions: [{ type: 'single', question: 'x', options: ['a', 'b'], answer: [0] }],
            results: { u1: { score: 80, correct: 1, total: 1 } },   // 无 wq
          }],
        }]
        courseState.doc = { classes: old }
        courseWrongDetailModal('c2', 'a2')
        const m2 = _created[_created.length - 1]
        return { m1: m1.innerHTML, m2: m2.innerHTML }
      })()
    `, sb)
    assert('有明细：弹窗含每题题干', r.m1.indexOf('What is a spoon used for?') >= 0 && r.m1.indexOf('杯子') >= 0, '')
    assert('有明细：第1题含题号 #2 与 50% 错题率', r.m1.indexOf('#1') >= 0 && r.m1.indexOf('#2') >= 0 && r.m1.indexOf('50%') >= 0, '')
    assert('有明细：作答统计 答错 1 题 · 作答 2 人', r.m1.indexOf('答错 1 题') >= 0 && r.m1.indexOf('作答 2 人') >= 0, '')
    assert('无明细：弹窗提示暂无逐题明细文案', r.m2.indexOf('暂无逐题') >= 0 && r.m2.indexOf('旧作业') >= 0, '')
  }

  // ---------- ⑤ i18n / 源码接线 ----------
  console.log('\n[5] i18n 双语 + 入口接线')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        const zh = t('courseWrongDetailTitle') + '|' + t('courseWrongRateLbl') + '|' + t('courseWrongDetailStat', 3, 8) + '|' + t('courseWrongDetailHead', 5)
        setLang('en')
        const en = t('courseWrongDetailTitle') + '|' + t('courseWrongRateBtn') + '|' + t('courseWrongDetailStat', 3, 8) + '|' + t('courseWrongDetailHead', 1)
        return { zh, en }
      })()
    `, sb)
    assert('中文键：逐题错题率 / 错 / 答错3题·作答8人 / 统计5份', r.zh === '逐题错题率|错|答错 3 题 · 作答 8 人|统计 5 份含逐题明细的作答', r.zh)
    assert('英文键：Per-Question Wrong Rate / Wrong / 3 wrong · 8 answered', r.en === 'Per-Question Wrong Rate|Wrong|3 wrong · 8 answered|From 1 detailed submission', r.en)

    const src = source('course-app.js')
    assert('任务行渲染含 📊 错题率按钮（onclick courseWrongDetailModal）', src.includes("📊 ${t('courseWrongRateBtn')}") && src.includes("courseWrongDetailModal('${escAttr(c.id)}','${escAttr(a.id)}')"), '')
    assert('看板汇总行可点击链接 dash-wr-link + onclick', src.indexOf('dash-wr-link') >= 0 && src.indexOf('courseWrongDetailModal') > src.indexOf('courseTaskWrongDetail'), '')
    assert('作业/视频小测会话题目带 _oi 标注', (source('course-app.js').match(/_oi: (i|q\._oi)/g) || []).length >= 3, '')
  }

  console.log(failed ? '\n===== v51 测试：存在失败 =====' : '\n===== v51 测试：全部通过 =====')
  process.exit(failed ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
