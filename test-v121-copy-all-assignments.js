// test-v121-copy-all-assignments.js — v121 一键复制全部作业到已有班级
// ① i18n 6 键 zh/en 成对且全部被 course-app.js 调用
// ② 接线：admin-toolbar 按钮真挂进 courseRenderClass 模板（顺序：新增线下课 → 复制全部 → 新建作业）
// ③ 行为（沙箱真跑 courseCopyAllAssignmentsModal / Do）：
//    - 含 offline（date=0 / held=false / heldAt=0 / absent 删除 / 主题字段照搬）——与单条复制最大差异
//    - examOpened / courseFinalOpened 剥离（放行名单不带走），examGate 开关照常复制
//    - results={} / 新 id / createdAt；草稿保持草稿；已发布 sentAt；过期 deadline 清空
//    - 目标班 members 不动、源班不变、幂等守卫、alert 汇总、rebuildBankFromCourse
// ④ 反向：单条复制仍排除 offline（v121 契约：单条复制维持现状，用户确认 2026-09-29）
// ⑤ 版本弹性：唯一 ?v=N ×12 且 ≥121

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const APP = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

let failed = 0
function assert(name, cond, extra) {
  if (cond) { console.log('✓ ' + name) }
  else { failed++; console.log('✗ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}

function extractFn(src, name) {
  // 兼容 async 前缀（v115 教训）；词边界防前缀误命中
  const re = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) throw new Error('fn not found: ' + name)
  const start = m.index + m[1].length
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// ---------- ① i18n ----------
const KEYS = ['courseCopyAllBtn', 'courseCopyAllTitle', 'courseCopyAllNone', 'courseCopyAllSummary', 'courseCopyAllHint', 'courseCopyAllOk']
KEYS.forEach(k => {
  const n = (I18N.match(new RegExp('(^|[\\s{,])' + k + '\\s*:', 'g')) || []).length
  assert('i18n 键 ' + k + ' zh/en 成对（恰 2 处）', n === 2, '实得 ' + n)
})
assert('zh 文案存在（按钮/标题）', I18N.includes("courseCopyAllBtn: '复制全部作业'") && I18N.includes("courseCopyAllTitle: '复制全部作业到其他班级'"))
assert('en 文案存在（按钮/标题）', I18N.includes("courseCopyAllBtn: 'Copy All Assignments'") && I18N.includes("courseCopyAllTitle: 'Copy all assignments to another class'"))
KEYS.forEach(k => {
  const n = (APP.match(new RegExp("t\\('" + k + "'", 'g')) || []).length
  assert('键 ' + k + ' 被 course-app.js 真调用', n >= 1, '实得 ' + n)
})

// ---------- ② 接线（源码级：函数存在 + 被模板真调用）----------
assert('courseCopyAllAssignmentsModal 已定义', APP.includes('async function courseCopyAllAssignmentsModal(cid)'))
assert('courseCopyAllAssignmentsDo 已定义', APP.includes('async function courseCopyAllAssignmentsDo(cid)'))
assert('admin-toolbar 有复制全部作业按钮（escAttr(c.id) 形态）', APP.includes("onclick=\"courseCopyAllAssignmentsModal('${escAttr(c.id)}')\""))
const iT = APP.indexOf("onclick=\"courseCreateOfflineModal('${escAttr(c.id)}')\"")
const iC = APP.indexOf("onclick=\"courseCopyAllAssignmentsModal('${escAttr(c.id)}')\"")
const iN = APP.indexOf("onclick=\"courseCreateAssignModal('${escAttr(c.id)}')\"")
assert('按钮顺序：新增线下课 → 复制全部作业 → 新建作业', iT >= 0 && iT < iC && iC < iN, [iT, iC, iN].join(','))
assert('弹窗确认按钮接线 courseCopyAllAssignmentsDo', APP.includes("onclick=\"courseCopyAllAssignmentsDo('${escAttr(cid)}')\""))

// ---------- ③ 沙箱行为 ----------
function mkSandbox(state) {
  const calls = { alert: [], modal: [], mutate: [], rebuild: [], rendered: 0, closed: 0 }
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Promise, Date,
    alert: (...a) => calls.alert.push(a),
    escAttr: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    t: (k, ...a) => a.length ? k + ':' + a.join(',') : k,
    document: { getElementById: id => (id === 'ccAllTarget') ? { value: state.tid } : null },
    courseModalOpen: (title, body, footer) => calls.modal.push({ title, body, footer }),
    courseModalClose: () => { calls.closed++ },
    courseRenderClass: () => { calls.rendered++ },
    Store: { rebuildBankFromCourse: classes => calls.rebuild.push(classes) },
    courseFind: id => ((state.doc.classes) || []).find(c => c.id === id),
    CourseStore: {
      _seq: 0,
      newId: () => 'a_test_' + (++sb.CourseStore._seq),
      async getDoc() { return state.doc },
      async mutate(fn) { calls.mutate.push(fn); return fn(state.doc) },
      findClass: (doc, id) => ((doc && doc.classes) || []).find(c => c.id === id),
    },
    courseState: { doc: null },
  }
  sb.courseState.doc = state.doc
  return { sb, calls }
}

function mkState() {
  const now = Date.now()
  const doc = { classes: [
    {
      id: 'c1', name: 'A班', members: ['s1', 's2'],
      assignments: [
        { id: 'a1', type: 'homework', title: '练习一', status: 'draft', questions: [1, 2], results: { s1: { score: 90 } } },
        { id: 'a2', type: 'exam', title: '期中测评', examGate: true, examOpened: { s1: { at: 1, by: 'admin' } }, deadline: now - 86400000, questions: [3], results: { s2: { score: 60 } } },
        { id: 'a3', type: 'coursefinal', title: '期末考试', courseFinalOpened: { s2: { at: 2, by: 'admin' } }, questions: [4], results: {} },
        { id: 'a4', type: 'video', title: '视频课', videoUrl: 'http://x', quiz: [5], results: {} },
        { id: 'a5', type: 'offline', title: '线下课·餐饮礼仪', topicId: 't1', custom: '', desc: 'd', date: now + 86400000, createdAt: 1, createdBy: 'admin', held: true, heldAt: now - 1000, absent: ['s2'], results: { s1: { attended: true } } },
      ],
    },
    { id: 'c2', name: 'B班', members: ['s9'], assignments: [] },
  ] }
  return { doc, now, tid: 'c2' }
}

;(async () => {
  // —— 主体行为：一键复制 A 班 5 项任务到 B 班 ——
  const st = mkState()
  const { sb, calls } = mkSandbox(st)
  vm.createContext(sb)
  vm.runInContext(extractFn(APP, 'courseCopyAllAssignmentsModal'), sb)
  vm.runInContext(extractFn(APP, 'courseCopyAllAssignmentsDo'), sb)

  await vm.runInContext("courseCopyAllAssignmentsDo('c1')", sb)
  const src = st.doc.classes[0]
  const tgt = st.doc.classes[1]
  const byTitle = {}
  tgt.assignments.forEach(a => { byTitle[a.title] = a })
  const origIds = ['a1', 'a2', 'a3', 'a4', 'a5']

  assert('B 班收到全部 5 项任务（含 offline）', tgt.assignments.length === 5, '实得 ' + tgt.assignments.length)
  assert('新 id 全部生成且唯一、不与原 id 相同', tgt.assignments.every(a => /^a_test_\d+$/.test(a.id)) &&
    new Set(tgt.assignments.map(a => a.id)).size === 5 && tgt.assignments.every(a => origIds.indexOf(a.id) < 0))
  assert('createdAt 刷新为复制时刻', tgt.assignments.every(a => a.createdAt >= st.now))

  const hw = byTitle['练习一']
  assert('草稿 → 保持草稿（status 保留、无 sentAt）', hw && hw.status === 'draft' && hw.sentAt === undefined && hw.questions.length === 2)

  const ex = byTitle['期中测评']
  assert('exam：examGate 开关照常复制', ex && ex.examGate === true)
  assert('exam：放行名单 examOpened 不带走（★ 名单隔离）', ex && ex.examOpened === undefined)
  assert('exam：原截止时间已过 → 清空为 0', ex && ex.deadline === 0)
  assert('exam：已发布 → 复制即发布（sentAt）', ex && typeof ex.sentAt === 'number')

  const fin = byTitle['期末考试']
  assert('coursefinal：放行名单 courseFinalOpened 不带走', fin && fin.courseFinalOpened === undefined)
  assert('coursefinal：题目数组照常复制', fin && fin.questions.length === 1)

  const vid = byTitle['视频课']
  assert('video：链接与课后小测照常复制 + sentAt', vid && vid.videoUrl === 'http://x' && vid.quiz.length === 1 && typeof vid.sentAt === 'number')

  const off = byTitle['线下课·餐饮礼仪']
  assert('offline：date 清空为 0（用户决策：上课时间清空）', off && off.date === 0)
  assert('offline：held=false / heldAt=0（回到未上过课）', off && off.held === false && off.heldAt === 0)
  assert('offline：考勤名单 absent 不带走', off && off.absent === undefined)
  assert('offline：主题字段照搬（topicId/custom/desc/title）', off && off.topicId === 't1' && off.custom === '' && off.desc === 'd' && off.title === '线下课·餐饮礼仪')

  assert('全部克隆 results={}（成绩不复制）', tgt.assignments.every(a => a.results && Object.keys(a.results).length === 0))
  assert('目标班 members 不动（★ 不带学员）', JSON.stringify(tgt.members) === JSON.stringify(['s9']))
  assert('源班完全不变（5 条、id 原样、名单与考勤保留）', src.assignments.length === 5 &&
    JSON.stringify(src.assignments.map(a => a.id).sort()) === JSON.stringify(origIds) &&
    src.assignments[1].examOpened && src.assignments[1].examOpened.s1 &&
    src.assignments[4].held === true && src.assignments[4].date > st.now)
  assert('alert 汇总 courseCopyAllOk(5, B班)', calls.alert.length === 1 && calls.alert[0][0] === 'courseCopyAllOk:5,B班', JSON.stringify(calls.alert))
  assert('rebuildBankFromCourse 已调用', calls.rebuild.length === 1 && calls.rebuild[0] === st.doc.classes)
  assert('复制后刷新班级视图 + 关弹窗', calls.rendered === 1 && calls.closed === 1)

  // —— 幂等：同一 mutate 回调重放（部分失败重试）不得追加重复 ——
  const fnMut = calls.mutate[0]
  const r2 = fnMut(st.doc)
  assert('幂等：目标班已含新 id 时回调返回 false', r2 === false)
  assert('幂等：未追加重复任务（仍 5 条）', tgt.assignments.length === 5)

  // —— 弹窗：正常路径 ——
  const stM = mkState()
  const { sb: sbM, calls: callsM } = mkSandbox(stM)
  vm.createContext(sbM)
  vm.runInContext(extractFn(APP, 'courseCopyAllAssignmentsModal'), sbM)
  await vm.runInContext("courseCopyAllAssignmentsModal('c1')", sbM)
  assert('弹窗打开 1 次', callsM.modal.length === 1)
  const m = callsM.modal[0]
  assert('弹窗标题键 courseCopyAllTitle', m.title === 'courseCopyAllTitle')
  assert('弹窗含目标班级下拉 ccAllTarget', m.body.indexOf('id="ccAllTarget"') >= 0)
  assert('弹窗摘要带任务数与线下课数（5 项 / 含 1）', m.body.indexOf('courseCopyAllSummary:5,1') >= 0)
  assert('弹窗含目标班选项、不含自身', m.body.indexOf('value="c2"') >= 0 && m.body.indexOf('value="c1"') < 0)
  assert('弹窗含说明 courseCopyAllHint（成绩/放行名单不复制、线下课清日期、成员不变）', m.body.indexOf('courseCopyAllHint') >= 0)
  assert('确认按钮带源班 id', m.footer.indexOf("courseCopyAllAssignmentsDo('c1')") >= 0)

  // —— 弹窗：无其他班级 ——
  const stN = { doc: { classes: [mkState().doc.classes[0]] }, tid: '', now: Date.now() }
  const { sb: sbN, calls: callsN } = mkSandbox(stN)
  vm.createContext(sbN)
  vm.runInContext(extractFn(APP, 'courseCopyAllAssignmentsModal'), sbN)
  await vm.runInContext("courseCopyAllAssignmentsModal('c1')", sbN)
  assert('无其他班级 → 提示 courseCopyNoClass、不开弹窗', callsN.alert.length === 1 && callsN.alert[0][0] === 'courseCopyNoClass' && callsN.modal.length === 0)

  // —— 弹窗：源班没有作业 ——
  const stE = mkState()
  stE.doc.classes[0].assignments = []
  const { sb: sbE, calls: callsE } = mkSandbox(stE)
  vm.createContext(sbE)
  vm.runInContext(extractFn(APP, 'courseCopyAllAssignmentsModal'), sbE)
  await vm.runInContext("courseCopyAllAssignmentsModal('c1')", sbE)
  assert('源班无作业 → 提示 courseCopyAllNone、不开弹窗', callsE.alert.length === 1 && callsE.alert[0][0] === 'courseCopyAllNone' && callsE.modal.length === 0)

  // —— Do：未选目标班 → 静默返回 ——
  const stT = mkState()
  stT.tid = ''
  const { sb: sbT, calls: callsT } = mkSandbox(stT)
  vm.createContext(sbT)
  vm.runInContext(extractFn(APP, 'courseCopyAllAssignmentsDo'), sbT)
  await vm.runInContext("courseCopyAllAssignmentsDo('c1')", sbT)
  assert('未选目标班 → 不写不弹（静默返回）', callsT.alert.length === 0 && callsT.mutate.length === 0)

  // ---------- ④ 反向：单条复制维持现状（v121 契约）----------
  const cmBody = extractFn(APP, 'courseCopyAssignModal')
  const cdBody = extractFn(APP, 'courseCopyAssignDo')
  assert('单条复制 modal 仍排除 offline（v121 维持现状）', cmBody.indexOf("a.type === 'offline') return") >= 0)
  assert('单条复制 Do 仍排除 offline', cdBody.indexOf("a.type === 'offline'") >= 0)
  assert('offline 重置逻辑只在「复制全部」里（单条复制不含 date 清空）', cdBody.indexOf('clone.date = 0') < 0 &&
    extractFn(APP, 'courseCopyAllAssignmentsDo').indexOf('clone.date = 0') >= 0)

  // ---------- ⑤ 版本弹性 ----------
  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
  assert('版本号 >= 121', uniq.length === 1 && uniq[0] >= 121)

  console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.log('✗ FATAL ' + (e && e.stack || e)); process.exit(1) })
