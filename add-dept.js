// 批量给 bank-data.js 的题目加 dept 字段
// 规则：category_id 11 (核心词汇综合) → dept: 'all'，其余 → dept: 'dining'
const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, 'bank-data.js')
let code = fs.readFileSync(file, 'utf-8')

// 找到 questions 数组开始位置
const qStart = code.indexOf('questions: [')
if (qStart < 0) { console.error('Cannot find questions array'); process.exit(1) }

// 逐行处理：在每条题目的 { id: xxx, category_id: YYY, 后面加 dept
// 题目行格式：{ id: 1, category_id: 1, type: 'single', ...
// listen 题格式：{ id: 501, category_id: 1, type: 'listen', ...
const lines = code.split('\n')
let modified = 0
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  // 匹配题目行：含 { id: N, category_id: M,
  const m = line.match(/^(\s*\{\s*id:\s*\d+,\s*category_id:\s*(\d+),\s*)/)
  if (m) {
    const prefix = m[1]
    const catId = Number(m[2])
    const dept = catId === 11 ? 'all' : 'dining'
    // 检查是否已有 dept 字段
    if (line.includes('dept:')) continue
    lines[i] = line.replace(prefix, prefix + `dept: '${dept}', `)
    modified++
  }
}

// 更新版本号
const oldVer = code.match(/version:\s*(\d+)/)
if (oldVer) {
  code = code.replace(/version:\s*\d+/, 'version: 6')
}

code = lines.join('\n')
fs.writeFileSync(file, code, 'utf-8')
console.log(`Modified ${modified} questions, version → 6`)
