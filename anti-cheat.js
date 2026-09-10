// ====== 作答防作弊：禁止切出页面 ======
// 监听 离开标签页 / 窗口失焦 / 鼠标移出页面 / 右键菜单 / 复制剪切 / 关闭刷新
// 每次违规计数 +1 并弹出警告；累计达到上限自动交卷（调用 onSubmit）
// 启用范围由作答流程控制：平台考试、线下课作业/测评（v39 起作业也启用）；练习不启用
// v65：管理员账号（role=admin）一律豁免 —— 管理员是试做/演示/排错，不挂监听、不计违规、不强制结束
const AntiCheat = (function () {
  let active = false
  let cfg = { maxViolations: 3, onViolation: null, onSubmit: null }
  let violations = 0
  let lastTs = 0        // 去抖：单次切屏可能同时触发 blur+visibilitychange，1500ms 内只计 1 次
  let overlay = null

  function tt(key, fallback) { try { const v = window.t ? t(key) : key; return v && v !== key ? v : fallback } catch (e) { return fallback } }

  // v65：当前会话是否为管理员。Store 未加载 / 无 session / 读取异常 → 返回 false（不豁免，保持原行为）
  function isAdminUser() {
    try {
      const S = (typeof Store !== 'undefined' && Store) || (typeof window !== 'undefined' && window.Store) || null
      if (!S) return false
      if (typeof S.isAdmin === 'function' && S.isAdmin()) return true
      if (typeof S.getSession === 'function') {
        const s = S.getSession()
        return !!(s && s.role === 'admin')
      }
    } catch (e) { /* ignore */ }
    return false
  }

  function showWarn(left) {
    removeOverlay()
    overlay = document.createElement('div')
    overlay.className = 'anticheat-overlay'
    overlay.innerHTML = `
      <div class="anticheat-modal">
        <div class="anticheat-icon">⚠️</div>
        <div class="anticheat-title">${tt('anticheatWarn', '检测到离开作答页面！')}</div>
        <div class="anticheat-desc">${tt('anticheatWarnDesc', left).replace('{n}', left)}</div>
        <button class="btn btn-primary" onclick="AntiCheat.dismiss()">${tt('anticheatAck', '我知道了')}</button>
      </div>`
    document.body.appendChild(overlay)
  }
  function showFinal() {
    removeOverlay()
    overlay = document.createElement('div')
    overlay.className = 'anticheat-overlay'
    overlay.innerHTML = `
      <div class="anticheat-modal">
        <div class="anticheat-icon">🚫</div>
        <div class="anticheat-title">${tt(cfg.finalKey || 'anticheatFinal', '多次切屏，本次作答已自动提交')}</div>
        <button class="btn btn-primary" onclick="AntiCheat.dismiss()">${tt('anticheatAck', '我知道了')}</button>
      </div>`
    document.body.appendChild(overlay)
  }
  function removeOverlay() { if (overlay) { overlay.remove(); overlay = null } }

  function dismiss() { removeOverlay(); try { window.focus() } catch (e) {} }

  function record() {
    if (!active) return
    const now = Date.now()
    if (now - lastTs < 1500) return   // 去抖：同一切屏动作只计一次
    lastTs = now
    violations++
    if (typeof cfg.onViolation === 'function') {
      try { cfg.onViolation(violations) } catch (e) {}
    }
    const left = Math.max(0, cfg.maxViolations - violations)
    if (violations >= cfg.maxViolations) {
      // v59：先停监听再弹终止提示 —— stop 会清掉上一次的警告弹窗，终止提示保留到用户点「我知道了」
      const cb = cfg.onSubmit
      stop()
      showFinal()
      if (typeof cb === 'function') setTimeout(() => { try { cb('cheat') } catch (e) {} }, 700)
    } else {
      showWarn(left)
    }
  }

  function onVis() { if (document.hidden) record() }
  function onBlur() { record() }
  function onLeave() { record() }
  function onContext(e) { if (active) { e.preventDefault(); return false } }
  function onCopy(e) { if (active) e.preventDefault() }
  function onBeforeUnload(e) {
    if (!active) return
    e.preventDefault()
    e.returnValue = ''
    return ''
  }

  function start(opts) {
    if (active) return
    // v65：管理员豁免 —— 不激活、不挂任何监听（isActive() 保持 false，作答流程照常）
    if (isAdminUser()) { stop(); return }
    opts = opts || {}
    active = true
    violations = 0
    lastTs = 0
    cfg = {
      maxViolations: opts.maxViolations || 3,
      onViolation: opts.onViolation || null,
      onSubmit: opts.onSubmit || null,
      finalKey: opts.finalKey || ''   // v59：达上限弹窗文案的 i18n key（默认自动交卷文案）
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('blur', onBlur)
    document.addEventListener('mouseleave', onLeave)
    document.addEventListener('contextmenu', onContext)
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCopy)
    window.addEventListener('beforeunload', onBeforeUnload)
  }
  function stop() {
    if (!active) return
    active = false
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('mouseleave', onLeave)
    document.removeEventListener('contextmenu', onContext)
    document.removeEventListener('copy', onCopy)
    document.removeEventListener('cut', onCopy)
    window.removeEventListener('beforeunload', onBeforeUnload)
    removeOverlay()
  }
  function isActive() { return active }
  function getViolations() { return violations }
  return { start, stop, isActive, getViolations, dismiss, isAdminUser }
})()
window.AntiCheat = AntiCheat
