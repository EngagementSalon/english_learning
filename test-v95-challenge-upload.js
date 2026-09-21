// ====== 测试：七天挑战手动上传题目（v95）======
// 用户需求：「七天挑战要可以在栏目下手动上传题目」
// 根因（两个叠加）：
//   ① 批量导入硬编码 category_id:1，而挑战抽题池 chBankQuestions() 只收 category 12
//      → 上传的题永远进不了七天挑战；
//   ② 上传库 eq_uploaded 只存本机 localStorage，从不云端同步
//      → 即便传对栏目，学员设备也看不到。
// v95 修复：导入弹窗加「题目栏目」下拉（cat 12 标注「七天挑战题库」）；
//          上传库随同步文档 doc.upq 全量同步（管理员推送 / 全端吸收）；
//          挑战页与营次管理面板加管理员上传入口。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

const elements = {}
const created = []   // v95：记录 createElement 产物（openImportModal 的弹层）
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {},
    textContent: '', className: '', title: '', placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}
const getEl = id => elements[id] || (elements[id] = mkEl())

const sandbox = {
  localStorage: {
    store: { 'eq_course_only_v43': '1' },
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  window: {
    addEventListener() {}, scrollTo() {},
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function () {},
  },
  document: {
    getElementById: getEl,
    // confirmImportRows 的行选择勾选框：全部视为已勾选
    querySelector: sel => (sel && String(sel).indexOf('imp-cb') >= 0) ? { checked: true } : null,
    querySelectorAll: () => [],
    createElement: () => { const el = mkEl(); created.push(el); return el },
    body: { appendChild() {} },
    title: '',
    addEventListener() {},
  },
  alert() {}, confirm() { return true }, prompt() { return null },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, JSON, Math, String, Number, Array, Object, Boolean,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)

const run = code => vm.runInContext(code, sandbox)
const Store = run('Store')

// 种子分类表（真实应用 init() 会写；沙箱手动灌入，让 cat 1 与 cat 12 都出现在下拉里）
run(`localStorage.setItem('eq_categories', JSON.stringify(BANK.categories))`)

;(async () => {
  console.log('\n🧪 七天挑战手动上传题目（v95）')

  Store.getSession = () => ({ role: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })

  console.log('\n1️⃣  导入弹窗：栏目下拉默认态（不传参 → 栏目 1，行为与 v94 前一致）')
  run('openImportModal()')
  let modal = created[created.length - 1]
  assert('弹窗含 importCat 下拉', modal.innerHTML.includes('id="importCat"'), '缺 importCat')
  assert('默认选中栏目 1', modal.innerHTML.includes('value="1" selected'), modal.innerHTML.slice(0, 200))
  assert('栏目 12 未被默认选中', !modal.innerHTML.includes('value="12" selected'), '不应默认选中挑战栏目')
  assert('挑战栏目选项存在且带标注', modal.innerHTML.includes('（' + run(`t('impChallengeTag')`) + '）'), '缺标注')
  assert('栏目提示文案存在', modal.innerHTML.includes(run(`t('impCatHint')`)))

  console.log('\n2️⃣  导入弹窗：从挑战入口打开 → 默认选中「七天挑战题库」+ 部门预设')
  run(`openImportModal(12, 'dining/yan')`)
  modal = created[created.length - 1]
  assert('栏目 12 默认选中', modal.innerHTML.includes('value="12" selected'), '未选中挑战栏目')
  assert('部门预设 dining/yan 生效', modal.innerHTML.includes('value="dining/yan" selected'), '未预设部门')

  console.log('\n3️⃣  确认导入 → 题目进挑战抽题池（cat 12）且带部门')
  const before = run('chBankQuestions()').length
  run(`impRows = [
    { ok: true, rowNo: 1, est: 2, q: { type: 'single', difficulty: 2, question: 'Yan Test Q1',
      options: ['a', 'b', 'c', 'd'], answer: [0], explanation: 'e1' } },
    { ok: true, rowNo: 2, est: 3, q: { type: 'fill', difficulty: 3, question: 'Yan Test Q2',
      options: [], answer: ['x'], explanation: 'e2' } },
    { ok: false, rowNo: 3, err: 'bad row', q: null },
  ]`)
  getEl('importCat').value = '12'
  getEl('importDept').value = 'dining/yan'
  run('confirmImportRows()')
  const qs = Store.getQuestions()
  const got = qs.filter(q => q.question === 'Yan Test Q1' || q.question === 'Yan Test Q2')
  assert('两道题都已入库', got.length === 2, `got ${got.length}`)
  assert('category_id = 12（挑战池口径）', got.every(q => Number(q.category_id) === 12),
    JSON.stringify(got.map(q => q.category_id)))
  assert('dept = dining/yan', got.every(q => q.dept === 'dining/yan'),
    JSON.stringify(got.map(q => q.dept)))
  const after = run('chBankQuestions()').length
  assert('chBankQuestions() 题数 +2（管理员无部门 → 看全部）', after === before + 2, `${before} -> ${after}`)
  const resEl = getEl('importResult').innerHTML
  assert('结果提示含栏目名', resEl.includes(run(`Store.getCategoryName(12)`)), resEl.slice(0, 200))
  assert('坏行未入库', !qs.some(q => q.question === 'bad row'))

  console.log('\n4️⃣  部门隔离：标帜餐厅学员的挑战池不含艳中上传题')
  Store.getSession = () => ({ role: 'student', name: 's1', dept: '饮食部·标帜餐厅' })
  Store.getUser = () => ({ name: 's1', dept: '饮食部·标帜餐厅' })
  const sigPool = run('chBankQuestions()')
  assert('sig 池不含 Yan Test Q1', !sigPool.some(q => q.question === 'Yan Test Q1'))
  Store.getSession = () => ({ role: 'student', name: 'y1', dept: '饮食部·艳中餐厅' })
  Store.getUser = () => ({ name: 'y1', dept: '饮食部·艳中餐厅' })
  const yanPool = run('chBankQuestions()')
  assert('yan 池包含 Yan Test Q1', yanPool.some(q => q.question === 'Yan Test Q1'))
  // 恢复管理员视角
  Store.getSession = () => ({ role: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })

  console.log('\n5️⃣  云端同步：_upqPack/_upqUnpack 往返无损')
  const roundtrip = run(`(function(){
    var src = Store._getUploaded().slice(0, 2)
    var packed = _upqPack(src)
    var back = _upqUnpack(packed)
    return JSON.stringify({
      n: back.length,
      ids: back.map(function(q){ return q.id }).join(','),
      cats: back.map(function(q){ return q.category_id }).join(','),
      depts: back.map(function(q){ return q.dept }).join(','),
      qs: back.map(function(q){ return q.question }).join('|'),
      optLens: back.map(function(q){ return q.options.length }).join(','),
      packedIsArray: Array.isArray(packed),
      compactKeys: packed[0] ? Object.keys(packed[0]).sort().join('') : ''
    })
  })()`)
  const rt = JSON.parse(roundtrip)
  assert('往返题数一致', rt.n === 2, roundtrip)
  assert('压缩键为 i/d/c/t/f/q/o/a/e', rt.compactKeys === 'acdefioqt', rt.compactKeys)
  assert('id 往返一致', rt.ids.split(',').every(x => x.charAt(0) === 'u'), rt.ids)
  assert('category 往返一致（含 12）', rt.cats.split(',').indexOf('12') >= 0, rt.cats)
  assert('dept 往返一致', rt.depts.split(',').indexOf('dining/yan') >= 0, rt.depts)
  assert('题干往返一致', rt.qs.indexOf('Yan Test Q') >= 0, rt.qs)

  console.log('\n6️⃣  云端同步：absorbCloudUploaded 幂等吸收 + 删除传播 + 本地题保护')
  run('localStorage.removeItem("eq_uploaded_cloudids")')
  run('Store._cloudUpqAt = 0')
  const localN0 = Store._getUploaded().length
  run(`
    var cloudA = { id: 'u9001', dept: 'dining/bar', category_id: 12, type: 'single',
      difficulty: 1, question: 'Cloud A', options: ['a','b'], answer: [0], explanation: '' }
    var cloudB = { id: 'u9002', dept: 'all', category_id: 12, type: 'single',
      difficulty: 1, question: 'Cloud B', options: ['a','b'], answer: [1], explanation: '' }
  `)
  run('Store.absorbCloudUploaded([cloudA, cloudB], 1000)')
  let up = Store._getUploaded()
  assert('吸收后本地含 Cloud A/B', up.some(q => q.question === 'Cloud A') && up.some(q => q.question === 'Cloud B'))
  assert('原有本地题未丢', up.length === localN0 + 2, `${localN0} -> ${up.length}`)
  run('Store.absorbCloudUploaded([cloudA, cloudB], 1000)')
  up = Store._getUploaded()
  assert('同 upqAt 重复吸收不重复入（幂等）', up.filter(q => q.question === 'Cloud A').length === 1)
  run('Store.addQuestion({ category_id: 12, dept: "all", type: "single", difficulty: 1, question: "Local Z", options: ["a","b"], answer: [0], explanation: "" })')
  up = Store._getUploaded()
  const hasLocalZ = up.some(q => q.question === 'Local Z')
  assert('本地自建题 Local Z 已存在', hasLocalZ)
  run('Store.absorbCloudUploaded([cloudA], 2000)')
  up = Store._getUploaded()
  assert('云端删除传播：Cloud B 被移除', !up.some(q => q.question === 'Cloud B'))
  assert('云端保留题 Cloud A 仍在', up.some(q => q.question === 'Cloud A'))
  assert('本地自建题 Local Z 不被云端吸收删除', up.some(q => q.question === 'Local Z'))
  run('Store.absorbCloudUploaded([cloudA], 1500)')
  assert('旧 upqAt 不回滚（时间戳幂等）', Store._getUploaded().some(q => q.question === 'Cloud A') &&
    !Store._getUploaded().some(q => q.question === 'Cloud B'))

  console.log('\n7️⃣  云端同步：setUploadedBank 读改写合并（本地权威 + 远端独有保留）')
  run(`
    var __putCalls = []
    CloudSync._getDoc = async function () {
      return { events: [], upq: _upqPack([{ id: 'u8001', dept: 'all', category_id: 12, type: 'single',
        difficulty: 1, question: 'Remote Only', options: [], answer: [], explanation: '' }]), upqAt: 42 }
    }
    CloudSync._putDoc = async function (doc) { __putCalls.push(JSON.parse(JSON.stringify(doc))) }
  `)
  await run('CloudSync.setUploadedBank(Store._getUploaded())')
  const putDoc = run('__putCalls[0]')
  const pushedQs = run('_upqUnpack(__putCalls[0].upq)')
  assert('推送包含远端独有题（不被本地清掉）', pushedQs.some(q => q.question === 'Remote Only'))
  assert('推送包含本地题（含挑战上传）', pushedQs.some(q => q.question === 'Yan Test Q1'))
  assert('upqAt 已更新为时间戳', Number(putDoc.upqAt) > 42, String(putDoc.upqAt))
  const pushedN = run('_upqUnpack(__putCalls[0].upq).length')
  assert('无 id 冲突重复', new Set(pushedQs.map(q => q.id)).size === pushedN)

  console.log('\n8️⃣  挑战页：管理员见上传入口，学员不可见')
  run(`
    CloudSync._chRounds = []
    CloudSync._chRoundCurId = ''
  `)
  run('renderChallenge()')
  const chHtml = getEl('page-challenge').innerHTML
  assert('挑战页含 openImportModal(12 入口', chHtml.includes('openImportModal(12'), '缺入口')
  assert('挑战页含按钮文案', chHtml.includes(run(`t('chUploadBtn')`)))
  assert('挑战页含说明文案', chHtml.includes(run(`t('chUploadHint')`)))
  Store.getSession = () => ({ role: 'student', name: 's1', dept: '饮食部·标帜餐厅' })
  Store.getUser = () => ({ name: 's1', dept: '饮食部·标帜餐厅' })
  run('renderChallenge()')
  const stuChHtml = getEl('page-challenge').innerHTML
  assert('学员挑战页无上传入口', !stuChHtml.includes('openImportModal(12'))
  Store.getSession = () => ({ role: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })

  console.log('\n9️⃣  营次管理面板：含上传入口（预设部门 = 当前 dashChDept）')
  run(`dashChDept = 'dining/yan'`)
  const panelHtml = run('dashRoundsPanelHtml()')
  assert('面板含 openImportModal(12 入口', panelHtml.includes('openImportModal(12'), '缺入口')
  assert('面板入口预设当前部门', panelHtml.includes(`openImportModal(12,'dining/yan')`), '未预设')
  assert('面板含按钮文案', panelHtml.includes(run(`t('chUploadBtn')`)))

  console.log('\n🔟 pushUploadedBankSoon 防抖接线')
  assert('pushUploadedBankSoon 已定义', typeof run('pushUploadedBankSoon') === 'function')
  run('pushUploadedBankSoon()')   // CloudSync.setUploadedBank 存在 → 只排定时器；进程随即退出，不会真发
  assert('调用不抛错', true)

  console.log('\n1️⃣1️⃣ i18n 中英成对')
  const KEYS = ['impCatLabel', 'impCatHint', 'impChallengeTag', 'chUploadBtn', 'chUploadHint']
  const zhVals = JSON.parse(run(`JSON.stringify([${KEYS.map(k => `t('${k}')`).join(',')}])`))
  const enVals = JSON.parse(run(`(function(){ setLang('en');` +
    ` var r = [${KEYS.map(k => `t('${k}')`).join(',')}];` +
    ` setLang('zh'); return JSON.stringify(r) })()`))
  KEYS.forEach((k, i) => {
    assert(`zh.${k} 非空`, !!zhVals[i], String(zhVals[i]))
    assert(`en.${k} 与 zh 不同`, enVals[i] && enVals[i] !== zhVals[i], String(enVals[i]))
  })

  console.log(testFailed ? '\n❌ 七天挑战手动上传测试失败\n' : '\n✅ 七天挑战手动上传测试全部通过\n')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
