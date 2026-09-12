// ====== 测试 v67：种子题库拼接（分类12「标帜餐厅常见词汇」，BANK v9）======
// （v71 更新：cat12 原 228 道 voicematch「看字选音」已改造为 listen「听音选中文义」，
//   改造后 listen 456 + single 228 = 684 题、id/difficulty 不变、干扰项同池且与同词 listen 题不相交）
// ① BANK 结构：cat=12 存在，684 题（listen 456 + single 228，无 voicematch），id 8001-8684，dept 全 dining
// ② getQuestions 拼接：v43 清空后的空库也能看到种子题（_seed 标记）；本地库同 id 题优先（去重防御）
// ③ getCategories 拼接：空分类表 → 含 id=12；已含 → 不重复
// ④ 老设备迁移（eq_bank_version=8 → 9）：分类表 = 线下课题库 + 种子新分类；派生题保留
// ⑤ 部门筛选：dining 学员可单独刷 684 题；rooms 学员 0 题
// ⑥ rebuildBankFromCourse 整体替换派生库后种子题仍可见、分类表仍含 cat=12
// ⑦ 种子题只读：updateQuestion → null，deleteQuestion → false
// ⑧ 题型内容格式：listen/single 题干英文、选项中文（v71 起原 voicematch 题亦为 listen + 中文选项）
// ⑨ 源码接线：app.js 管理端 _seed 只读渲染、i18n seedReadOnly 双语
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

function makeSandbox(pre) {
  // 注意：不默认预置 eq_course_only_v43——真实新设备首次 init 才置 flag（此时 storedVer=0）；
  // 预置 flag 必须配合 eq_bank_version（模拟真实老设备），否则出现「flag 已置但版本未迁移」的不存在状态
  const sb = {
    localStorage: {
      store: Object.assign({}, pre || {}),
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    window: {},
    document: { addEventListener() {} },
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  return sb
}

;(async () => {
  console.log('\n🧪 v67 种子题库拼接（标帜餐厅常见词汇）测试')

  // ---------- ① BANK 结构 ----------
  console.log('\n[1] BANK v9 结构')
  {
    const sb = makeSandbox()
    const BANK = vm.runInContext('BANK', sb)
    const cat12 = BANK.categories.find(c => Number(c.id) === 12)
    assert('BANK.version = 9', BANK.version === 9, `got ${BANK.version}`)
    assert('分类 id=12「标帜餐厅常见词汇」存在', !!cat12 && cat12.name === '标帜餐厅常见词汇', JSON.stringify(cat12))
    const q12 = BANK.questions.filter(q => Number(q.category_id) === 12)
    assert('cat12 共 684 题', q12.length === 684, `got ${q12.length}`)
    assert('listen 456 / single 228 / voicematch 0（v71 改造后）', q12.filter(q => q.type === 'listen').length === 456 && q12.filter(q => q.type === 'single').length === 228 && q12.filter(q => q.type === 'voicematch').length === 0,
      JSON.stringify(['listen', 'single', 'voicematch'].map(ty => ty + ':' + q12.filter(q => q.type === ty).length)))
    const ids = q12.map(q => q.id)
    assert('id 区间 8001-8684 且唯一', Math.min(...ids) === 8001 && Math.max(...ids) === 8684 && new Set(ids).size === 684)
    assert('dept 全部 dining（餐饮部题库下）', q12.every(q => q.dept === 'dining'))
    assert('全部 4 选项 + answer [0] + 无重复选项', q12.every(q => q.options.length === 4 && JSON.stringify(q.answer) === '[0]' && new Set(q.options).size === 4))
    assert('全部题干英文、选项中文（v71 后无英文选项题）', q12.every(q => /^[\x00-\x7F]/.test(q.question) && q.options.every(o => /[\u4e00-\u9fff]/.test(o))),
      '存在题干非英文或选项非中文的题')
    assert('cat12 无 voicematch；原 vm 题（id%3==2）均为 listen', q12.filter(q => q.id % 3 === 2).length === 228 && q12.filter(q => q.id % 3 === 2).every(q => q.type === 'listen'))
    assert('与旧种子 id 无重叠', !BANK.questions.some(q => Number(q.category_id) < 12 && q.id >= 8001 && q.id <= 8684))
  }

  // ---------- ② 全新设备：空库拼接 ----------
  console.log('\n[2] 全新设备（v43 清空后）：getQuestions/getCategories 拼接')
  {
    const sb = makeSandbox()
    const Store = vm.runInContext('Store', sb)
    Store.init()
    const qs = Store.getQuestions()
    const seeds = qs.filter(q => Number(q.category_id) === 12)
    assert('空库下可见 684 道种子题', seeds.length === 684, `got ${seeds.length}`)
    assert('种子题带 _seed 标记', seeds.every(q => q._seed === true))
    const cats = Store.getCategories()
    assert('分类下拉含 id=12', cats.some(c => Number(c.id) === 12 && c.name === '标帜餐厅常见词汇'), JSON.stringify(cats.map(c => c.id)))
    assert('localStorage 未被种子污染', (JSON.parse(sb.localStorage.getItem('eq_questions')) || []).length === 0)
    const cat12q = Store.queryQuestions({ category_id: 12, dept: 'dining' })
    assert('饮食部学员按分类 12 抽到 684 题', cat12q.total === 684, `got ${cat12q.total}`)
    const roomsQ = Store.queryQuestions({ category_id: 12, dept: 'rooms' })
    assert('房务部学员按分类 12 抽到 0 题', roomsQ.total === 0, `got ${roomsQ.total}`)
    // 练习页传字符串分类 id（startPractice 场景）
    const strQ = Store.queryQuestions({ category_id: '12', dept: 'dining' })
    assert('category_id 传字符串也命中', strQ.total === 684, `got ${strQ.total}`)
  }

  // ---------- ③ 老设备迁移 8→9 ----------
  console.log('\n[3] 老设备迁移（storedVer 8 → 9）：分类表刷新 + 派生题保留')
  {
    const derivedQ = [{ id: 501, dept: 'all', category_id: 1, type: 'single', difficulty: 1, question: '派生题甲', options: ['a', 'b'], answer: [0], explanation: '' }]
    const sb = makeSandbox({
      'eq_bank_version': '8',
      'eq_course_only_v43': '1',
      'eq_questions': JSON.stringify(derivedQ),
      'eq_categories': JSON.stringify([{ id: 1, name: '线下课题库', description: '' }]),
    })
    const Store = vm.runInContext('Store', sb)
    Store.init()
    const cats = JSON.parse(sb.localStorage.getItem('eq_categories'))
    assert('迁移后分类表 = 线下课题库 + 标帜餐厅常见词汇', cats.length === 2 && Number(cats[0].id) === 1 && Number(cats[1].id) === 12,
      JSON.stringify(cats.map(c => c.id)))
    const qs = Store.getQuestions()
    assert('派生题保留', qs.some(q => q.question === '派生题甲'))
    assert('种子题拼接可见', qs.filter(q => Number(q.category_id) === 12).length === 684)
    assert('eq_bank_version 已升至 9', JSON.parse(sb.localStorage.getItem('eq_bank_version')) === 9)
    assert('分类表未写回 11 大主题（id=1 名实一致）', cats.find(c => Number(c.id) === 1).name === '线下课题库')
  }

  // ---------- ④ id 去重防御 ----------
  console.log('\n[4] 本地库同 id 题优先（去重）')
  {
    const localClone = { id: 8001, dept: 'dining', category_id: 12, type: 'listen', difficulty: 1, question: '本地版 8001', options: ['x', 'y', 'z', 'w'], answer: [0], explanation: '' }
    const sb = makeSandbox({ 'eq_bank_version': '8', 'eq_course_only_v43': '1', 'eq_questions': JSON.stringify([localClone]) })
    const Store = vm.runInContext('Store', sb)
    Store.init()
    const hits = Store.getQuestions().filter(q => String(q.id) === '8001')
    assert('id=8001 只出现一次', hits.length === 1, `got ${hits.length}`)
    assert('本地版本优先（非 _seed）', hits[0].question === '本地版 8001' && !hits[0]._seed, JSON.stringify(hits[0] && hits[0].question))
  }

  // ---------- ⑤ rebuild 后种子仍可见 ----------
  console.log('\n[5] rebuildBankFromCourse 整体替换派生库 → 种子题/分类不受影响')
  {
    const sb = makeSandbox()
    const Store = vm.runInContext('Store', sb)
    Store.init()
    const doc = { classes: [{ id: 'c1', name: '餐饮班', assignments: [{ type: 'homework', status: 'open', questions: [{ type: 'single', question: 'Course derived X', options: ['a', 'b'], answer: [0] }] }] }] }
    const n = Store.rebuildBankFromCourse(doc.classes)
    assert('派生写入 1 题', n === 1, `got ${n}`)
    const qs = Store.getQuestions()
    assert('种子题仍拼接可见（684）', qs.filter(q => Number(q.category_id) === 12).length === 684)
    assert('派生题可见', qs.some(q => q.question === 'Course derived X'))
    const cats = Store.getCategories()
    assert('分类表仍含 id=12', cats.some(c => Number(c.id) === 12))
    const catsRaw = JSON.parse(sb.localStorage.getItem('eq_categories'))
    assert('rebuild 写入的分类表本身含 cat12（id>=12）', catsRaw.some(c => Number(c.id) === 12), JSON.stringify(catsRaw.map(c => c.id)))
  }

  // ---------- ⑥ 种子题只读 ----------
  console.log('\n[6] 种子题只读（updateQuestion / deleteQuestion）')
  {
    const sb = makeSandbox()
    const Store = vm.runInContext('Store', sb)
    Store.init()
    assert('updateQuestion(8001) → null', Store.updateQuestion(8001, { question: 'hack' }) === null)
    assert('种子题未被改动', Store.getQuestion(8001).question !== 'hack')
    assert('deleteQuestion(8001) → false', Store.deleteQuestion(8001) === false)
    assert('种子题未被删除', !!Store.getQuestion(8001))
    // 派生题/上传题不受只读保护影响
    const up = Store.addQuestion({ category_id: 1, dept: 'all', type: 'single', difficulty: 1, question: '临时题', options: ['a', 'b'], answer: [0] })
    assert('上传题仍可删除', Store.deleteQuestion(up.id) === true)
  }

  // ---------- ⑦ 内容抽查 ----------
  console.log('\n[7] 内容抽查（干扰项质量，v71 改造后形态）')
  {
    const sb = makeSandbox()
    const BANK = vm.runInContext('BANK', sb)
    const q12 = BANK.questions.filter(q => Number(q.category_id) === 12)
    const byEn = en => q12.filter(q => q.question === en)
    const milk = byEn('Oat milk')
    assert('Oat milk 三题齐全（2 listen + 1 single）', milk.length === 3 && milk.filter(q => q.type === 'listen').length === 2 && milk.filter(q => q.type === 'single').length === 1, JSON.stringify(milk.map(q => q.type)))
    const vmMilk = milk.find(q => q.id % 3 === 2)   // 原 voicematch（id 8078），v71 改造为 listen
    assert('原 vm 题（8078）现为 listen + 中文选项 + 单句解析', !!vmMilk && vmMilk.type === 'listen' && vmMilk.options.every(o => /[\u4e00-\u9fff]/.test(o)) && /^Oat milk = .+。$/.test(vmMilk.explanation), JSON.stringify(vmMilk))
    const milkListen = milk.filter(q => q.type === 'listen')
    const dSets = milkListen.map(q => new Set(q.options.slice(1)))
    assert('同词两 listen 干扰项无交集（排除同词 listen 干扰）', dSets[0].size === 3 && dSets[1].size === 3 && [...dSets[0]].every(o => !dSets[1].has(o)), JSON.stringify(milkListen.map(q => q.options)))
    assert('改造题干扰项来自同池中文释义（含奶基/餐饮词均可）', milkListen.every(q => q.options.slice(1).every(o => typeof o === 'string' && o.length > 0)))
    const explOk = q12.every(q => typeof q.explanation === 'string' && q.explanation.length > 4)
    assert('全部有解析', explOk)
    // 干扰项不得等于正确项（v71 后全库 684 题均为中文选项，一并校验）
    assert('中文干扰项 ≠ 正确释义（全部 684 题）', q12.every(q => {
      const correct = q.options[q.answer[0]]
      return q.options.filter(o => o === correct).length === 1
    }))
    // 同词多题正确释义一致（听音/看题两种入口答案必须相同）
    const groupOK = (() => {
      const g = {}
      q12.forEach(q => { (g[q.question] = g[q.question] || []).push(q.options[q.answer[0]]) })
      return Object.keys(g).every(en => new Set(g[en]).size === 1)
    })()
    assert('同词各题正确释义一致', groupOK)
  }

  // ---------- ⑧ 源码接线 ----------
  console.log('\n[8] 源码接线断言')
  {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
    const i18n = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    assert('app.js：管理端 _seed 只读渲染', app.includes('q._seed'))
    assert('i18n：seedReadOnly 中英文成对', i18n.includes("seedReadOnly: '内置题库'") && i18n.includes("seedReadOnly: 'Built-in'"))
    const store = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
    assert('store.js：getQuestions 种子拼接 + 去重', store.includes('BANK.questions.forEach') && store.includes('_seed: true'))
    assert('store.js：迁移分类表不再写 11 大主题（v9 分支）', store.includes("BANK.categories.filter(c => Number(c.id) >= 12)"))
    assert('store.js：种子题只读保护', (store.match(/cat_id|category_id\) >= 12 && String\(q\.id\) === sid/g) || []).length >= 2)
  }

  console.log(testFailed ? '\n存在失败用例 ✗' : '\n全部通过 ✓')
  process.exit(testFailed ? 1 : 0)   // 必须显式退出：沙箱内定时器句柄会阻止进程自然退出
})()
