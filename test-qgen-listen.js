// 测试 QGen 生成 listen 题目
const fs = require('fs'), vm = require('vm')
const QGen = require('./qgen.js')

let pass = 0, fail = 0
function ok(name, cond) { if (cond) { pass++; console.log('  ok ' + name) } else { fail++; console.log('  FAIL ' + name) } }

// ====== 模拟 L1 Guests Arrival 文档内容 ======
const sampleText = `L1 Guests Arrival 迎宾
Welcome to our hotel. 欢迎光临我们酒店。
May I help you? 我能帮您吗？
reservation（预订）
escort（护送）
registration（登记）
check-in（入住）
arrival（抵达）
lobby（大堂）
Please follow me to the front desk. 请跟我到前台。
May I have your name, please? 请问您贵姓？
Here is your room key. 这是您的房间钥匙。
Enjoy your stay. 祝您入住愉快。
concierge（礼宾）
suite（套房）
deluxe room（豪华房）
buffet（自助餐）
amenities（设施）
H: Welcome to our hotel, sir.
G: Thank you. I have a reservation.
H: May I have your name, please?
G: My name is John Smith.
H: Your room is ready. Here is your key.
G: Thank you very much.
`

const result = QGen.generate(sampleText, { max: 60 })

console.log('== QGen 听音题生成测试 ==')
console.log('  总生成题数:', result.info.generated)
console.log('  词对数:', result.info.pairs)
console.log('  双语句对:', result.info.sentPairs)
console.log('  reason:', result.info.reason)

const listenQs = result.questions.filter(q => q.type === 'listen')
console.log('  listen 题数:', listenQs.length)

ok('reason = ok', result.info.reason === 'ok')
ok('生成了 listen 题', listenQs.length > 0)
ok('listen 题数 > 0', listenQs.length >= 1)

// 验证每道 listen 题结构
let structBad = 0
listenQs.forEach(q => {
  if (!q.question || q.question.length < 2) structBad++        // question = 英文单词
  if (!Array.isArray(q.options) || q.options.length < 2) structBad++
  if (!Array.isArray(q.answer) || q.answer.length !== 1) structBad++
  if (!q.options[q.answer[0]]) structBad++
  // 正确答案应该是中文（含汉字）
  const correctOpt = q.options[q.answer[0]]
  if (!/[\u4e00-\u9fff]/.test(correctOpt)) structBad++
  // question 应该是英文（不含汉字）
  if (/[\u4e00-\u9fff]/.test(q.question)) structBad++
  // 干扰项也应该是中文
  q.options.forEach(opt => {
    if (!/[\u4e00-\u9fff]/.test(opt)) structBad++
  })
})
ok('所有 listen 题结构合法（英文题干+中文选项）', structBad === 0)

// 验证选项不重复
let dupBad = 0
listenQs.forEach(q => {
  const set = new Set(q.options)
  if (set.size !== q.options.length) dupBad++
})
ok('listen 题选项无重复', dupBad === 0)

// 验证每道 listen 题的正确答案确实是对应词的中文
// 抽样检查：reservation 的 listen 题正确答案应该是"预订"
const resvQ = listenQs.find(q => q.question.toLowerCase() === 'reservation')
ok('reservation 的 listen 题正确答案是"预订"', resvQ && resvQ.options[resvQ.answer[0]] === '预订')

// 验证 listen 题和其他题型共存
const singleQs = result.questions.filter(q => q.type === 'single')
const judgeQs = result.questions.filter(q => q.type === 'judge')
ok('同时生成了 single 题', singleQs.length > 0)
ok('同时生成了 judge 题', judgeQs.length > 0)

// 验证 listen 题的 explanation 包含原文
let explBad = 0
listenQs.forEach(q => {
  if (!q.explanation || !q.explanation.includes('原文')) explBad++
})
ok('listen 题 explanation 含原文', explBad === 0)

// 验证 rule 标记
let ruleBad = 0
listenQs.forEach(q => {
  if (q.rule !== 'listen') ruleBad++
})
ok('listen 题 rule = listen', ruleBad === 0)

console.log('\n结果: ' + pass + ' 通过 ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
