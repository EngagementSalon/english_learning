// test-v127-assign-drag.js
// v127：班级作业顺序由「↑↓ 逐位点击」改为「拖拽排序」（鼠标 HTML5 drag + 手机 touch 双通道）
//
// 断言的取舍（照 §四·补二十 的纪律）：
//   - 能断行为就断行为：courseReorderList 是纯函数，直接沙箱真跑
//   - 断不了行为才断源码，且断「调用」优于断「表达式」
//   - 「函数定义存在」≠「功能存在」→ 必须断言被父级模板真调用（§7 铁律）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const HERE = __dirname
const APP = fs.readFileSync(path.join(HERE, 'app.js'), 'utf-8')
const CA = fs.readFileSync(path.join(HERE, 'course-app.js'), 'utf-8')
const HTML = fs.readFileSync(path.join(HERE, 'index.html'), 'utf-8')
const I18N = fs.readFileSync(path.join(HERE, 'i18n.js'), 'utf-8')
const CSS = fs.readFileSync(path.join(HERE, 'style.css'), 'utf-8')

let pass = 0, fail = 0
const ok = []
const bad = []
function assert(name, cond) {
  if (cond) { pass++; ok.push('  \u2713 ' + name) }
  else { fail++; bad.push('  \u2717 ' + name) }
}

// ---------- 工具：配平扫描取函数体（同 extractFn 思路） ----------
function grabFn(src, name) {
  const re = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) return null
  const start = m.index + m[1].length
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// ============================================================
// 组一：源码级 —— 手柄 + 双通道事件接线
// ============================================================
console.log('[1] 源码级：拖拽手柄与事件接线')

const handleSrc = grabFn(CA, 'courseSortBtns')
assert('courseSortBtns 函数存在', !!handleSrc)
if (handleSrc) {
  assert('手柄渲染出 course-drag-handle 类', handleSrc.includes('course-drag-handle'))
  assert('手柄带 draggable="true"', handleSrc.includes('draggable="true"'))
  assert('★ 鼠标通道：ondragstart 接线', handleSrc.includes('ondragstart="courseDragStart(event,this)"'))
  assert('★ 鼠标通道：ondragover 接线', handleSrc.includes('ondragover="courseDragOver(event,this)"'))
  assert('★ 鼠标通道：ondrop 接线', handleSrc.includes('ondrop="courseDragDrop(event,this)"'))
  assert('★ 鼠标通道：ondragend 接线', handleSrc.includes('ondragend="courseDragEnd(event,this)"'))
  assert('★ 触摸通道：ontouchstart 接线', handleSrc.includes('ontouchstart="courseTouchStart(event,this)"'))
  assert('手柄带 data-idx（落位需要）', handleSrc.includes('data-idx='))
  assert('手柄带 data-aid（标识被拖对象）', handleSrc.includes('data-aid='))
  // 旧按钮已移除（反向断言）
  assert('★ 旧的 ↑↓ 按钮已移除（不再有 courseMoveAssign(...,-1) 内联）',
    !handleSrc.includes('courseMoveAssign(') )
  assert('旧 course-sort-btns 容器已不在手柄里', !handleSrc.includes('course-sort-btns'))
}

// ============================================================
// 组二：源码级 —— 拖动目标行必须带 data-drag-idx（否则落位算不出来）
// ============================================================
console.log('[2] 源码级：行级落点标记（接线链）')

const dragRows = CA.match(/<tr[^>]*data-drag-aid="\$\{escAttr\(a\.id\)\}"[^>]*data-drag-idx="\$\{idx\}"/g) || []
assert('★ 普通作业行带 data-drag-aid + data-drag-idx（接线断言）', dragRows.length >= 1)
assert('★ 线下课行带 data-drag-aid + data-drag-idx（接线断言）',
  /<tr data-drag-aid="\$\{escAttr\(a\.id\)\}" data-drag-idx="\$\{idx\}"/.test(CA))

// ============================================================
// 组三：源码级 —— 全局 touch 监听必须挂 document 且幂等
// ============================================================
console.log('[3] 源码级：全局 touch 监听')

const bindSrc = grabFn(CA, 'courseDragBindGlobal')
assert('courseDragBindGlobal 函数存在', !!bindSrc)
if (bindSrc) {
  assert('touchmove 挂 document', /document\.addEventListener\('touchmove'/.test(bindSrc))
  assert('touchend 挂 document', /document\.addEventListener\('touchend'/.test(bindSrc))
  assert('touchcancel 也接管（防手势被系统打断后状态残留）',
    /document\.addEventListener\('touchcancel'/.test(bindSrc))
  assert('touchmove 用 passive:false（否则 preventDefault 无效）',
    /passive:\s*false/.test(bindSrc))
  assert('★ 幂等：带 _done 守卫（多次渲染不重复挂）', bindSrc.includes('_done'))
}
assert('★ courseDragBindGlobal 被 renderCourseAdmin 真调用（接线，非仅定义）',
  /function renderCourseAdmin\(\)\s*\{\s*\n\s*courseDragBindGlobal\(\)/.test(CA))

// ============================================================
// 组四：沙箱真跑 —— courseReorderList 纯函数
// ============================================================
console.log('[4] 沙箱：courseReorderList 重排语义')

function makeSandbox() {
  const sb = { console, JSON, Object, Array, String, Number, Math, Boolean }
  sb.window = sb
  vm.createContext(sb)
  const body = grabFn(CA, 'courseReorderList')
  if (!body) throw new Error('fn not found: courseReorderList')
  vm.runInContext(body + '\n;globalThis.__reorder = courseReorderList', sb)
  return sb
}

const sb1 = makeSandbox()
const run = (arr, from, to) => vm.runInContext(
  `JSON.stringify(__reorder(${JSON.stringify(arr)}, ${from}, ${to}))`, sb1)

// 往后拖：把第 0 个移到第 2 位
assert('★ 往后拖 [a,b,c,d] 0→2 得 [b,c,a,d]', run(['a', 'b', 'c', 'd'], 0, 2) === JSON.stringify(['b', 'c', 'a', 'd']))
// 往前拖：把第 3 个移到第 1 位
assert('★ 往前拖 [a,b,c,d] 3→1 得 [a,d,b,c]', run(['a', 'b', 'c', 'd'], 3, 1) === JSON.stringify(['a', 'd', 'b', 'c']))
// 首尾
assert('拖到首位 [a,b,c] 2→0 得 [c,a,b]', run(['a', 'b', 'c'], 2, 0) === JSON.stringify(['c', 'a', 'b']))
assert('拖到末位 [a,b,c] 0→2 得 [b,c,a]', run(['a', 'b', 'c'], 0, 2) === JSON.stringify(['b', 'c', 'a']))
// 落回原位 → null（表示「无变化」，调用方据此跳过重渲染）
assert('原位 1→1 返回 null（视为无变化）', run(['a', 'b', 'c'], 1, 1) === 'null')
// 越界守卫
assert('from 越界 返回 null（不动数据）', run(['a', 'b'], 5, 0) === 'null')
assert('to 越界 返回 null（不动数据）', run(['a', 'b'], 0, 9) === 'null')
assert('负数下标 返回 null', run(['a', 'b'], 0, -1) === 'null')
assert('非数组 返回 null（不抛错）', run(null, 0, 1) === 'null')
// 长度不变（防 splice 语义写错导致丢元素）
assert('重排后长度不变（4 元素 → 4 元素）', JSON.parse(run(['a', 'b', 'c', 'd'], 0, 3)).length === 4)
// 元素集合不变（防重复/丢失）
assert('重排后元素集合不变（不丢不重）',
  JSON.stringify(JSON.parse(run(['a', 'b', 'c', 'd'], 1, 3)).slice().sort()) === JSON.stringify(['a', 'b', 'c', 'd']))
// 纯函数：不改原数组
assert('★ 纯函数：不修改传入的数组（防原地 mutate 造成状态串扰）', (() => {
  const orig = ['a', 'b', 'c']
  const frozen = JSON.stringify(orig)
  run(orig, 0, 2)
  return JSON.stringify(orig) === frozen
})())

// ============================================================
// 组五：源码级 —— 落位下标换算（上/下半判定的语义）
// ============================================================
console.log('[5] 源码级：落位下标换算')

const dropSrc = grabFn(CA, 'courseDragDrop')
assert('courseDragDrop 函数存在', !!dropSrc)
if (dropSrc) {
  assert('★ 用 course-drop-below 判定「插到目标之后」', dropSrc.includes('course-drop-below'))
  assert('★ 落位交给 courseMoveAssignTo（唯一写入口）', dropSrc.includes('courseMoveAssignTo('))
  assert('下半 → to = 目标下标（不 +1，因自身被摘走后左移）', /after \? toIdx : toIdx - 1/.test(dropSrc))
}

const touchEndSrc = grabFn(CA, 'courseTouchEnd')
assert('courseTouchEnd 函数存在', !!touchEndSrc)
if (touchEndSrc) {
  assert('★ 触摸未越过阈值时不做任何事（不误触发排序）', /if\s*\(!st\.active\)\s*return/.test(touchEndSrc))
  assert('★ 触摸落位同样走 courseMoveAssignTo', touchEndSrc.includes('courseMoveAssignTo('))
}
const touchMoveSrc = grabFn(CA, 'courseTouchMove')
if (touchMoveSrc) {
  assert('★ 10px 阈值内不抢事件（保住列表滚动）', /Math\.abs\(dy\)\s*<\s*10/.test(touchMoveSrc))
  assert('进入拖拽态后 preventDefault 阻止页面滚动', /preventDefault\(\)/.test(touchMoveSrc))
}

// ============================================================
// 组六：唯一写入口 —— courseMoveAssignTi 持久化 + courseMoveAssign 回落
// ============================================================
console.log('[6] 源码级：持久化路径')

const moveToSrc = grabFn(CA, 'courseMoveAssignTo')
assert('courseMoveAssignTo 函数存在', !!moveToSrc)
if (moveToSrc) {
  assert('★ 走 CourseStore.mutate（云端读改写，不直接写 base）', moveToSrc.includes('CourseStore.mutate('))
  assert('★ 复用 courseReorderList（不重写一份重排逻辑）', moveToSrc.includes('courseReorderList('))
  assert('无变化时提前返回（不无谓重渲染）', /if\s*\(!ok\)\s*return/.test(moveToSrc))
}
const moveSrc = grabFn(CA, 'courseMoveAssign')
assert('courseMoveAssign 保留（无拖拽环境 / 键盘回落通道）', !!moveSrc)
if (moveSrc) {
  assert('★ courseMoveAssign 已改为按 id 定位下标后委派 courseMoveAssignTo',
    moveSrc.includes('courseMoveAssignTo(') && moveSrc.includes('findIndex'))
}

// ============================================================
// 组七：i18n 成对 + 文案确实更新为拖拽口径
// ============================================================
console.log('[7] i18n：新键成对与文案口径')

function countKey(src, key) {
  const re = new RegExp('(^|[\\s{,])' + key + '\\s*:', 'g')
  return (src.match(re) || []).length
}
assert('courseDragHint 出现 2 次（zh/en 成对）', countKey(I18N, 'courseDragHint') === 2)
assert('courseOrderHint 出现 2 次（zh/en 成对）', countKey(I18N, 'courseOrderHint') === 2)
// 文案确实改成「拖拽」口径（而不是残留旧的「用 ↕」）
const zhPart = I18N.slice(0, I18N.indexOf('\n  en:'))
const enPart = I18N.slice(I18N.indexOf('\n  en:'))
assert('★ zh 提示已改为拖拽口径（含「拖动」）', /courseOrderHint:\s*'[^']*拖动/.test(zhPart))
assert('★ en 提示已改为 drag 口径', /courseOrderHint:\s*'[^']*(drag|Drag)/.test(enPart))
assert('★ 旧 zh 文案「用 ↕ 调整」已消失', zhPart.indexOf('用 ↕ 调整') < 0)

// ============================================================
// 组八：CSS 类存在（拖拽视觉反馈）
// ============================================================
console.log('[8] CSS：拖拽视觉反馈类')

assert('CSS 有 .course-drag-handle', /\.course-drag-handle\s*\{/.test(CSS))
assert('★★ CSS 手柄必须 touch-action:none（否则 touchmove 被浏览器用于滚动，手机拖不动）',
  /\.course-drag-handle\s*\{[^}]*touch-action\s*:\s*none/.test(CSS))
assert('CSS 有 .course-dragging（拖动中）', /tr\.course-dragging/.test(CSS) || /\.course-dragging\s*\{/.test(CSS))
assert('CSS 有 .course-drop-above（落点提示）', /\.course-drop-above/.test(CSS))
assert('CSS 有 .course-drop-below（落点提示）', /\.course-drop-below/.test(CSS))

// ============================================================
// 组九：版本号弹性（唯一 ?v=N × 12 且 >= 127）
// ============================================================
console.log('[9] 版本号弹性')

const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniqV = Array.from(new Set(vms))
assert('版本号处数 = 12', vms.length === 12)
assert('版本号取值唯一', uniqV.length === 1)
assert('版本号 >= 127', uniqV.length === 1 && uniqV[0] >= 127)
assert('style.css 也带 ?v=（纯 CSS 改动才能靠 bump 生效）', /style\.css\?v=\d+/.test(HTML))

// ============================================================
console.log('')
console.log(ok.join('\n'))
if (bad.length) console.log('\n' + bad.join('\n'))
console.log('')
console.log('\u7ed3\u679c: ' + pass + ' \u901a\u8fc7, ' + fail + ' \u5931\u8d25')
process.exit(fail ? 1 : 0)
