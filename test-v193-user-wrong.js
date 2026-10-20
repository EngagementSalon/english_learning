// test-v193-user-wrong.js —— v193：学员档案「错题」板块
//
// 用户诉求（2026-10-20）：「个人统计界面里能否再出现她的错题？」
//
// 本版契约（不可回退）：
//   [A] dashUserWrongList：从 r.chQ（挑战错题）+ r.perQ（练习错题）聚合，
//       **只读**，不写存储、不上报、不改原记录
//   [B] 次数口径：wrong = total - correct；correct 全对（wrong=0）的条目**必须剔除**
//   [C] 题面从外部传入的题库现取（Store.getQuestions 单一入口），**不在云端冗余存题干**
//   [D] 取不到题面的 qid **不静默丢弃** → missing 计数并单独提示
//   [E] 排序：按错次降序；同次数按 qid 稳定排序（云端无时间戳，**绝不编造时间序**）
//   [F] 渲染：题型标签走 t('typeLabels')，不存在的键会原样显示 → 禁止自造键名
//   [G] 接线：档案弹窗把错题传进 _upProfileHtml；中英 i18n 齐备
//
// ★ 判据一律用进程退出码（§B：绝不用 grep 判回归成败）
const fs = require('fs'), path = require('path'), vm = require('vm')
const D = __dirname
const APP = fs.readFileSync(path.join(D, 'app.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(D, 'i18n.js'), 'utf-8')

let pass = 0, fail = 0
function ck(ok, label, extra) {
  if (ok) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')) }
}
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const APP_CODE = codeOnly(APP)

function extractFn(src, name) {
  const key = 'function ' + name + '('
  const i = src.indexOf(key)
  if (i < 0) return ''
  const j = src.indexOf('{', i + key.length)
  if (j < 0) return ''
  let depth = 0
  for (let k = j; k < src.length; k++) {
    const ch = src[k]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  return ''
}

// ── 沙箱：i18n + 三个待测函数 ──
const TYPE_LABELS = { single: '单选题', multiple: '多选题', judge: '判断题', fill: '单词填空', translate: '单词翻译', pronounce: '单词读音', listen: '听音选义', voicematch: '看字选音' }
const sb = { console, JSON, Math, String, Number, Array, Object, Map, Set, isNaN, parseInt, parseFloat }
sb.globalThis = sb
sb.LANG = 'zh'
sb.t = (k, ...args) => {
  if (k === 'typeLabels') return TYPE_LABELS
  const tbl = {
    upWrongTitle: '错题', upWrongHint: '按答错次数排序。', upWrongNone: '没有错题记录。',
    upWrongCh: '七天挑战错题', upWrongPr: '练习 / 考试错题',
    upWrongTimes: (n) => `错 ${n} 次`, upWrongAnswer: '正确答案',
    upWrongMissing: (n) => `另有 ${n} 道题的原始题目已从题库移除，只能统计次数、无法显示题干。`,
    upWrongType: '题型', upWrongNoAnswer: '无标准答案',
  }
  const v = tbl[k]
  if (typeof v === 'function') return v(...args)
  return v == null ? k : v
}
sb.escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
vm.createContext(sb)

const FN_NAMES = ['dashUserWrongList', '_upWrongCardHtml', '_upWrongSectionHtml']
const code = FN_NAMES.map(n => extractFn(APP, n)).join('\n\n')
if (!code.trim()) { console.error('FATAL: 抽不到函数源码'); process.exit(1) }
vm.runInContext(code, sb)
const { dashUserWrongList, _upWrongCardHtml, _upWrongSectionHtml } = sb
if (typeof dashUserWrongList !== 'function') { console.error('FATAL: dashUserWrongList 未注入'); process.exit(1) }

// ── 题库样本 ──
const QUESTIONS = [
  { id: '8041', type: 'single', question: 'Hazelnut', options: ['榛子', '核桃', '杏仁', '花生'], answer: [0] },
  { id: 'u1902', type: 'listen', question: 'All beverage consumption will be charged separately.', options: ['所有酒水消费将单独计入账单。', '打扰一下，为您换骨碟。'], answer: [0] },
  { id: '133', type: 'fill', question: '核心句型填空："I have ______ a note of that."', options: ['made'], answer: [0] },
  { id: '136', type: 'judge', question: '客人进门要先问姓名。', options: ['正确', '错误'], answer: [1] },
  { id: '9011', type: 'voicematch', question: '黑松露牛肉粒。选出正确英文。', options: ['wok-seared Australian beef fillet', 'poached Cantonese cabbage'], answer: [0] },
]

console.log('=== [A] dashUserWrongList：聚合与只读 ===')
const rowA = {
  username: 'u1',
  chQ: { u1902: { correct: 0, total: 1 }, '8041': { correct: 0, total: 2 } },
  perQ: { '133': { correct: 0, total: 1 }, '136': { correct: 0, total: 3 } },
}
const before = JSON.stringify(rowA)
const wA = dashUserWrongList(rowA, QUESTIONS)
ck(JSON.stringify(rowA) === before, 'A1 不修改传入的 row（纯函数、只读）')
ck(wA.challenge.length === 2, 'A2 chQ 聚合出 2 道挑战错题', String(wA.challenge.length))
ck(wA.practice.length === 2, 'A3 perQ 聚合出 2 道练习错题', String(wA.practice.length))
ck(wA.total === 4, 'A4 total = 两组合计', String(wA.total))
ck(wA.missing === 0, 'A5 题库都能对上 → missing=0', String(wA.missing))
ck(wA.found === 4, 'A6 found = 4', String(wA.found))

console.log('\n=== [B] 次数口径：wrong = total - correct，全对剔除 ===')
const rowB = {
  username: 'u2',
  chQ: { u1902: { correct: 0, total: 1 } },
  perQ: {
    '133': { correct: 0, total: 5 },     // 错 5 次
    '136': { correct: 2, total: 3 },     // 错 1 次（有答对的）
    '8041': { correct: 4, total: 4 },    // 全对 → 必须剔除
    '9011': { correct: 0, total: 0 },    // total=0 → 必须剔除（脏数据）
  },
}
const wB = dashUserWrongList(rowB, QUESTIONS)
const byId = {}
wB.practice.forEach(x => { byId[x.qid] = x })
ck(wB.practice.length === 2, 'B1 全对与 total=0 的条目都被剔除', '剩 ' + wB.practice.length)
ck(!byId['8041'], 'B2 correct=total 的题不出现（不是错题）')
ck(!byId['9011'], 'B3 total=0 的脏数据不出现')
ck(byId['133'] && byId['133'].wrong === 5, 'B4 错 5 次 → wrong=5', byId['133'] ? String(byId['133'].wrong) : 'none')
ck(byId['136'] && byId['136'].wrong === 1, 'B5 total=3/correct=2 → wrong=1（不是 total=3）', byId['136'] ? String(byId['136'].wrong) : 'none')

console.log('\n=== [C] 题面从外部题库取 ===')
ck(byId['133'].question.indexOf('核心句型填空') === 0, 'C1 题干来自传入的题库', byId['133'].question.slice(0, 20))
ck(byId['133'].type === 'fill', 'C2 题型一并带出', byId['133'].type)
ck(Array.isArray(byId['133'].options) && byId['133'].options[0] === 'made', 'C3 选项带出', JSON.stringify(byId['133'].options))
ck(Array.isArray(byId['133'].answer) && byId['133'].answer[0] === 0, 'C4 答案下标带出', JSON.stringify(byId['133'].answer))
ck(byId['133'].found === true, 'C5 found=true 表示题面取到')
// 题库为空 / 不传 → 不能崩，且全部标 found=false
const wEmpty = dashUserWrongList(rowB, [])
ck(wEmpty.total === 3, 'C6 题库为空仍统计条数（不抛错）', String(wEmpty.total))
ck(wEmpty.missing === 3, 'C7 题库为空 → 全部 missing', String(wEmpty.missing))
ck(wEmpty.found === 0, 'C8 found=0', String(wEmpty.found))
const wUndef = dashUserWrongList(rowB)
ck(wUndef.total === 3, 'C9 不传题库参数也不崩', String(wUndef.total))
ck(dashUserWrongList({}, QUESTIONS).total === 0, 'C10 无 chQ/perQ 字段 → 0（旧账号兼容）')
ck(dashUserWrongList(null, QUESTIONS).total === 0, 'C11 row=null → 0（不崩）')

console.log('\n=== [D] 取不到题面的 qid 不静默丢弃 ===')
const rowD = { username: 'u3', chQ: {}, perQ: { '8888': { correct: 0, total: 2 }, '133': { correct: 0, total: 1 } } }
const wD = dashUserWrongList(rowD, QUESTIONS)
ck(wD.total === 2, 'D1 找不到题干的那道仍计入 total', String(wD.total))
ck(wD.missing === 1, 'D2 missing 单独计数', String(wD.missing))
ck(wD.found === 1, 'D3 found 只算对上的', String(wD.found))
const missItem = wD.practice.filter(x => x.qid === '8888')[0]
ck(!!missItem && missItem.found === false, 'D4 缺失项 found=false（留给渲染层提示）')
ck(!!missItem && missItem.wrong === 2, 'D5 缺失项仍保留错次', missItem ? String(missItem.wrong) : 'none')

console.log('\n=== [E] 排序：错次降序 + qid 稳定，绝不编造时间序 ===')
const rowE = {
  username: 'u4',
  chQ: { u1902: { correct: 0, total: 1 } },
  perQ: { '133': { correct: 0, total: 7 }, '136': { correct: 0, total: 2 }, '8041': { correct: 0, total: 2 } },
}
const wE = dashUserWrongList(rowE, QUESTIONS)
ck(wE.practice[0].qid === '133', 'E1 错得最多的排第一', wE.practice.map(x => x.qid + ':' + x.wrong).join(' '))
ck(wE.practice[1].wrong === 2 && wE.practice[2].wrong === 2, 'E2 同次数并列其次')
ck(wE.practice[1].qid < wE.practice[2].qid, 'E3 同次数按 qid 稳定排序（可复现）',
  wE.practice.map(x => x.qid).join(','))
// E4：用「抽出来的函数体」判，别用源码切片——切片会把后一个函数之前的注释也带进来（本轮实撞）
const fnBodyE = codeOnly(extractFn(APP, 'dashUserWrongList'))
ck(!/\bat\b|\btime\b|\bts\b|sortAt|Date\.now/.test(fnBodyE),
  'E4 聚合函数里不出现任何时间字段（云端没有，编不出来）',
  fnBodyE.length + ' 字符')

console.log('\n=== [F] 渲染：题型标签走 typeLabels ===')
const card = _upWrongCardHtml(wE.practice[0], 1)
ck(card.indexOf('错 7 次') > 0, 'F1 显示错次', '错 7 次')
ck(card.indexOf('made') > 0, 'F2 填空题显示参考答案（options[0]）')
ck(card.indexOf('单词填空') > 0, 'F3 题型标签来自 t(typeLabels)，不是原始 key')
ck(card.indexOf('typeFill') < 0, 'F4 不出现 typeFill 这类原始键名（t() 对未知键原样返回）')
ck(card.indexOf('核心句型填空') > 0, 'F5 题干正常渲染')
const cardXss = _upWrongCardHtml({ qid: '9', wrong: 1, question: '<img src=x onerror=alert(1)>', type: 'single', options: ['<b>a</b>'], answer: [0], found: true }, 1)
ck(cardXss.indexOf('<img') < 0 && cardXss.indexOf('&lt;img') > 0, 'F6 题干 HTML 被转义（防注入）')
ck(cardXss.indexOf('<b>') < 0, 'F7 选项 HTML 被转义')
const cardMiss = _upWrongCardHtml({ qid: '8888', wrong: 2, found: false }, 3)
ck(cardMiss.indexOf('8888') > 0, 'F8 缺失题面时回显 qid（能核对是哪道）')
ck(cardMiss.indexOf('题干已不在题库') > 0, 'F9 缺失题面有明确说明')
// listen / voicematch：选项是候选读音，只标出正确那一条
const cardVm = _upWrongCardHtml({ qid: '9011', wrong: 1, question: '黑松露牛肉粒。选出正确英文。', type: 'voicematch', options: ['wok-seared Australian beef fillet', 'poached Cantonese cabbage'], answer: [0], found: true }, 1)
ck(cardVm.indexOf('wok-seared') > 0 && cardVm.indexOf('poached') < 0,
  'F10 voicematch 只显示正确选项（不把干扰项也列出来）')
const cardNoAns = _upWrongCardHtml({ qid: '1', wrong: 1, question: 'q', type: 'single', options: [], answer: [], found: true }, 1)
ck(cardNoAns.indexOf('无标准答案') > 0, 'F11 无答案时明确提示（不显示空白）')

console.log('\n=== [F2] 分段渲染 ===')
const secEmpty = _upWrongSectionHtml({ challenge: [], practice: [], total: 0, missing: 0 })
ck(secEmpty.indexOf('没有错题记录') > 0, 'F12 无错题时出提示卡（不是空白）')
const sec = _upWrongSectionHtml(wE)
ck(sec.indexOf('七天挑战错题') > 0 && sec.indexOf('练习 / 考试错题') > 0, 'F13 两组标题都在')
ck(sec.indexOf('错 7 次') > 0, 'F14 卡片内容已渲染')
const secMiss = _upWrongSectionHtml(wD)
ck(secMiss.indexOf('另有 1 道题') > 0, 'F15 有缺失时给出缺失说明')
// 上限：超过 60 条只列 60 条并提示剩余
const many = []
for (let i = 0; i < 75; i++) many.push({ qid: 'q' + i, wrong: 1, question: 'x', type: 'single', options: [], answer: [], found: true })
const secMany = _upWrongSectionHtml({ challenge: [], practice: many, total: 75, missing: 0 })
ck((secMany.match(/错 1 次/g) || []).length === 60, 'F16 最多列 60 条（避免弹窗卡死）',
  String((secMany.match(/错 1 次/g) || []).length))
ck(secMany.indexOf('还有 15 道未列出') > 0, 'F17 超出部分明确告知剩余数量')

console.log('\n=== [G] 接线与 i18n ===')
ck(/function _upProfileHtml\(r, courseDoc, events, wrong\)/.test(APP_CODE), 'G1 _upProfileHtml 新增第 4 参 wrong')
ck(APP_CODE.indexOf('dashUserWrongList(r,') > 0, 'G2 档案弹窗传入 dashUserWrongList 结果')
ck(/Store\.getQuestions\(\)/.test(APP_CODE.slice(APP_CODE.indexOf('dashUserWrongList(r,') - 200, APP_CODE.indexOf('dashUserWrongList(r,') + 260)),
  'G3 题面来源 = Store.getQuestions()（题库唯一入口）')
ck(APP_CODE.indexOf('_upWrongSectionHtml(wrong)') > 0, 'G4 错题板块渲染进档案')
const i18nKeys = ['upWrongTitle', 'upWrongHint', 'upWrongNone', 'upWrongCh', 'upWrongPr', 'upWrongTimes', 'upWrongAnswer', 'upWrongMissing', 'upWrongNoAnswer']
const zhSec = I18N.slice(0, I18N.indexOf('  en:'))
const enSec = I18N.slice(I18N.indexOf('  en:'))
const missZh = i18nKeys.filter(k => zhSec.indexOf(k + ':') < 0)
const missEn = i18nKeys.filter(k => enSec.indexOf(k + ':') < 0)
ck(missZh.length === 0, 'G5 中文 i18n 键齐备', missZh.join(','))
ck(missEn.length === 0, 'G6 英文 i18n 键齐备', missEn.join(','))
// 带参文案必须是箭头函数（§全局契约：t() 只有函数值才插值）
ck(/upWrongTimes: \(n\) =>/.test(I18N), 'G7 upWrongTimes 是箭头函数（带参文案必须函数值）')
ck(/upWrongMissing: \(n\) =>/.test(I18N), 'G8 upWrongMissing 是箭头函数')
ck(!/upWrongTimes: '.*\{n\}.*'/.test(I18N), 'G9 没有把 {n} 写成字符串（那会原样显示）')
// 键名带引号 grep 须 0 命中（防止字符串里也写了键名导致断言假绿）
// ★ 必须剥注释后再查：源码注释里会**主动引用**键名（如「不要自造 typeSingle 这类键」），
//   直接对原文 grep 必然假红（§B 反证要看语境）
// ★ 判据修正：键名本来就该以 t('xxx') 形式出现，所以「出现过键名」不是问题。
//   真正要防的是「键名出现在 t() 之外」（比如误写成裸字符串、或拼进模板直接当文案用）。
//   做法：把每个 t('key') 调用整体剔除，剩下的代码里不应再出现这些键名。
const bareKeys = i18nKeys.filter(k => {
  const stripped = APP_CODE.replace(new RegExp("t\\(\\s*'" + k + "'[^)]*\\)", 'g'), '')
  return new RegExp("'" + k + "'").test(stripped) || new RegExp('"' + k + '"').test(stripped)
})
ck(bareKeys.length === 0, 'G10 键名只出现在 t() 调用中，没有裸字符串引用', bareKeys.join(','))

console.log('\n' + (fail === 0 ? '✅' : '❌') + ' v193 学员错题：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
