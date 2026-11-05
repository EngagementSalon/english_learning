// ====== v203 回归：错题回顾轮多选题（日照现场实报）======
// 现场症状：日照学员在错题重做（回顾轮）遇多选题 → 点第二个选项会顶掉第一个、
//   永远凑不齐答案，交卷后恒判错 → 回顾轮「刷到全对才完成」死循环（感知为无法提交），
//   刷新逃离。真因：v198 只修了主流程 chPick，回顾轮 chReviewPick 仍按单值写入。
// 覆盖：① 源码契约（回顾轮多选分支 + 空数组守卫 + v198 主流程不回归）
//       ② 行为沙箱（多选累积/取消/空数组守卫/对错提交/单选型不回归）
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
const APP = fs.readFileSync(path.join(D, 'app.js'), 'utf-8')

// extractFn：词边界匹配 + 花括号深度归零（对齐 test-v89 契约；优先匹配 async function 前缀的教训在此不适用——本套全是普通函数）
function extractFn(src, name) {
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

console.log('\n=== [A] 源码契约 ===')
const pickSrc = extractFn(CH, 'chReviewPick')
ok('A1 chReviewPick 含多选分支（safeQType === multiple）', pickSrc.indexOf("safeQType(q) === 'multiple'") >= 0)
ok('A2 chReviewPick 数组累积/取消（indexOf/push/filter）',
  pickSrc.indexOf('arr.indexOf(i) >= 0') >= 0 && pickSrc.indexOf('arr.push(i)') >= 0 && pickSrc.indexOf("arr.filter(x => x !== i)") >= 0)
ok('A3 chReviewPick 写入目标 = reviewAnswers（不是 answers）', pickSrc.indexOf('chs.reviewAnswers[chs.reviewIdx]') >= 0 && pickSrc.indexOf('chs.answers') < 0)
ok('A4 chReviewPick 走 renderChallengeReview（非 renderChallengeQuiz）',
  pickSrc.indexOf('renderChallengeReview()') >= 0 && pickSrc.indexOf('renderChallengeQuiz') < 0)
const subSrc = extractFn(CH, 'chReviewSubmit')
ok('A5 chReviewSubmit 空数组 = 未答守卫（v203）', subSrc.indexOf('Array.isArray(ans) && !ans.length') >= 0)
ok('A6 chReviewSubmit 保留 -1/undefined 守卫', subSrc.indexOf('ans === undefined || ans === -1') >= 0)
const chPickSrc = extractFn(CH, 'chPick')
ok('A7 v198 主流程 chPick 多选分支不回归', chPickSrc.indexOf("safeQType(q) === 'multiple'") >= 0 && chPickSrc.indexOf('chs.answers[chs.index] = arr.sort((a, b) => a - b)') >= 0)
const optSrc = extractFn(CH, 'chOptionsHtml')
ok('A8 v198 渲染层选中态按数组/单值（不回归）', optSrc.indexOf('Array.isArray(ans) ? ans.indexOf(i) >= 0 : ans === i') >= 0)
ok('A9 回顾轮渲染传 pickFn=chReviewPick', /renderChallengeReview[\s\S]{0,3000}chOptionsHtml\(q, submitted, chs\.reviewAnswers\[chs\.reviewIdx\], 'chReviewPick'\)/.test(CH))
ok('A10 主流程渲染传 pickFn=chPick（不回归）', /chOptionsHtml\(q, submitted, chs\.answers\[chs\.index\], 'chPick'\)/.test(CH))

// ---- 行为沙箱 ----
console.log('\n=== [B] 行为：多选累积/取消（bug 现场）===')
function makeSandbox() {
  const sb = { console, Date, Math, JSON }
  sb.Store = { addProgress: function (rec) { sb.__progress.push(rec) } }
  sb.__progress = []
  sb.__renders = { review: 0, quiz: 0 }
  vm.createContext(sb)
  vm.runInContext(extractFn(APP, 'visibleOptionIndexes') + '\n' + extractFn(APP, 'safeQType') + '\n' +
    extractFn(APP, 'checkAnswer') + '\n' +
    extractFn(CH, 'chReviewPick') + '\n' + extractFn(CH, 'chReviewSubmit') + '\n' +
    'function renderChallengeReview(){ __renders.review++ }\n' +
    'function renderChallengeQuiz(){ __renders.quiz++ }\n', sb)
  return sb
}
const MQ = { id: 10500, category_id: 13, dept: 'rooms/styling', type: 'multiple', difficulty: 2,
  question: '以下哪些属于「行李与寄存」？（多选）', options: ['Lobby', 'Baggage', 'Suitcase', 'Passport'],
  answer: [0, 1, 2], explanation: 'x' }
const JQ = { id: 10003, category_id: 13, dept: 'rooms/concierge', type: 'judge', difficulty: 1,
  question: '「大堂」的英文是 Suitcase。', options: ['正确', '错误'], answer: [1], explanation: 'x' }

const sb = makeSandbox()
vm.runInContext('chs = { phase: "review", reviewQs: [MQ], reviewIdx: 0, reviewAnswers: [-1], reviewSubmitted: false, reviewWrongNow: [], correctCount: 0, questions: [MQ], kind: "practice", day: 3, si: 1 }'.replace(/MQ/g, JSON.stringify(MQ)), sb)
const getAns = () => vm.runInContext('chs.reviewAnswers[0]', sb)
vm.runInContext('chReviewPick(0)', sb)
ok('B1 点第 1 项 → [0]', JSON.stringify(getAns()) === '[0]', JSON.stringify(getAns()))
vm.runInContext('chReviewPick(2)', sb)
ok('B2 点第 2 项 → [0,2]（修复现场：不再顶掉）', JSON.stringify(getAns()) === '[0,2]', JSON.stringify(getAns()))
vm.runInContext('chReviewPick(0)', sb)
ok('B3 再点已选项 → 取消 → [2]', JSON.stringify(getAns()) === '[2]', JSON.stringify(getAns()))
vm.runInContext('chReviewPick(1); chReviewPick(0)', sb)
ok('B4 乱序点击 → 升序归位 [0,1,2]（B3 残留 [2] 基础上累积）', JSON.stringify(getAns()) === '[0,1,2]', JSON.stringify(getAns()))

console.log('\n=== [C] 提交路径（空数组守卫 + 对/错判分）===')
// C1 空数组 = 未答 → 不提交
vm.runInContext('chs.reviewAnswers[0] = []; chs.reviewSubmitted = false', sb)
vm.runInContext('chReviewSubmit()', sb)
ok('C1 空数组不提交（reviewSubmitted 仍 false）', vm.runInContext('chs.reviewSubmitted', sb) === false)
ok('C2 空数组不产生 addProgress', sb.__progress.length === 0, String(sb.__progress.length))
// C3 未答 -1 → 不提交
vm.runInContext('chs.reviewAnswers[0] = -1; chs.reviewSubmitted = false', sb)
vm.runInContext('chReviewSubmit()', sb)
ok('C3 -1 不提交', vm.runInContext('chs.reviewSubmitted', sb) === false && sb.__progress.length === 0)
// C4 全对提交
vm.runInContext('chs.reviewAnswers[0] = [0,1,2]; chs.reviewSubmitted = false; chs.reviewWrongNow = []', sb)
vm.runInContext('chReviewSubmit()', sb)
const p4 = sb.__progress[sb.__progress.length - 1] || {}
ok('C4 全对提交 → correct:true 且不入 reviewWrongNow',
  vm.runInContext('chs.reviewSubmitted', sb) === true && p4.correct === true && vm.runInContext('chs.reviewWrongNow.length', sb) === 0,
  JSON.stringify(p4))
// C5 错误组合提交
vm.runInContext('chs.reviewAnswers[0] = [0]; chs.reviewSubmitted = false; chs.reviewWrongNow = []', sb)
vm.runInContext('chReviewSubmit()', sb)
const p5 = sb.__progress[sb.__progress.length - 1] || {}
ok('C5 漏选提交 → correct:false 且入 reviewWrongNow',
  p5.correct === false && vm.runInContext('chs.reviewWrongNow[0] && chs.reviewWrongNow[0].id', sb) === MQ.id,
  JSON.stringify(p5))
// C6 addProgress 带题面字段（口径与 v72 一致）
ok('C6 addProgress 口径（question_id/category_id/type/challenge:true）',
  p5.question_id === MQ.id && p5.category_id === 13 && p5.type === 'multiple' && p5.challenge === true, JSON.stringify(p5))

console.log('\n=== [D] 单选型不回归 ===')
const sb2 = makeSandbox()
vm.runInContext('chs = ' + JSON.stringify({ phase: 'review', reviewQs: [JQ], reviewIdx: 0, reviewAnswers: [-1], reviewSubmitted: false, reviewWrongNow: [], correctCount: 0, questions: [JQ], kind: 'practice', day: 3, si: 1 }), sb2)
vm.runInContext('chReviewPick(1)', sb2)
ok('D1 judge 题 pick → 单值数字（非数组）', vm.runInContext('chs.reviewAnswers[0]', sb2) === 1)
vm.runInContext('chReviewSubmit()', sb2)
ok('D2 judge 提交 → 按原判分（选对 → 不入 reviewWrongNow）',
  vm.runInContext('chs.reviewSubmitted', sb2) === true && vm.runInContext('chs.reviewWrongNow.length', sb2) === 0)
// D3 渲染次数：每次 pick/submit 都重渲染回顾页（不串到主流程渲染器）
ok('D3 回顾轮只走 renderChallengeReview', sb2.__renders.review >= 2 && sb2.__renders.quiz === 0,
  'review=' + sb2.__renders.review + ' quiz=' + sb2.__renders.quiz)

console.log('\n=== 结果 ===')
console.log('通过 ' + pass + ' / 失败 ' + fail)
process.exit(fail ? 1 : 0)
