// v102：营次「记录键」不得依赖营次名称（改名即断链）
// 背景事故：v88 首次实现时用营次名称当记录键，v90 把第一期改名成「标帜餐厅七天挑战第一期」→
//   存量 rd="第一期" 与新提交 rd="" 双双与看板 wantSlug 对不上，学员成绩在看板整体消失。
// 本测试固化：'第一期' / 'r1' / '' / undefined 必须归一到同一键，且名称永不参与。
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const DIR = __dirname

let pass = 0, fail = 0
const results = []
function assert(name, cond) {
  if (cond) { pass++; results.push('  ✅ ' + name) }
  else { fail++; results.push('  ❌ ' + name) }
}

// ---- 从真实源码提取函数，避免「测试自己实现一遍」的假绿 ----
function extractFn(file, fnName) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8')
  // 匹配 function fnName(...) { ... } —— 花括号配对
  const re = new RegExp('^function ' + fnName + '\\s*\\([^)]*\\)\\s*\\{', 'm')
  const m = re.exec(src)
  if (!m) throw new Error('未找到函数 ' + fnName + ' in ' + file)
  let i = m.index + m[0].length, depth = 1
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(m.index, i)
}

const sandbox = {}
vm.createContext(sandbox)

const fns = [
  ['cloud-store.js', '_roundSlugKey'],
  ['app.js', 'dashRoundSlug'],
  ['challenge.js', 'chRoundSlug'],
]
fns.forEach(([f, n]) => vm.runInContext(extractFn(f, n), sandbox, { filename: f + ':' + n }))

vm.runInContext(`
  // 营次表（真实线上状态）
  var ROUNDS = [
    { id: 'r1', name: '标帜餐厅七天挑战第一期' },
    { id: 'r2', name: '艳中餐厅七天挑战第一期' },
  ];
`, sandbox)

// ---------- 组 1：三个归一函数必须对 r1/''/'第一期'/undefined 给同一答案 ----------
results.push('【组 1】第一期族必须同键（空串 / r1 / 第一期 / undefined）')
;[
  ['', '_roundSlugKey', ''],
  ['r1', '_roundSlugKey', ''],
  ['第一期', '_roundSlugKey', ''],
  ['', 'dashRoundSlug', '第一期'],
  ['r1', 'dashRoundSlug', '第一期'],
  ['第一期', 'dashRoundSlug', '第一期'],
  ['', 'chRoundSlug', '第一期'],
  ['r1', 'chRoundSlug', '第一期'],
  ['第一期', 'chRoundSlug', '第一期'],
].forEach(([inp, fn, want]) => {
  const got = vm.runInContext(fn + '(' + JSON.stringify(inp) + ')', sandbox)
  assert(fn + '(' + JSON.stringify(inp) + ') === ' + JSON.stringify(want) + '（实得 ' + JSON.stringify(got) + '）', got === want)
})
assert('_roundSlugKey(undefined) === ""',
  vm.runInContext('_roundSlugKey(undefined)', sandbox) === '')
assert('dashRoundSlug(undefined) === "第一期"',
  vm.runInContext('dashRoundSlug(undefined)', sandbox) === '第一期')

// ---------- 组 2：非第一期营次不得被误并入第一期 ----------
results.push('')
results.push('【组 2】r2 必须独立（不得并入第一期）')
assert('_roundSlugKey("r2") === "r2"', vm.runInContext('_roundSlugKey("r2")', sandbox) === 'r2')
assert('dashRoundSlug("r2") === "r2"', vm.runInContext('dashRoundSlug("r2")', sandbox) === 'r2')
assert('chRoundSlug("r2") === "r2"', vm.runInContext('chRoundSlug("r2")', sandbox) === 'r2')
assert('第一期族 ≠ r2（三函数一致）',
  vm.runInContext('_roundSlugKey("r1") !== _roundSlugKey("r2")', sandbox) &&
  vm.runInContext('dashRoundSlug("r1") !== dashRoundSlug("r2")', sandbox) &&
  vm.runInContext('chRoundSlug("r1") !== chRoundSlug("r2")', sandbox))

// ---------- 组 3：核心回归 —— 营次名作为 rd 绝不能被当成有效记录键 ----------
results.push('')
results.push('【组 3】营次名称永不作为记录键（本次事故根因）')
const biaoName = vm.runInContext('ROUNDS[0].name', sandbox)   // '标帜餐厅七天挑战第一期'
const yanName = vm.runInContext('ROUNDS[1].name', sandbox)

// 3a：看板侧——用 id 解析（正确路径）必须归到「第一期」
assert('看板用 id r1 解析 → wantSlug="第一期"',
  vm.runInContext('dashRoundSlug("r1")', sandbox) === '第一期')
// 3b：若有人误用营次名当键，得到的 slug 与「第一期」不同 → 说明名称不是合法键
assert('营次名 "标帜餐厅七天挑战第一期" 归一 ≠ "第一期"（证明名称不能当键）',
  vm.runInContext('dashRoundSlug(' + JSON.stringify(biaoName) + ')', sandbox) !== '第一期')
// 3c：存量记录 rd="第一期"（v88 名称为键时代的产物）必须能被看板命中
assert('存量记录 rd="第一期" 命中 看板 wantSlug（r1）',
  vm.runInContext('dashRoundSlug("第一期") === dashRoundSlug("r1")', sandbox))
// 3d：v88 名称为键时代的另一形态：rd 直接是营次名 → 应视为孤儿（不命中任何营次）
assert('rd=营次名（r1 的名）不命中 r1 → 确认为孤儿，需数据侧迁移',
  vm.runInContext('dashRoundSlug(' + JSON.stringify(biaoName) + ') !== dashRoundSlug("r1")', sandbox))
// 3e：新提交路径（chCurrentRound → 'r1'）与存量记录同键
assert('新提交 rd=_roundSlugKey("r1")="" → dashRoundSlug("")="第一期" 与存量同键',
  vm.runInContext('dashRoundSlug(_roundSlugKey("r1"))', sandbox) === '第一期')
// 3f：旧客户端提交（chRoundSlug('第一期')='第一期'）也必须归位，不再产生孤儿
assert('旧客户端 rd=_roundSlugKey("第一期")="" → 归位（修复前为 "第一期" 孤儿）',
  vm.runInContext('_roundSlugKey("第一期")', sandbox) === '')

// ---------- 组 4：chRoundSlug 是存档键派生源，必须与 _roundSlugKey 同判 ----------
results.push('')
results.push('【组 4】chRoundSlug / _roundSlugKey 对第一期判据一致（存档键与记录键同源）')
;['', 'r1', '第一期', 'r2', '第 3 期'].forEach(v => {
  const a = vm.runInContext('chRoundSlug(' + JSON.stringify(v) + ')', sandbox)
  const b = vm.runInContext('_roundSlugKey(' + JSON.stringify(v) + ')', sandbox)
  const same = (a === '第一期') === (b === '')
  assert('输入 ' + JSON.stringify(v) + ' → chRoundSlug=' + JSON.stringify(a) + ' / _roundSlugKey=' + JSON.stringify(b) + '（第一期判据一致）', same)
})

// ---------- 组 5：源码口径固化（防回归退化） ----------
results.push('')
results.push('【组 5】源码口径固化')
const csSrc = fs.readFileSync(path.join(DIR, 'cloud-store.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8')
const chSrc = fs.readFileSync(path.join(DIR, 'challenge.js'), 'utf8')

const slugKeyBody = extractFn('cloud-store.js', '_roundSlugKey')
assert('v102：_roundSlugKey 显式处理 "第一期"（与 r1 同键）',
  /s\s*===\s*'第一期'/.test(slugKeyBody) || /'第一期'\s*===/.test(slugKeyBody))
assert('v102：_roundSlugKey 注释含「不得依赖营次名称」警示',
  /不得依赖营次名称|不能依赖营次名称|永不.*名称|名称.*可变的显示字段/.test(csSrc))

const dashSlugBody = extractFn('app.js', 'dashRoundSlug')
assert('v102：dashRoundSlug 显式处理 "第一期"',
  /s\s*===\s*'第一期'/.test(dashSlugBody) || /'第一期'\s*===/.test(dashSlugBody))
assert('v102：dashRoundSlug 注释含事故警示',
  /v102|绝不能把营次名称当记录键/.test(appSrc))

const chSlugBody = extractFn('challenge.js', 'chRoundSlug')
assert('v102：chRoundSlug 把 "第一期" 与 "r1" 同判',
  /s\s*===\s*'第一期'/.test(chSlugBody))
assert('v102：chRoundSlug 上注释说明「第一期」是 r1 的输出',
  /'第一期' 是本函数对 'r1' 的输出|第一期.*是本函数.*输出/.test(chSrc))

// 三个函数都不得出现「用名称查营次」的写法
assert('v102：三处归一函数均未依赖 ROUNDS/name 查表',
  !/ROUNDS?\s*\.\s*find/.test(slugKeyBody) && !/ROUNDS?\s*\.\s*find/.test(dashSlugBody) && !/ROUNDS?\s*\.\s*find/.test(chSlugBody))

// ---------- 输出 ----------
const lines = results.join('\n')
const summary = '\n\n通过 ' + pass + ' / 失败 ' + fail + '（共 ' + (pass + fail) + ' 断言）'
fs.writeFileSync(path.join(DIR, '_v102-result.txt'), lines + summary, 'utf8')
console.log(lines + summary)
process.exit(fail ? 1 : 0)
