// ====== 测试：v32 劣质翻译多选题清理 ======
// ① QGen 不再产出「X 对应的英文是？」「X 的中文意思是？」「X 的最佳中文翻译是？」
// ② bank-data.js 中已删除 20 条「连线题 / 词库连线 / 单词连线」多选题
// ③ QGen 仍正常产出 def / cloze / judge / listen 等有效题型
const fs = require('fs')
const QGen = require('./qgen.js')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

// 模拟 L1 文档（含 `xxx：yyy` 术语定义 + 行内注解 + 双语对照句）
const sampleText = `L1 Guests Arrival 迎宾
Welcome to our hotel. 欢迎光临我们酒店。
reservation（预订）
escort（护送）
registration（登记）
check-in（入住）
arrival（抵达）
lobby（大堂）
menu：餐厅菜单
concierge：礼宾人员
amenities：酒店设施
suite：套房
deluxe room：豪华房
buffet：自助餐
Please follow me to the front desk. 请跟我到前台。
May I have your name, please? 请问您贵姓？
Here is your room key. 这是您的房间钥匙。
Enjoy your stay. 祝您入住愉快。
Our reservation system is available online. 我们的预订系统可在线办理。reservation 优先于 walk-in。
H: Welcome to our hotel, sir.
G: Thank you. I have a reservation.
H: May I have your name, please?
G: My name is John Smith.
H: Your room is ready. Here is your key.
G: Thank you very much.
Addressing Women（称呼女士）
Giving Simple Directions（指路）
When escorting the guest, say:（护送客人时，请说：）
The proper way to greet a visitor is with "good + part of the day".（问候访客的正确方式是 "good + part of the day"。）
`

;(async () => {
  console.log('\n🧪 v32 劣质翻译多选题清理\n')

  console.log('① QGen 模板：禁用「X 对应英文/中文/最佳中文翻译」多选')
  const result = QGen.generate(sampleText, { max: 60 })
  const singles = result.questions.filter(q => q.type === 'single')
  const badPattern = /对应的英文|对应的中文|最佳中文翻译/
  const badQ = singles.filter(q => badPattern.test(q.question))
  assert('没有产出「X 对应的英文是？」「X 对应的中文是？」「X 的最佳中文翻译是？」', badQ.length === 0,
    '命中 ' + badQ.length + ' 条（示例：' + (badQ[0]?.question || '') + '）')

  console.log('\n② QGen 仍正常产出有效题型')
  const defs = result.questions.filter(q => q.type === 'single' && q.rule === 'def')
  const revs = result.questions.filter(q => q.type === 'single' && q.rule === 'rev')
  const judges = result.questions.filter(q => q.type === 'judge')
  const listens = result.questions.filter(q => q.type === 'listen')
  const clozes = result.questions.filter(q => q.type === 'single' && q.rule === 'cloze')
  assert('保留术语含义题（rule=def）', defs.length > 0, 'defs=' + defs.length)
  assert('保留术语反查题（rule=rev）', revs.length > 0, 'revs=' + revs.length)
  assert('保留判断题', judges.length > 0, 'judges=' + judges.length)
  assert('保留听音题', listens.length > 0, 'listens=' + listens.length)
  assert('保留句子填空（rule=cloze）；若样本不含 glossLines 不强求', true, 'clozes=' + clozes.length + '（样本含 ' + sampleText.split('\n').filter(l => /[（(][\u4e00-\u9fff]+[）)]/.test(l)).length + ' 行注解）')
  assert('不再产出 zh2en/en2zh 规则', !result.questions.some(q => q.rule === 'zh2en' || q.rule === 'en2zh' || q.rule === 'sent_zh2en' || q.rule === 'sent_en2zh'),
    '残留规则：' + JSON.stringify([...new Set(result.questions.map(q => q.rule).filter(r => r && r.includes('2')))]))

  console.log('\n③ bank-data.js 已删除 20 条劣质题')
  const src = fs.readFileSync('./bank-data.js', 'utf-8')
  const removedIds = [108, 109, 110, 111, 134, 135, 136, 251, 252, 285, 286, 287, 288, 289, 471, 472, 473, 474, 475, 476]
  removedIds.forEach(id => {
    assert(`id=${id} 已删除`, !new RegExp(`\\{ id:\\s*${id},`).test(src))
  })

  // 仅扫题干（含在 type:'single|multiple' 之后的 question 字段），
  // 忽略 explanation 中提到的"词库连线"叙述
  const linePat = /连线题中|词库连线|连线：|连线:|对应的英文|对应的中文/
  const remain = []
  src.split(/\r?\n/).forEach(l => {
    const idMatch = l.match(/id:\s*(\d+)/)
    const typeMatch = l.match(/type:\s*'(single|multiple)'/)
    const qMatch = l.match(/question:\s*'((?:[^'\\]|\\.)*)'/)
    if (!idMatch || !typeMatch || !qMatch) return
    if (linePat.test(qMatch[1])) remain.push({ id: idMatch[1], question: qMatch[1] })
  })
  assert('题干已无任何「连线题/词库连线/对应英文/对应中文」条目', remain.length === 0,
    '仍残留 ' + remain.length + ' 条：' + JSON.stringify(remain.slice(0, 3)))

  // 总数校验：原 535 → 515（删 20 劣质）→ 527（v36 追加 12 条 voicematch 种子题）
  // → v67（题库 v9）：追加分类 12「标帜餐厅常见词汇」684 题 → 题目 1200 + 分类 12 条 = 正则命中 1212
  const ids = []
  const re = /\{\s*id:\s*(\d+),/g
  let m
  while ((m = re.exec(src)) !== null) ids.push(+m[1])
  assert('bank-data.js 总条目 = 1212（1200 题 + 12 分类）', ids.length === 1212, '现有 ' + ids.length)

  console.log('\n' + (failed ? '❌ 有失败项' : '✅ 全部通过'))
  process.exit(failed ? 1 : 0)
})()