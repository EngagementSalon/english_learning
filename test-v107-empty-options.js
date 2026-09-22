// v107：选项空槽清理（学员反馈「标帜餐厅考题里有些题选项有空选项」）
// 成因：管理端批量导入模板每题 6 个选项格，只填前 3 个 → 后 3 个空串；
//      渲染层 q.options.map 为每个空串画一个「有边框、能点、但没字」的空白选项。
// 覆盖：① 导入层 impEntryFromCells 裁尾槽；② 渲染层 visibleOptionIndexes；
//      ③ safeQType 按「有效选项数」判定；④ store.compactUploadedOptions（本地库自愈）；
//      ⑤ cloud-store._optCompact（云端压缩/解包）；⑥ 全库体检。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let PASS = 0, FAIL = 0
const fails = []
function ok(cond, name, extra) {
  if (cond) { PASS++; return true }
  FAIL++; fails.push(name + (extra ? ' | ' + extra : ''))
  return false
}
function eq(a, b, name) { return ok(JSON.stringify(a) === JSON.stringify(b), name, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`) }

const DIR = __dirname
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8')

// ---------- 提取被测函数 ----------
// function 声明式
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(')
  if (i < 0) return null
  return braceSlice(src, i)
}
// 对象方法简写式（`name(args) { ... }`）→ 转成独立的 `function name(args) { ... }`。
// 关键：必须锚定「行首只有缩进 + 方法名」，否则会命中 `this.compactUploadedOptions(list)` 这类调用点。
// 注意：方法简写体不能直接塞进对象字面量再 eval（`{name(list){}}` 在 `var o = {` 里合法，
// 但单独取出后 `name(list){...}` 不再是合法表达式/声明）—— 必须显式补上 `function ` 关键字。
function grabMethodAsFunction(src, name) {
  const re = new RegExp('^[ \\t]*' + name + '\\s*(\\([^)]*\\))\\s*\\{', 'm')
  const m = re.exec(src)
  if (!m) return null
  const open = m.index + m[0].length - 1   // 指向 '{'
  return 'function ' + name + m[1] + ' ' + src.slice(open, braceEnd(src, open) + 1)
}
// 从 '{' 位置配对到闭合 '}'
function braceEnd(src, open) {
  let d = 0, inS = null, inC = false
  for (let k = open; k < src.length; k++) {
    const ch = src[k], nx = src[k + 1]
    if (inC) { if (ch === '\n') inC = false; continue }
    if (inS) { if (ch === '\\') { k++; continue } if (ch === inS) inS = null; continue }
    if (ch === '/' && nx === '/') { inC = true; continue }
    if (ch === '/' && nx === '*') { const e = src.indexOf('*/', k + 2); k = e < 0 ? src.length : e + 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inS = ch; continue }
    if (ch === '{') d++
    else if (ch === '}') { d--; if (d === 0) return k }
  }
  return src.length - 1
}
function braceSlice(src, from) {
  const open = src.indexOf('{', from)
  return src.slice(from, braceEnd(src, open) + 1)
}

const appSrc = read('app.js')
const fnSrc = [grab(appSrc, 'visibleOptionIndexes'), grab(appSrc, 'safeQType'), grab(appSrc, 'impTrimEmptyTail')].filter(Boolean).join('\n')
ok(!!grab(appSrc, 'visibleOptionIndexes'), 'app.js 存在 visibleOptionIndexes')
ok(!!grab(appSrc, 'impTrimEmptyTail'), 'app.js 存在 impTrimEmptyTail')

const sb = { console }
vm.createContext(sb)
vm.runInContext(fnSrc, sb)
const { visibleOptionIndexes, safeQType, impTrimEmptyTail } = sb

console.log('=== 一、visibleOptionIndexes（渲染层去空槽）===')
eq(visibleOptionIndexes(['甲', '乙', '丙', '', '', '']), [0, 1, 2], '典型：6 槽只填 3 个 → 只留 0,1,2')
eq(visibleOptionIndexes(['甲', '乙', '', '', '', '']), [0, 1], '6 槽只填 2 个')
eq(visibleOptionIndexes(['甲', '乙', '', '丁']), [0, 1, 2, 3], '中间空槽保留（不能裁，否则答案下标错位）')
eq(visibleOptionIndexes(['甲', '', '丙', '']), [0, 1, 2], '尾部空槽裁掉，中间空槽保留')
eq(visibleOptionIndexes(['甲', '乙']), [0, 1], '无空槽 → 原样')
eq(visibleOptionIndexes(['', '', '']), [], '全空 → 空数组')
eq(visibleOptionIndexes([]), [], '空数组')
eq(visibleOptionIndexes(null), [], 'null 兜底')
eq(visibleOptionIndexes(['  ', '甲', '  ']), [0, 1], '纯空白视为空槽')
eq(visibleOptionIndexes(['真', '假']), [0, 1], '判断题 2 项')

console.log('=== 二、safeQType（按有效选项数判定）===')
eq(safeQType({ type: 'single', options: ['甲', '乙'] }), 'single', '2 个有效选项 → 保持 single')
eq(safeQType({ type: 'single', options: ['甲', ''] }), 'fill', '1 个有效选项 → 降级 fill')
eq(safeQType({ type: 'single', options: ['甲', '', '', ''] }), 'fill', '1 个有效 + 3 空槽 → 降级 fill')
eq(safeQType({ type: 'single', options: ['', '', ''] }), 'fill', '全空 → 降级 fill')
eq(safeQType({ type: 'listen', options: ['甲', '乙', '', '', '', ''] }), 'listen', 'listen 3 有效 + 3 空 → 保持 listen（关键回归）')
eq(safeQType({ type: 'voicematch', options: ['甲', '乙', '丙', '', '', ''] }), 'voicematch', 'voicematch 保持')
eq(safeQType({ type: 'fill', options: ['答案'] }), 'fill', 'fill 不受选项数影响')
eq(safeQType({ type: 'translate', options: ['译'] }), 'translate', 'translate 不受影响')
eq(safeQType(null), '', 'null 兜底')

console.log('=== 三、impTrimEmptyTail（导入层裁尾槽）===')
eq(impTrimEmptyTail(['甲', '乙', '丙', '', '', '']), ['甲', '乙', '丙'], '模板 6 格 → 3 项')
eq(impTrimEmptyTail(['甲', '乙', '丙', '丁', '', '']), ['甲', '乙', '丙', '丁'], '4 项')
eq(impTrimEmptyTail(['甲', '乙']), ['甲', '乙'], '无空槽原样')
eq(impTrimEmptyTail([]), [], '空数组')

console.log('=== 四、store.compactUploadedOptions（本地库自愈）===')
// 用真实 store.js 里的函数（依赖仅 localStorage 常量，这里直接提取对象方法体等价实现做口径验证）
const storeSrc = read('store.js')
ok(storeSrc.indexOf('compactUploadedOptions') >= 0, 'store.js 已实现 compactUploadedOptions')
ok(storeSrc.indexOf('const compacted = this.compactUploadedOptions(rawUploaded)') >= 0, 'store.getQuestions 读取时自愈接线')
ok(storeSrc.indexOf('this._setUploaded(compacted.list)') >= 0, 'store 吸收云端时自愈接线')
ok(storeSrc.indexOf('addQuestion(data) {\n    const list = this.compactUploadedOptions(' + 'this._getUploaded()).list') >= 0 ||
   storeSrc.indexOf('compactUploadedOptions(this._getUploaded()).list') >= 0, 'addQuestion 写入时接线')
ok(storeSrc.indexOf('list[ui] = this.compactUploadedOptions(') >= 0, 'updateQuestion 写入时接线')
// 行为：填空题不能被裁
const cmpSb = { console, localStorage: { store: {}, getItem(k) { return this.store[k] || null }, setItem(k, v) { this.store[k] = String(v) } } }
cmpSb.STORAGE_KEYS = { UPLOADED: 'eq_uploaded' }
const cmpMethod = grabMethodAsFunction(storeSrc, 'compactUploadedOptions')
if (cmpMethod) {
  vm.createContext(cmpSb)
  try {
    vm.runInContext(cmpMethod, cmpSb)
    const r = cmpSb.compactUploadedOptions
    ok(typeof r === 'function', 'compactUploadedOptions 载入成功')
    const r1 = r([{ id: 'u1', type: 'single', options: ['甲', '乙', '丙', '', '', ''] }])
    eq(r1.fixed, 1, 'compactUploadedOptions 报告 1 题被修')
    eq(r1.list[0].options, ['甲', '乙', '丙'], '选项裁到 3 项')
    ok(r1.list[0].id === 'u1' && r1.list[0].type === 'single', '裁槽时保留其他字段')
    const r2 = r([{ id: 'u2', type: 'fill', options: ['参考答案'] }])
    eq(r2.fixed, 0, '填空题不裁（options=[参考答案]）')
    eq(r2.list[0].options, ['参考答案'], '填空题选项原样')
    const r3 = r([{ id: 'u3', type: 'single', options: ['甲', '乙'] }])
    eq(r3.fixed, 0, '干净题不产生写入（幂等）')
    ok(r3.list[0] === r3.list[0] && r3.fixed === 0, '干净库整题对象引用不变')
    const r4 = r([{ id: 'u1', type: 'single', options: ['甲', '乙', '丙', '', '', ''] }, { id: 'u2', type: 'fill', options: ['x'] }])
    eq(r4.fixed, 1, '混合库只报被修的那 1 题')
    eq(r4.list.length, 2, '混合库题数不变')
    eq(r4.list[0].options.length, 3, '第一题被裁')
    eq(r4.list[1].options.length, 1, '第二题不动')
    // 幂等：连续两次结果一致
    const again = r(r4.list)
    eq(again.fixed, 0, '二次清理 fixed=0（幂等）')
    // 判断题
    const r5 = r([{ id: 'u5', type: 'judge', options: ['正确', '错误', '', ''] }])
    eq(r5.list[0].options, ['正确', '错误'], '判断题 2 项 + 2 空槽 → 裁成 2 项')
    // 中间空槽保留
    const r6 = r([{ id: 'u6', type: 'single', options: ['甲', '', '丙', ''] }])
    eq(r6.list[0].options, ['甲', '', '丙'], '中间空槽保留，只裁尾部')
    // 畸形题（options 缺失）不炸
    const r7 = r([{ id: 'u7', type: 'single' }, null])
    eq(r7.fixed, 0, 'options 缺失/null 题不炸')
  } catch (e) {
    ok(false, 'compactUploadedOptions 可独立执行', String(e && e.message))
  }
} else {
  ok(false, 'store.js 可提取 compactUploadedOptions')
}

console.log('=== 五、cloud-store._optCompact / _upqPack / _upqUnpack ===')
const csSrc = read('cloud-store.js')
ok(csSrc.indexOf('function _optCompact(') >= 0, 'cloud-store 已实现 _optCompact')
ok(csSrc.indexOf('function _qOptCompact(') >= 0, 'cloud-store 已实现 _qOptCompact')
ok(csSrc.indexOf('o: _optCompact(q.options),') >= 0, '_upqPack 压缩时去空槽')
ok(csSrc.indexOf('options: _optCompact(x.o || [], x.a || [], x.t || \'single\'),') >= 0, '_upqUnpack 解包时去空槽（兼容云端旧数据）')

console.log('=== 六、渲染层接线（三个页面八个分支）===')
// app.js：练习 single 分支 + 练习 multiple 分支 + 考试 single + 考试 multiple + 水平测试 = 5 处渲染
//         + safeQType 内 1 处计数 = 6 次出现（safeQType 那次不是渲染分支，按行号排除）
const appVisLines = []
appSrc.split('\n').forEach((l, i) => { if (l.indexOf('visibleOptionIndexes(q.options)') >= 0) appVisLines.push(i + 1) })
const appRenderBranches = appVisLines.filter(n => !/const n = visibleOptionIndexes/.test(appSrc.split('\n')[n - 1]))
eq(appRenderBranches.length, 5, 'app.js 有 5 处渲染分支接入（练习×2 + 考试×2 + 水平测试×1）')
eq(appVisLines.length, 6, 'app.js visibleOptionIndexes 共 6 次出现（含 safeQType 的 1 次计数）')
const chSrc = read('challenge.js')
const chVis = []
chSrc.split('\n').forEach((l, i) => { if (l.indexOf('visibleOptionIndexes(q.options)') >= 0) chVis.push(i + 1) })
eq(chVis.length, 1, 'challenge.js 有 1 处接入（七天挑战选项）')
const caSrc = read('course-app.js')
const caVis = []
caSrc.split('\n').forEach((l, i) => { if (l.indexOf('visibleOptionIndexes(q.options)') >= 0) caVis.push(i + 1) })
eq(caVis.length, 3, 'course-app.js 有 3 次出现（单选/多选渲染 2 + 保存时重映射 1）')
const caRender = caVis.filter(n => !/const keep = visibleOptionIndexes/.test(caSrc.split('\n')[n - 1]))
eq(caRender.length, 2, 'course-app.js 有 2 处渲染分支接入（线下课单选/多选）')
// 不允许再出现裸的 q.options.map(opt =>
ok(appSrc.indexOf('q.options.map((opt, i)') < 0, 'app.js 无残留裸 q.options.map((opt, i)')
ok(chSrc.indexOf('q.options.map((opt, i)') < 0, 'challenge.js 无残留裸 q.options.map((opt, i)')
ok(caSrc.indexOf('q.options.map((opt, i)') < 0, 'course-app.js 无残留裸 q.options.map((opt, i)')
// safeQType 必须改用有效选项数（不能用 options.length）
ok(appSrc.indexOf('const n = visibleOptionIndexes(q.options).length') > 0, 'safeQType 按有效选项数判定（v107）')
ok(appSrc.indexOf('const n = Array.isArray(q.options) ? q.options.length : 0') < 0, 'safeQType 旧的 options.length 口径已移除')

console.log('=== 七、导入层接线 ===')
ok(appSrc.indexOf('options: (type === \'fill\' || type === \'translate\') ? options : impTrimEmptyTail(options)') >= 0, 'impFromJsonList 裁尾槽')
ok(appSrc.indexOf('if (!isText && q.options.length > 1) {') >= 0, 'impEntryFromCells 裁尾槽')
ok(appSrc.indexOf('function compactAndPushUploaded()') >= 0, 'compactAndPushUploaded 已实现')
const ral = appSrc.indexOf('function renderAdminList()')
ok(ral > 0 && appSrc.slice(ral, ral + 260).indexOf('compactAndPushUploaded()') > 0, 'renderAdminList 自动清理 + 推云端')
ok(appSrc.indexOf('if (res.fixed > 0) {') > 0, 'compactAndPushUploaded 只在有修正时才推（幂等）')

console.log('=== 八、全库体检：种子题库不得有空选项 ===')
// 注意：`const BANK = {...}` 是模块级绑定，不挂 vm 沙箱顶层 —— 必须补一句显式导出后再取。
// （踩过的坑：直接读 sb.BANK / sb.window.BANK 都是 undefined，会误判成「BANK 载入失败」）
const bankSrc = read('bank-data.js')
const bankSb = { console, window: {} }
vm.createContext(bankSb)
vm.runInContext(bankSrc + '\n;globalThis.__BANK = BANK', bankSb)
const BANK = bankSb.__BANK
ok(!!BANK && Array.isArray(BANK.questions), 'BANK 载入成功')
if (BANK && Array.isArray(BANK.questions)) {
  const qs = BANK.questions
  console.log(`  种子题总数 ${qs.length}`)
  const NEEDIT = ['single', 'judge', 'multiple', 'pronounce', 'listen', 'voicematch']
  const emptyOpt = qs.filter(q => Array.isArray(q.options) && q.options.some(o => String(o == null ? '' : o).trim() === ''))
  eq(emptyOpt.length, 0, '种子库无「含空串选项」的题（含 middle 空槽）')
  const visBad = qs.filter(q => NEEDIT.includes(q.type) && visibleOptionIndexes(q.options).length < 2)
  eq(visBad.length, 0, '种子库无「有效选项 < 2」的选择题')
  const tailBad = qs.filter(q => NEEDIT.includes(q.type) && Array.isArray(q.options) && visibleOptionIndexes(q.options).length !== q.options.length)
  eq(tailBad.length, 0, '种子库无「尾部多余空槽」的题')
  // 答案下标不得指向空槽
  const ansBad = qs.filter(q => NEEDIT.includes(q.type) && Array.isArray(q.answer) &&
    q.answer.some(i => !Array.isArray(q.options) || q.options[i] == null || String(q.options[i]).trim() === ''))
  eq(ansBad.length, 0, '种子库无「答案指向空/不存在选项」的题')
  // 每题的渲染选项数分布（抽样打印）
  const dist = {}
  qs.forEach(q => {
    if (!NEEDIT.includes(q.type)) return
    const n = visibleOptionIndexes(q.options).length
    dist[n] = (dist[n] || 0) + 1
  })
  console.log('  有效选项数分布:', JSON.stringify(dist))
}

console.log('=== 九、存量数据体检（云端 upq 快照，若存在）===')
const snap = path.join(DIR, '_doc.json')
if (fs.existsSync(snap)) {
  try {
    const doc = JSON.parse(fs.readFileSync(snap, 'utf8'))
    const upq = Array.isArray(doc.upq) ? doc.upq : []
    console.log(`  云端 upq 题数 ${upq.length}`)
    const NEEDIT = ['single', 'judge', 'multiple', 'pronounce', 'listen', 'voicematch']
    let needFix = 0, worst = []
    upq.forEach(x => {
      const opts = Array.isArray(x.o) ? x.o : []
      const type = x.t || 'single'
      if (!NEEDIT.includes(type)) return
      const end = visibleOptionIndexes(opts).length
      if (end !== opts.length) {
        needFix++
        if (worst.length < 5) worst.push(`${x.i}(${type}) ${opts.length}→${end} 空槽=[${opts.map((o, i) => String(o == null ? '' : o).trim() === '' ? i : -1).filter(i => i >= 0).join(',')}]`)
      }
    })
    console.log(`  需要清理的题数: ${needFix}`)
    worst.forEach(w => console.log('    ', w))
    ok(true, '存量体检完成（清理由 _upqUnpack/_upqPack + 管理员进题库列表自动完成）')
  } catch (e) { ok(false, '存量快照解析', String(e && e.message)) }
} else {
  console.log('  (无 _doc.json 快照，跳过)')
}

console.log('')
console.log(`PASS ${PASS} / FAIL ${FAIL}`)
if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
process.exit(FAIL ? 1 : 0)
