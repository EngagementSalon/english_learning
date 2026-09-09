// ====== v63 工具：生成同源 TTS 音频包（tts/<key>.mp3）======
// 背景：部分学员网络/设备（微信 X5 等）访问不了有道/百度在线 TTS，且 WebView 无 speechSynthesis，
// 三路兜底全挂。题库中需要发音的文本是有限集合（listen/voicematch/pronounce），直接把音频
// 打包为同源静态文件——网站能打开就一定能发声。运行：node gen-tts.js（幂等，可重复跑）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// 与 app.js _ttsKey 保持一致：FNV-1a 32 位 hex + 文本长度
function ttsKey(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16) + '-' + s.length
}

// 1. 提取题库中所有需要发音的唯一文本
const sb = { console, window: {} }; sb.globalThis = sb; vm.createContext(sb)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
const BANK = vm.runInContext('BANK', sb)
const all = Object.values(BANK.questions || {}).flat()
const uniq = new Set()
all.forEach(q => {
  const t = String(q.question || '').trim()
  if (q.type === 'listen' || q.type === 'voicematch' || q.type === 'pronounce') {
    if (t) uniq.add(t)
    if (q.type === 'voicematch') (q.options || []).forEach(o => { const s = String(o || '').trim(); if (s) uniq.add(s) })
  }
})
const texts = [...uniq]
console.log('种子题库唯一发音文本:', texts.length)

// 2b. 附加来源：node gen-tts.js 题目导入模板.csv [...]（v55 上传模板格式；UTF-8/GBK 自动识别）
//     听音类（listen/听音选义、voicematch/看字选音、pronounce/跟读）的题干+选项也纳入音频包
function decodeSmart(buf) {
  const s = buf.toString('utf-8')
  return s.includes('\uFFFD') ? new TextDecoder('gbk').decode(buf) : s
}
for (const arg of process.argv.slice(2)) {
  if (!fs.existsSync(arg)) { console.error('跳过不存在的文件:', arg); continue }
  const rows = decodeSmart(fs.readFileSync(arg)).split(/\r?\n/).map(l => l.split(',').map(c => c.trim()))
  let add = 0
  rows.forEach((cols, i) => {
    if (i === 0 && /题型|type/i.test(cols[0] || '')) return
    const ty = (cols[0] || '').toLowerCase()
    const isAudio = /^(listen|voicematch|pronounce|听音|看字|跟读)/.test(ty) || /听音|看字选音|跟读/.test(cols[0] || '')
    if (!isAudio) return
    const q = cols[1]; if (q) { texts.push(q); add++ }
    for (let j = 2; j <= 7; j++) { const o = cols[j]; if (o && o !== '-' && o !== '正确答案') { texts.push(o); add++ } }
  })
  console.log('附加', arg, '→ 新增文本', add)
}
const finalTexts = [...new Set(texts.map(t => t.trim()).filter(Boolean))]
console.log('合计唯一发音文本:', finalTexts.length)

// 2. 逐个下载（有道英国音；并发 4，失败重试 1 次）
const OUT = path.join(__dirname, 'tts')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT)
async function dl(text) {
  const key = ttsKey(text)
  const file = path.join(OUT, key + '.mp3')
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) return 'skip'
  const clean = text.replace(/["'`]/g, '')
  const urls = [
    'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(clean) + '&type=1',
    'https://fanyi.baidu.com/gettts?lan=en&text=' + encodeURIComponent(text) + '&spd=3&source=web'
  ]
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of urls) {
      try {
        const r = await fetch(url)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length < 1024) throw new Error('too small: ' + buf.length)
        fs.writeFileSync(file, buf)
        return 'ok'
      } catch (e) {
        if (url === urls[urls.length - 1] && attempt === 1) { console.error('  FAIL:', text, '—', e.message); return 'fail' }
      }
    }
  }
}
;(async () => {
  let ok = 0, skip = 0, fail = 0
  const queue = [...texts]
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const t = queue.shift()
      const r = await dl(t)
      if (r === 'ok') { ok++; process.stdout.write('.') }
      else if (r === 'skip') skip++
      else fail++
    }
  }))
  console.log('\n下载完成: 新增', ok, '/ 跳过', skip, '/ 失败', fail)
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.mp3'))
  const totalKB = Math.round(files.reduce((s2, f) => s2 + fs.statSync(path.join(OUT, f)).size, 0) / 1024)
  console.log('音频包: ', files.length, '个文件,', totalKB, 'KB')
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: files.length }, null, 2))
  process.exit(fail > 0 ? 1 : 0)
})()
