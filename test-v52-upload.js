// ====== 测试 v52：管理员批量上传/手工新增题目（eq_uploaded 上传库，永久保留）======
// ① 新增题目入上传库（id 前缀 u），入库后 getQuestions/getQuestion 可见，difficulty 支持 L4(=4)
// ② 批量导入：新增计数、同 题型|题干 去重跳过、难度收敛到 1-4、字段默认值兜底
// ③ 线下课题库重建（rebuildBankFromCourse）不清除上传题（永久保留语义）
// ④ 更新/删除题目优先命中上传库；难度 4 的题可被按难度筛选到
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

const sandbox = {
  localStorage: {
    store: { 'eq_course_only_v43': '1' },   /* 派生库清理与本测试无关，预置 flag 跳过 */
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  window: {},
  document: { addEventListener() {} },
}
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

;(async () => {
  console.log('\n🧪 v52 上传题库（eq_uploaded 永久保留）测试')
  Store.init()

  // ---------- ① 单题新增 ----------
  console.log('\n[1] addQuestion → 上传库（id 前缀 u，difficulty 支持 4 / L4）')
  const baseCount = Store.getQuestions().length
  const q1 = Store.addQuestion({
    category_id: 1, dept: 'all', type: 'single', difficulty: 4,
    question: 'What does "VIP" stand for?', options: ['Very Important Person', 'A', 'B'], answer: [0],
    explanation: 'VIP = Very Important Person',
  })
  assert('新增题 id 带 u 前缀', typeof q1.id === 'string' && q1.id[0] === 'u', q1.id)
  assert('difficulty=4 保留（L4 支持）', q1.difficulty === 4)
  assert('getQuestions 可见（总题数 +1）', Store.getQuestions().length === baseCount + 1)
  assert('getQuestion(id) 可查回', Store.getQuestion(q1.id) && Store.getQuestion(q1.id).question.includes('VIP'))
  assert('原库（派生库 localStorage eq_questions）未被污染', JSON.parse(sandbox.localStorage.getItem('eq_questions')).length === baseCount)

  // ---------- ② 批量导入 ----------
  console.log('\n[2] batchImport：新增 / 去重 / 难度收敛 / 默认值')
  const r1 = Store.batchImport([
    { question: 'May I take your order?', options: ['A', 'B'], answer: [0] },                       // 难度缺失 → 1
    { difficulty: 9, question: 'Could you show me the menu?', options: ['A', 'B'], answer: [1] },    // 难度 9 → 收敛 4
    { difficulty: 0, question: 'A duplicate-ish question', options: ['A', 'B'], answer: [0] },       // 难度 0 → 1
    { question: 'What does "VIP" stand for?', options: ['A', 'B'], answer: [0] },                    // 与①重复 → 跳过
    { question: ' ', options: ['A'], answer: [0] },                                                  // 空白题干 → 静默忽略（不计 success/skipped）
  ])
  assert('新增 3 题', r1.success === 3, JSON.stringify(r1))
  assert('重复 1 题被跳过', r1.skipped === 1, JSON.stringify(r1))
  const after2 = Store.getQuestions().length
  assert('导入后总题数 +3', after2 === baseCount + 4, `base+4=${baseCount + 4} got ${after2}`)
  const imp = Store.getQuestions().filter(q => q.question === 'Could you show me the menu?')[0]
  assert('难度 9 → 收敛到 4', imp && imp.difficulty === 4)
  const impD0 = Store.getQuestions().filter(q => q.question === 'A duplicate-ish question')[0]
  assert('难度 0 → 兜底 1', impD0 && impD0.difficulty === 1)
  const impDef = Store.getQuestions().filter(q => q.question === 'May I take your order?')[0]
  assert('缺失字段兜底：type=single / category_id=1 / dept=all / explanation 空串', impDef && impDef.type === 'single' && impDef.category_id === 1 && impDef.dept === 'all' && impDef.explanation === '')
  const dup = Store.getQuestions().filter(q => q.question === 'What does "VIP" stand for?')
  assert('同 题干(不区分大小写) 不重复入库', dup.length === 1, `got ${dup.length}`)
  const r2 = Store.batchImport([{ question: 'What does "vip" stand for?', options: ['A'], answer: [0] }])
  assert('大小写不同的重复题干也跳过', r2.success === 0 && r2.skipped === 1, JSON.stringify(r2))

  // ---------- ③ 重建派生库不清上传库 ----------
  console.log('\n[3] rebuildBankFromCourse 整体替换派生库 → 上传题保留')
  const upBefore = Store.getQuestions().filter(q => String(q.id)[0] === 'u').length
  const clsDoc = { classes: [{ assignments: [{ type: 'homework', status: 'open', questions: [
    { type: 'single', question: 'Course derived A', options: ['a', 'b'], answer: [0] },
    { type: 'single', question: 'Course derived B', options: ['a', 'b'], answer: [1] },
  ] }] }] }
  const n = Store.rebuildBankFromCourse(clsDoc.classes)
  assert('派生库已重建（写入 2 题）', n === 2, `got ${n}`)
  const derivedNow = JSON.parse(sandbox.localStorage.getItem('eq_questions'))
  assert('派生库只剩作业题（2 条）', derivedNow.length === 2 && derivedNow.every(q => q.question.indexOf('Course derived') === 0))
  const upAfter = Store.getQuestions().filter(q => String(q.id)[0] === 'u')
  assert('上传题全部保留（数量不变）', upAfter.length === upBefore, `${upAfter.length} vs ${upBefore}`)
  assert('getQuestions 仍能查到上传题', Store.getQuestion(q1.id) !== null)
  const again = Store.rebuildBankFromCourse(clsDoc.classes)
  assert('作业无变化 → 二次重建返回 -1（指纹跳过）', again === -1, `got ${again}`)

  // ---------- ④ 更新/删除 + 难度筛选 ----------
  console.log('\n[4] updateQuestion / deleteQuestion / 难度 4 筛选')
  const upd = Store.updateQuestion(q1.id, { question: 'What does VIP stand for? (edited)', difficulty: 2 })
  assert('更新命中上传库并生效', upd && upd.question.indexOf('(edited)') >= 0 && upd.difficulty === 2)
  assert('getQuestion 返回更新后内容', Store.getQuestion(q1.id).question.indexOf('(edited)') >= 0)
  const dq = Store.deleteQuestion(q1.id)
  assert('删除上传题成功', dq === true && Store.getQuestion(q1.id) == null)
  const upQ = Store.getQuestions().filter(q => q.question === 'Could you show me the menu?')[0]
  assert('难度 4 的题仍在库（供水平测试 L4 抽取）', upQ && upQ.difficulty === 4)
  const qByDiff = Store.queryQuestions({ difficulty: 4 })
  assert('queryQuestions(difficulty=4) 可筛到上传 L4 题', qByDiff.total >= 1 && qByDiff.list.some(q => q.question === 'Could you show me the menu?'))
  const kw = Store.queryQuestions({ keyword: 'duplicate-ish' })
  assert('关键词可搜到上传题', kw.total >= 1 && kw.list[0].question === 'A duplicate-ish question')

  console.log(testFailed ? '\n===== v52 上传测试：存在失败 =====' : '\n===== v52 上传测试：全部通过 =====')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
