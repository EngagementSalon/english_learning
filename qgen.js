// ====== QGen：课程文件 → 题目自动生成引擎（纯前端）======
// 支持解析 .docx / .pptx（ZIP + deflate-raw 解压 OOXML）/.pdf（PDF.js）/.txt/.md
// 规则化出题：术语含义 / 术语反查 / 中英互译 / 句子翻译 / 句子填空 / 概念判断 / 听音选义
// 输出题目格式与平台题库一致：{ type, difficulty, question, options, answer:[idx], explanation }
// 注意：生成结果仅供管理员预览勾选，题目内容保持中文（学习内容不翻译）

const QGen = {
  // ---------- 文件 → 文本 ----------
  async readText(file) {
    const name = String(file.name || '').toLowerCase()
    if (name.endsWith('.docx')) return this.docxToText(await file.arrayBuffer())
    if (name.endsWith('.pptx')) return this.pptxToText(await file.arrayBuffer())
    if (name.endsWith('.pdf')) return this.pdfToText(await file.arrayBuffer())
    if (name.endsWith('.txt') || name.endsWith('.md')) return await file.text()
    if (name.endsWith('.doc')) throw new Error(typeof t === 'function' ? t('qgenOldDoc') : 'old .doc')
    if (name.endsWith('.ppt')) throw new Error(typeof t === 'function' ? t('qgenOldPpt') : 'old .ppt')
    throw new Error(typeof t === 'function' ? t('qgenUnsupported') : 'unsupported')
  },

  // ---------- docx 解析 ----------
  async docxToText(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer)
    const td = new TextDecoder('utf-8')
    // 从尾部找 End of Central Directory 记录（0x06054b50）
    let eocd = -1
    for (let i = u8.length - 22; i >= 0; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break }
    }
    if (eocd < 0) throw new Error(typeof t === 'function' ? t('qgenBadDocx') : 'bad docx')
    const count = u8.length > eocd + 12 ? (u8[eocd + 10] | (u8[eocd + 11] << 8)) : 0
    let ptr = (u8[eocd + 16] | (u8[eocd + 17] << 8) | (u8[eocd + 18] << 16) | (u8[eocd + 19] << 24)) >>> 0
    for (let n = 0; n < count && ptr + 46 <= u8.length; n++) {
      if (((u8[ptr] | (u8[ptr + 1] << 8) | (u8[ptr + 2] << 16) | (u8[ptr + 3] << 24)) >>> 0) !== 0x02014b50) break
      const method = u8[ptr + 10] | (u8[ptr + 11] << 8)
      const compSize = (u8[ptr + 20] | (u8[ptr + 21] << 8) | (u8[ptr + 22] << 16) | (u8[ptr + 23] << 24)) >>> 0
      const nameLen = u8[ptr + 28] | (u8[ptr + 29] << 8)
      const extraLen = u8[ptr + 30] | (u8[ptr + 31] << 8)
      const commLen = u8[ptr + 32] | (u8[ptr + 33] << 8)
      const localOff = (u8[ptr + 42] | (u8[ptr + 43] << 8) | (u8[ptr + 44] << 16) | (u8[ptr + 45] << 24)) >>> 0
      const name = td.decode(u8.subarray(ptr + 46, ptr + 46 + nameLen))
      if (name === 'word/document.xml') {
        const lNameLen = u8[localOff + 26] | (u8[localOff + 27] << 8)
        const lExtraLen = u8[localOff + 28] | (u8[localOff + 29] << 8)
        const start = localOff + 30 + lNameLen + lExtraLen
        const data = u8.subarray(start, start + compSize)
        const xml = method === 0 ? td.decode(data) : td.decode(await this._inflateRaw(data))
        return this._xmlToText(xml)
      }
      ptr += 46 + nameLen + extraLen + commLen
    }
    throw new Error(typeof t === 'function' ? t('qgenBadDocx') : 'docx entry not found')
  },

  async _inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unsupported')
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  },

  _xmlToText(xml) {
    return String(xml || '')
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  },

  // ---------- pptx 解析 ----------
  // PPTX 是 ZIP 格式，幻灯片文本在 ppt/slides/slide*.xml 的 <a:t> 标签内
  async pptxToText(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer)
    const td = new TextDecoder('utf-8')
    // 从尾部找 End of Central Directory 记录（0x06054b50）
    let eocd = -1
    for (let i = u8.length - 22; i >= 0; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break }
    }
    if (eocd < 0) throw new Error(typeof t === 'function' ? t('qgenBadPptx') : 'bad pptx')
    const count = u8.length > eocd + 12 ? (u8[eocd + 10] | (u8[eocd + 11] << 8)) : 0
    let ptr = (u8[eocd + 16] | (u8[eocd + 17] << 8) | (u8[eocd + 18] << 16) | (u8[eocd + 19] << 24)) >>> 0

    // 收集所有 slide*.xml 条目
    const slideEntries = []  // { num, method, compSize, localOff }
    for (let n = 0; n < count && ptr + 46 <= u8.length; n++) {
      if (((u8[ptr] | (u8[ptr + 1] << 8) | (u8[ptr + 2] << 16) | (u8[ptr + 3] << 24)) >>> 0) !== 0x02014b50) break
      const method = u8[ptr + 10] | (u8[ptr + 11] << 8)
      const compSize = (u8[ptr + 20] | (u8[ptr + 21] << 8) | (u8[ptr + 22] << 16) | (u8[ptr + 23] << 24)) >>> 0
      const nameLen = u8[ptr + 28] | (u8[ptr + 29] << 8)
      const extraLen = u8[ptr + 30] | (u8[ptr + 31] << 8)
      const commLen = u8[ptr + 32] | (u8[ptr + 33] << 8)
      const localOff = (u8[ptr + 42] | (u8[ptr + 43] << 8) | (u8[ptr + 44] << 16) | (u8[ptr + 45] << 24)) >>> 0
      const entryName = td.decode(u8.subarray(ptr + 46, ptr + 46 + nameLen))
      // 匹配 ppt/slides/slideN.xml
      const sm = entryName.match(/^ppt\/slides\/slide(\d+)\.xml$/i)
      if (sm) slideEntries.push({ num: parseInt(sm[1], 10), method, compSize, localOff })
      ptr += 46 + nameLen + extraLen + commLen
    }

    if (!slideEntries.length) throw new Error(typeof t === 'function' ? t('qgenBadPptx') : 'no slides in pptx')
    slideEntries.sort((a, b) => a.num - b.num)

    // 逐页提取文本
    const parts = []
    for (const e of slideEntries) {
      const lNameLen = u8[e.localOff + 26] | (u8[e.localOff + 27] << 8)
      const lExtraLen = u8[e.localOff + 28] | (u8[e.localOff + 29] << 8)
      const start = e.localOff + 30 + lNameLen + lExtraLen
      const data = u8.subarray(start, start + e.compSize)
      const xml = e.method === 0 ? td.decode(data) : td.decode(await this._inflateRaw(data))
      // 提取 <a:t> 标签内的文本，用换行连接
      const texts = []
      let m
      const re = /<a:t>([\s\S]*?)<\/a:t>/g
      while ((m = re.exec(xml)) !== null) {
        const txt = m[1]
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&')
          .trim()
        if (txt) texts.push(txt)
      }
      if (texts.length) parts.push(texts.join('\n'))
    }
    return parts.join('\n\n')
  },

  // ---------- pdf 解析（动态加载 PDF.js） ----------
  async pdfToText(arrayBuffer) {
    // 动态加载 PDF.js（仅首次调用时）
    if (!this._pdfjsReady) {
      await this._loadPdfjs()
    }
    const pdfjs = window.pdfjsLib || window['pdfjs-dist/build/pdf']
    const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise
    const parts = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      // 按 Y 坐标分组重建行
      const items = content.items.filter(it => it.str && it.str.trim())
      if (!items.length) continue
      let lines = []
      let curY = null
      let curLine = []
      items.forEach(it => {
        const y = Math.round(it.transform[5])
        if (curY === null || Math.abs(y - curY) <= 3) {
          curLine.push(it.str)
          curY = y
        } else {
          if (curLine.length) lines.push(curLine.join(''))
          curLine = [it.str]
          curY = y
        }
      })
      if (curLine.length) lines.push(curLine.join(''))
      parts.push(lines.join('\n'))
    }
    return parts.join('\n\n')
  },

  async _loadPdfjs() {
    if (this._pdfjsLoading) return this._pdfjsLoading
    this._pdfjsLoading = (async () => {
      // 使用 CDN 加载 PDF.js legacy UMD 构建
      const src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
      await new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = src
        s.onload = resolve
        s.onerror = () => reject(new Error(typeof t === 'function' ? t('qgenPdfLoadFail') : 'pdf.js load fail'))
        document.head.appendChild(s)
      })
      // 设置 worker
      const pdfjs = window.pdfjsLib
      if (pdfjs && pdfjs.GlobalWorkerOptions) {
        pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
      }
      this._pdfjsReady = true
    })()
    return this._pdfjsLoading
  },

  // ---------- 规则化出题 ----------
  // 返回 { questions: [...], info: { lines, defs, pairs, sentPairs, glossLines, reason, generated } }
  //   reason: 'ok' | 'empty' | 'no_pattern' | 'insufficient_pool'
  // opt.max: 生成上限；opt.target: { single:N, judge:N, listen:N } 按题型配额（0=不要该类，三者均缺省=混出）
  generate(text, opt) {
    opt = opt || {}
    const max = opt.max || 40
    const cjkCount = s => (String(s).match(/[\u4e00-\u9fff]/g) || []).length
    const cjkRatio = s => cjkCount(s) / Math.max(1, s.length)
    const isMostlyCjk = s => cjkRatio(s) > 0.25
    const isMostlyLatin = s => {
      const cjk = cjkCount(s)
      const lat = (s.match(/[A-Za-z]/g) || []).length
      return lat > 0 && cjk < s.length * 0.25
    }

    // 行清洗：去掉对话标签(H:/G:/H1:)、项目符号、编号前缀
    const stripLabel = s => s.replace(/^[HG]\d*:\s*/i, '').trim()
    const isNoise = s => /^[A-Z]$/i.test(s) || /^\d+$/.test(s)
    const lines = String(text || '').split(/\r?\n/)
      .map(s => s.trim())
      .map(stripLabel)
      .filter(s => s.length >= 4 && s.length <= 300 && !isNoise(s))

    if (!lines.length) {
      return { questions: [], info: { lines: 0, defs: 0, pairs: 0, sentPairs: 0, glossLines: 0, reason: 'empty', generated: 0 } }
    }

    // ======== 1. 行内注解提取：word（中文）出现在行中任意位置 ========
    // 匹配：单词或多词专有名词(首字母大写)紧跟（中文）
    const pairs = []
    const glossRe = /([A-Za-z][A-Za-z\-']*(?:\s[A-Z][A-Za-z\-']*){0,3})[（(]([\u4e00-\u9fff][\u4e00-\u9fff、，,·]{0,20})[）)]/g
    const glossLines = []  // 含注解的行，去掉注解后用于填空
    lines.forEach(l => {
      let m
      glossRe.lastIndex = 0
      let found = false
      while ((m = glossRe.exec(l)) !== null) {
        const en = m[1].trim()
        const zh = m[2].trim()
        if (en.length >= 2 && zh.length >= 2) { pairs.push({ en, zh }); found = true }
      }
      if (found) {
        const stripped = l.replace(/[（(][\u4e00-\u9fff、，,·\s]{2,24}[）)]/g, '').trim()
        if (stripped.length >= 10 && stripped.length <= 150) glossLines.push(stripped)
      }
    })

    // ======== 2. 双语对照句提取：英文行 → 下一行中文翻译 ========
    const sentPairs = []
    for (let i = 0; i < lines.length - 1; i++) {
      const cur = lines[i], next = lines[i + 1]
      if (isMostlyLatin(cur) && isMostlyCjk(next) && cur.length >= 6 && next.length >= 4) {
        sentPairs.push({ en: cur, zh: next })
        i++ // 跳过已配对的中文行
      }
    }

    // ======== 3. 传统术语/词对提取（兼容其他文档格式）========
    const defs = []
    let m
    lines.forEach(l => {
      if ((m = l.match(/^([^：:，。！？、]{2,18})[：:]\s*(.{2,120})$/)) && !/[：:]/.test(m[1])) {
        const term = m[1].trim(), def = m[2].trim()
        if (cjkCount(def) >= 2 && term !== def) { defs.push({ term, def }); return }
      }
      if ((m = l.match(/^([^，。！？、]{2,18})\s*(?:是指|指的是|意思是|意为|即|叫做|称为|译为|翻译为|译作)\s*(.{2,120})$/))) {
        const term = m[1].trim(), def = m[2].trim().replace(/[。]$/, '')
        if (cjkCount(def) >= 2 && term !== def) { defs.push({ term, def }); return }
      }
      if ((m = l.match(/^([^——，。！？、]{2,18})[——]+\s*(.{2,120})$/))) {
        const term = m[1].trim(), def = m[2].trim().replace(/[。]$/, '')
        if (cjkCount(def) >= 2 && term !== def) { defs.push({ term, def }); return }
      }
      if ((m = l.match(/^([A-Za-z][A-Za-z\-'’ ]{1,28})[（(]([^（）()]{2,24})[）)]$/))) {
        pairs.push({ en: m[1].trim(), zh: m[2].trim() }); return
      }
      if ((m = l.match(/^([\u4e00-\u9fff]{2,16})[（(]([A-Za-z][A-Za-z\-'’ ]{1,28})[）)]$/))) {
        pairs.push({ en: m[2].trim(), zh: m[1].trim() }); return
      }
      if ((m = l.match(/^([A-Za-z][A-Za-z\-'’ ]{1,28}?)\s{1,4}([\u4e00-\u9fff][\u4e00-\u9fff、，,·]{1,28})$/))) {
        pairs.push({ en: m[1].trim(), zh: m[2].trim() }); return
      }
    })

    // 去重
    const uniqBy = (arr, key) => {
      const seen = new Set(); const out = []
      arr.forEach(x => { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x) } })
      return out
    }
    const D = uniqBy(defs, x => x.term)
    const P = uniqBy(pairs, x => x.en.toLowerCase())
    const SP = uniqBy(sentPairs, x => x.en.toLowerCase())

    if (!D.length && !P.length && !SP.length) {
      return { questions: [], info: { lines: lines.length, defs: 0, pairs: 0, sentPairs: 0, glossLines: 0, reason: 'no_pattern', generated: 0 } }
    }

    const qs = []
    const usedQ = new Set()
    const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[b[i], b[j]] = [b[j], b[i]] } return b }

    const mkSingle = (question, correct, pool, explanation, rule, diff) => {
      if (!pool || pool.length < 2) return
      const wantN = Math.min(4, pool.length)
      const distractors = shuffle(pool.filter(x => x !== correct)).slice(0, wantN - 1)
      const opts = [...new Set([correct, ...distractors])]
      if (opts.length < 2) return
      if (usedQ.has(question)) return
      usedQ.add(question)
      const arr = shuffle(opts)
      qs.push({ type: 'single', difficulty: diff || 1, question, options: arr, answer: [arr.indexOf(correct)], explanation, rule })
    }

    // 听音选义：question=英文(被TTS朗读，不显示)，options=中文释义，answer=[索引]
    const mkListen = (enWord, correctZh, pool, explanation, rule, diff) => {
      if (!pool || pool.length < 2) return
      const wantN = Math.min(4, pool.length)
      const distractors = shuffle(pool.filter(x => x !== correctZh)).slice(0, wantN - 1)
      const opts = [...new Set([correctZh, ...distractors])]
      if (opts.length < 2) return
      const key = 'listen:' + enWord.toLowerCase()
      if (usedQ.has(key)) return
      usedQ.add(key)
      const arr = shuffle(opts)
      qs.push({ type: 'listen', difficulty: diff || 1, question: enWord, options: arr, answer: [arr.indexOf(correctZh)], explanation, rule })
    }

    // 看字选音（voicematch）：question=英文文字(直接显示)，options=若干段英文文本(仅用于TTS朗读，作答时不暴露文字)，
    // 正确选项 = 朗读内容与题干文字一致的那一项（与 listen 恰好相反：题干可见、选项靠听）
    const mkVoiceMatch = (enText, poolAll, explanation, diff) => {
      if (!poolAll || poolAll.length < 2) return
      const text = String(enText || '').trim()
      if (!text || text.length > 70) return
      const pool = poolAll.filter(x => x && String(x).trim().toLowerCase() !== text.toLowerCase())
      const wantN = Math.min(4, pool.length + 1)
      const distractors = shuffle(pool).slice(0, wantN - 1)
      const opts = [...new Set([text, ...distractors])]
      if (opts.length < 2) return
      const key = 'voicematch:' + text.toLowerCase()
      if (usedQ.has(key)) return
      usedQ.add(key)
      const arr = shuffle(opts)
      qs.push({ type: 'voicematch', difficulty: diff || 1, question: text, options: arr, answer: [arr.indexOf(text)], explanation, rule: 'voicematch' })
    }

    // --- 1. 术语含义 / 反查 ---
    D.forEach(d => {
      mkSingle(`「${d.term}」指的是什么？`, d.def, D.map(x => x.def), `原文：${d.term}：${d.def}`, 'def')
      if (d.def.length <= 40)
        mkSingle(`下列哪个术语的含义是「${d.def}」？`, d.term, D.map(x => x.term), `原文：${d.term}：${d.def}`, 'rev')
    })

    // --- 2. 词汇翻译（行内注解 + 整行词对） ---
    // 注：「X 对应的英文是？」/「X 的中文意思是？」这类多选题会被停用：
    //     池子里混杂了章节标题（如 "Addressing Women"）等同形异义条目，
    //     干扰项与题干语义无关，学员一眼能蒙对却学不到东西。
    //     改用「术语含义/反查」（section 1）覆盖词汇理解，「判断题」（section 5）覆盖翻译辨析。
    const enPool = P.map(x => x.en)
    const zhPool = P.map(x => x.zh)  // 仍供 section 6 听音题做干扰项池

    // --- 3. 句子翻译（双语对照句） ---
    // 同上：停用「「整句」的最佳中文翻译是？」「「整句」对应的英文是？」多选题，
    //     干扰项会从 SP 池里随机抽到风格迥异的不相关句子。
    //     双语对照句仍然进入 `pairs` 与 `defs`，供 section 1/5/6 使用。

    // --- 4. 句子填空（从含注解的行中挖空词汇） ---
    const clozeTerms = enPool.filter(e => e.length >= 3)
    const clozeTried = new Set()
    glossLines.forEach(line => {
      if (clozeTried.size >= 10) return
      for (const w of shuffle(clozeTerms)) {
        const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
        if (re.test(line) && line.length - w.length >= 6) {
          const blanked = line.replace(re, '____')
          if (blanked.length <= 120 && !clozeTried.has(blanked)) {
            const p = P.find(x => x.en === w)
            mkSingle(`选择填空：${blanked}`, w, clozeTerms, `原文中：${w}（${p ? p.zh : ''}）`, 'cloze', 2)
            clozeTried.add(blanked)
          }
          break
        }
      }
    })

    // --- 5. 判断题 ---
    const judgeQ = (question, isTrue, explanation) => {
      if (usedQ.has(question)) return
      usedQ.add(question)
      qs.push({ type: 'judge', difficulty: 1, question, options: ['正确', '错误'], answer: [isTrue ? 0 : 1], explanation, rule: 'judge' })
    }
    D.forEach((d, i) => {
      judgeQ(`判断：「${d.term}」是指${d.def}。`, true, `原文：${d.term}：${d.def}`)
      if (D.length >= 2) {
        const other = D[(i + 1) % D.length]
        if (other && other.term !== d.term && !d.def.includes(other.term))
          judgeQ(`判断：「${other.term}」是指${d.def}。`, false, `原文中「${other.term}」并非此含义。${other.term}：${other.def}`)
      }
    })
    P.forEach((p, i) => {
      if (P.length >= 2) {
        const other = P[(i + 1) % P.length]
        if (other && other.zh !== p.zh)
          judgeQ(`判断：「${p.en}」的中文是「${other.zh}」。`, false, `原文：${p.en}（${p.zh}），不是「${other.zh}」。`)
      }
    })
    SP.forEach((sp, i) => {
      if (SP.length >= 2) {
        const other = SP[(i + 2) % SP.length]
        if (other && other.zh !== sp.zh && sp.en.length <= 50)
          judgeQ(`判断：「${sp.en}」的中文翻译是「${other.zh}」。`, false, `原文：${sp.en} → ${sp.zh}，不是「${other.zh}」。`)
      }
    })

    // --- 6. 听音选义（从词对生成：朗读英文，选中文意思）---
    P.forEach(p => {
      mkListen(p.en, p.zh, zhPool, `原文：${p.en}（${p.zh}）`, 'listen')
    })

    // --- 7. 看字选音（voicematch：题干显示英文文字，选项朗读不同英文，选与题干读音一致的一项）---
    // 词对 → 单词级；双语对照句 → 句子级（朗读文本过长会拖慢做题，限 ≤60 字符）
    P.forEach(p => {
      mkVoiceMatch(p.en, enPool, `原文：${p.en}（${p.zh}）`, p.en.length >= 10 ? 2 : 1)
    })
    const spEnPool = SP.map(x => x.en).filter(Boolean)
    SP.forEach(sp => {
      if (sp.en && sp.en.length <= 60) mkVoiceMatch(sp.en, spEnPool, `原文：${sp.en} → ${sp.zh}`, 2)
    })

    // 按题型配额出题：opt.target = { single:N, judge:N, listen:N, voicematch:N }（N 为期望题数，0/缺省=不产出该类）
    // 仅当四类中至少一类 >0 时启用配额；否则维持原逻辑：全类型混出后随机截取前 max 题
    let result
    const tgt = (opt.target && typeof opt.target === 'object') ? opt.target : null
    const hasQuota = tgt && ['single', 'judge', 'listen', 'voicematch'].some(k => Number(tgt[k]) > 0)
    if (hasQuota) {
      const buckets = { single: [], judge: [], listen: [], voicematch: [] }
      qs.forEach(q => { if (buckets[q.type]) buckets[q.type].push(q) })
      const out = []
      // 按 单选 → 判断 → 听音 → 看字选音 分组输出，同组内部随机，方便预览核对各类占比
      ;['single', 'judge', 'listen', 'voicematch'].forEach(k => {
        const n = Number(tgt[k]) > 0 ? Number(tgt[k]) : 0
        if (n) out.push(...shuffle(buckets[k]).slice(0, n))
      })
      result = out
    } else {
      result = shuffle(qs).slice(0, max)
    }
    const reason = !result.length ? 'insufficient_pool' : 'ok'
    return {
      questions: result,
      info: { lines: lines.length, defs: D.length, pairs: P.length, sentPairs: SP.length, glossLines: glossLines.length, reason, generated: result.length }
    }
  }
}

// Node 测试环境导出（浏览器中忽略）
if (typeof module !== 'undefined' && module.exports) module.exports = QGen
