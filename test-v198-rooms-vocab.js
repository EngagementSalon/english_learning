// ====== v198 回归：房务部词汇子题库（礼宾部 50 词 + 客房用品 68 词）======
// 覆盖：① 题库结构与数据质量 ② 题池展开（rizhao/fangwu → 房务五子部门）③ 21 天挑战可跑性
//       ④ 源码契约（分类 >=12 口径）⑤ 题目质量（选项、答案、题型覆盖）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')) }
}

const D = __dirname
const CH = fs.readFileSync(path.join(D, 'challenge.js'), 'utf-8')

// 载入种子题库
const sbBank = { console }
vm.createContext(sbBank)
vm.runInContext(fs.readFileSync(path.join(D, 'bank-data.js'), 'utf-8'), sbBank)
const BANK = vm.runInContext('BANK', sbBank)
const ALL_Q = BANK.questions
const C13 = ALL_Q.filter(q => Number(q.category_id) === 13)
const CON = C13.filter(q => q.dept === 'rooms/concierge')
const STY = C13.filter(q => q.dept === 'rooms/styling')

console.log('\n=== [A] 题库结构（分类 13 房务常用词汇）===')
ok('A1 分类 13「房务常用词汇」已注册', BANK.categories.some(c => Number(c.id) === 13))
ok('A2 BANK.version 未动（仍为 9，避免触发全设备迁移）', BANK.version === 9, '实=' + BANK.version)
ok('A3 房务词汇题 708 道（118 词 × 6 题型）', C13.length === 708, '实=' + C13.length)
ok('A4 礼宾部（rooms/concierge）300 题 = 50 词 × 6', CON.length === 300, '实=' + CON.length)
ok('A5 客房用品（rooms/styling）408 题 = 68 词 × 6', STY.length === 408, '实=' + STY.length)
const ids13 = C13.map(q => Number(q.id))
ok('A6 id 段 10000–10707（避开 9xxx 既有假设段）',
  Math.min.apply(null, ids13) === 10000 && Math.max.apply(null, ids13) === 10707,
  Math.min.apply(null, ids13) + '–' + Math.max.apply(null, ids13))
ok('A7 全库 id 唯一', new Set(ALL_Q.map(q => String(q.id))).size === ALL_Q.length)
const diff13 = [1, 2, 3].map(d => C13.filter(q => Number(q.difficulty) === d).length)
ok('A8 难度分布 202/294/212（对齐 21 天一期配比需求）',
  JSON.stringify(diff13) === JSON.stringify([202, 294, 212]), JSON.stringify(diff13))
const types13 = {}
C13.forEach(q => { types13[q.type] = (types13[q.type] || 0) + 1 })
ok('A9 六种题型齐备（single/listen/voicematch/judge/multiple）',
  types13.single === 236 && types13.listen === 118 && types13.voicematch === 118 &&
  types13.judge === 118 && types13.multiple === 118, JSON.stringify(types13))

console.log('\n=== [B] 题池展开（rizhao/fangwu）===')
const sbCh = { console }
vm.createContext(sbCh)
const aliasBlock = CH.slice(CH.indexOf('const CH_DEPT_POOL_ALIAS'), CH.indexOf('// v89：本部门题库题目数'))
vm.runInContext(aliasBlock, sbCh)
const expand = vm.runInContext('chPoolExpandDepts', sbCh)

const fwPool = expand(['rizhao/fangwu'])
ok('B1 fangwu 展开 = 自身 + 房务五子部门',
  JSON.stringify(fwPool) === JSON.stringify(['rizhao/fangwu', 'rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa']),
  JSON.stringify(fwPool))
ok('B2 canyin 展开行为不变（四餐厅，不含自身）',
  JSON.stringify(expand(['rizhao/canyin'])) === JSON.stringify(['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird']))
ok('B3 非别名部门原样返回', JSON.stringify(expand(['dining/sig', 'rooms/fo'])) === JSON.stringify(['dining/sig', 'rooms/fo']))

// 抽题池过滤（复刻 chRoundBankQuestions 的过滤段，喂真实题库）
const poolOf = depts => {
  const pool = expand(depts)
  const majors = pool.map(d => String(d).split('/')[0])
  return ALL_Q.filter(q => Number(q.category_id) >= 12).filter(q => {
    const d = q.dept || ''
    if (!d || d === 'all') return true
    return pool.indexOf(d) >= 0 || majors.indexOf(d) >= 0
  })
}
const fwQs = poolOf(['rizhao/fangwu'])
ok('B4 房务营次抽题池 = 708 题（全部房务词汇）', fwQs.length === 708, '实=' + fwQs.length)
ok('B5 抽题池不含餐饮题（不串部门）', fwQs.every(q => (q.dept || '').indexOf('dining') !== 0))

console.log('\n=== [C] 21 天挑战可跑性（v3 一期）===')
const PLAN_V3 = [
  [0, 0, 0], [26, 4, 0], [22, 8, 0], [18, 11, 1], [15, 13, 2], [12, 15, 3], [10, 16, 4],
  [8, 17, 5], [7, 17, 6], [6, 17, 7], [5, 17, 8], [4, 17, 9], [4, 16, 10], [3, 16, 11],
  [3, 15, 12], [2, 15, 13], [2, 14, 14], [1, 14, 15], [1, 13, 16], [0, 13, 17], [0, 0, 0],
]
const TEST_V3 = [15, 10, 5]
const need = [0, 0, 0]
PLAN_V3.forEach(r => r.forEach((v, i) => { need[i] += v }))
need.forEach((v, i) => { need[i] += TEST_V3[i] * 2 })   // Day1 + Day21 两次考试
const have = [0, 0, 0]
fwQs.forEach(q => { const d = Number(q.difficulty) || 1; have[Math.min(3, d) - 1]++ })
ok('C1 总题量 ≥ 630（21 天一天不重复）', fwQs.length >= 630, fwQs.length + ' vs 630')
ok('C2 难度1 库存 ≥ 需求 179', have[0] >= need[0], have[0] + ' vs ' + need[0])
ok('C3 难度2 库存 ≥ 需求 288', have[1] >= need[1], have[1] + ' vs ' + need[1])
ok('C4 难度3 库存 ≥ 需求 163', have[2] >= need[2], have[2] + ' vs ' + need[2])
// v3 天结构自检：21 天 × 每天 30 题 = 630（从源码常量块直接数，不写死总数字面量）
const daysV3Block = CH.slice(CH.indexOf('const CHALLENGE_DAYS_V3'), CH.indexOf('// 21 天总题量'))
const dayCounts = (daysV3Block.match(/count: (\d+)/g) || []).map(s => Number(s.split(' ')[1]))
ok('C5 v3 天结构 = 21 天 × 30 题 = 630',
  dayCounts.length === 21 && dayCounts.every(n => n === 30) && dayCounts.reduce((a, b) => a + b, 0) === 630,
  '天数=' + dayCounts.length + ' 合计=' + dayCounts.reduce((a, b) => a + b, 0))
ok('C6 科目隔离：房务池只有 cat>=12 的房务/通用题',
  fwQs.every(q => Number(q.category_id) >= 12))

console.log('\n=== [D] 源码契约（分类 >=12 口径）===')
const codeOnly = s => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
function extractFn(src, name) {
  const i = src.search(new RegExp('(^|\\n)\\s*(async\\s+)?function ' + name + '\\s*\\('))
  if (i < 0) return ''
  let d = 0, started = false
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '{') { d++; started = true } else if (c === '}') { d--; if (started && d === 0) return src.slice(i, j + 1) }
  }
  return ''
}
ok('D1 chBankQuestions 用 >= 12（房务分类 13 可进池）',
  /category_id\)?\s*>=\s*12/.test(codeOnly(extractFn(CH, 'chBankQuestions'))))
ok('D2 chRoundBankQuestions 用 >= 12',
  /category_id\)?\s*>=\s*12/.test(codeOnly(extractFn(CH, 'chRoundBankQuestions'))))
ok('D3 不再有硬编码 category_id === 12 的题源过滤',
  !/category_id\)?\s*===\s*12/.test(codeOnly(extractFn(CH, 'chBankQuestions'))) &&
  !/category_id\)?\s*===\s*12/.test(codeOnly(extractFn(CH, 'chRoundBankQuestions'))))
ok('D4 CH_DEPT_POOL_ALIAS 含 rizhao/fangwu 六项（含自身）',
  /'rizhao\/fangwu':\s*\['rizhao\/fangwu',\s*'rooms\/fo',\s*'rooms\/concierge',\s*'rooms\/ww',\s*'rooms\/styling',\s*'rooms\/spa'\]/.test(CH))
ok('D5 app.js 导入提示按分类 >=12 判定挑战题库',
  /Number\(cSel\.value\)\s*>=\s*12/.test(fs.readFileSync(path.join(D, 'app.js'), 'utf-8')))
// v198 真 bug 修复：挑战页原本只有单选交互，抽到 multiple 时学员只能选一项 → 永远判错
ok('D6 挑战页 chPick 支持多选题累积/取消',
  /safeQType\(q\) === 'multiple'/.test(extractFn(CH, 'chPick')))
ok('D7 选项渲染按「数组/单值」统一判断选中态',
  /Array\.isArray\(ans\) \? ans\.indexOf\(i\) >= 0 : ans === i/.test(extractFn(CH, 'chOptionsHtml')))
ok('D8 提交守卫把多选空数组视为未答',
  /Array\.isArray\(ans\) && !ans\.length/.test(extractFn(CH, 'chSubmitAnswer')))

console.log('\n=== [E] 题目质量 ===')
const words = {}
C13.forEach(q => {
  const key = q.dept + '|' + q.type
  words[key] = (words[key] || 0) + 1
})
ok('E1 每部门每题型数量 = 词数（礼宾 50 / 客房 68）',
  words['rooms/concierge|single'] === 100 && words['rooms/concierge|judge'] === 50 &&
  words['rooms/styling|single'] === 136 && words['rooms/styling|judge'] === 68, JSON.stringify(words['rooms/concierge|judge']) + '/' + words['rooms/styling|judge'])

let badAnswer = 0, dupOpt = 0, emptyQ = 0, badMulti = 0
C13.forEach(q => {
  const opts = q.options || []
  if (!q.question || !String(q.question).trim()) emptyQ++
  if (!Array.isArray(q.answer) || !q.answer.length) badAnswer++
  else if (q.answer.some(i => i < 0 || i >= opts.length)) badAnswer++
  if (new Set(opts.map(String)).size !== opts.length) dupOpt++
  if (q.type === 'multiple' && (q.answer.length < 2 || q.answer.length >= opts.length)) badMulti++
})
ok('E2 题干非空', emptyQ === 0, '空=' + emptyQ)
ok('E3 answer 索引全部合法', badAnswer === 0, '非法=' + badAnswer)
ok('E4 选项无重复（同题内）', dupOpt === 0, '重复=' + dupOpt)
ok('E5 多选题答案 ≥2 且非全选', badMulti === 0, '异常=' + badMulti)

const judgeWrong = C13.filter(q => q.type === 'judge' && String(q.options[q.answer[0]]) === '错误').length
ok('E6 判断题「错误」版约占一半（防止全靠蒙对）', judgeWrong >= 40 && judgeWrong <= 80, '实=' + judgeWrong)

// 同词不同题型的选项不应完全一致（否则秒答）
const byEn = {}
C13.filter(q => q.type === 'single' || q.type === 'listen' || q.type === 'voicematch').forEach(q => {
  const en = q.type === 'voicematch' ? q.question : (String(q.question).match(/"([^"]+)"/) || [])[1] || q.question
  const k = q.dept + '|' + en
  byEn[k] = byEn[k] || []
  byEn[k].push(q.options.map(String).join(','))
})
let sameOpts = 0
Object.keys(byEn).forEach(k => {
  const arr = byEn[k]
  if (arr.length >= 2 && new Set(arr).size < arr.length) sameOpts++
})
ok('E7 同词不同题型选项不雷同', sameOpts === 0, '雷同=' + sameOpts)

// listen / voicematch 题必须能被 TTS 覆盖（题干是纯英文）
const audioTypes = C13.filter(q => q.type === 'listen' || q.type === 'voicematch')
ok('E8 听音类题干为纯英文（可交给 TTS）',
  audioTypes.every(q => /^[\x20-\x7E]+$/.test(String(q.question).trim())), '')

console.log('\n=== 结果 = ' + pass + ' 通过 / ' + fail + ' 失败 ===')
if (fail) process.exit(1)
