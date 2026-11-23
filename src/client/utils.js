/**
 * 展示/解析小工具（tail.js、dock.js、views.js 共用）。
 */
function fmtTok(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–'
  if (n < 1000) return String(n)
  const k = (n / 1000).toFixed(1).replace(/\.0$/, '')
  return k + 'k'
}

/** 段状态：主模型小结 → 小结标签；代码段/表格段 → 结构化摘要（未精炼）；未精炼原因 → 原因标签；待精炼 → 待精炼；已精炼 → 已精炼。 */
function segStatus(s) {
  if (s && s.kind === 'self') return { cls: 'ts-seg-self', label: '思考小结' }
  if (s && s.skipReason === 'code') return { cls: 'ts-seg-skip', label: '代码段·未精炼' }
  if (s && s.skipReason === 'table') return { cls: 'ts-seg-skip', label: '表格·未精炼' }
  if (s && s.refined) return { cls: 'ts-seg-refined', label: '已精炼' }
  if (s && s.unrefinedReason) return { cls: 'ts-seg-skip', label: s.unrefinedReason }
  if (s && !s.kind) return { cls: 'ts-seg-pending', label: '待精炼' }
  return null
}

function segStatusEl(s) {
  const st = segStatus(s)
  return st ? React.createElement('span', { className: st.cls }, st.label) : null
}

/** 已精炼段的实际消耗标注：" · 精炼 ~N tok"（输入裁剪后 + 输出摘要）。 */
function refineTokStr(s) {
  if (!s || !s.refined) return ''
  const rt = s.refineTokens || {}
  const total = (rt.input || 0) + (rt.output || 0)
  return total > 0 ? ' · 精炼 ~' + fmtTok(total) + ' tok' : ''
}

/**
 * 段头标签：主模型小结 → "小结"；普通段 → "原始 X tok[ · 精炼 ~Y tok]"。
 * 原始 token 用 rawTokens（段文本 + 本段之前被忽略的代码/表格 token，
 * 精炼前/忽略前的完整口径）；无 rawTokens 时回退到段文本 token。
 */
function segHeadLabel(s, prefix) {
  if (s && s.kind === 'self') return prefix + '第' + (s.index + 1) + '段 · 小结'
  const raw = (s && (s.rawTokens ?? s.tokens)) || 0
  return prefix + '第' + (s.index + 1) + '段 · 原始 ' + fmtTok(raw) + ' tok' + refineTokStr(s)
}

/**
 * 轮询会话思考状态（dock/views 共用）。
 * 每 1.5s fetch STATE_ROUTE；返回 { state, enabled, paused }。
 */
// One polling subscription per session, shared by dock, history and all turn tails.
const thinkSubscriptions = new Map()
function subscribeThinkState(sessionId, listener) {
  if (!sessionId) { listener({ state: null, enabled: true, paused: false }); return () => {} }
  let entry = thinkSubscriptions.get(sessionId)
  if (!entry) {
    entry = { listeners: new Set(), value: { state: null, enabled: true, paused: false }, timer: null, controller: null, closed: false, etag: null }
    thinkSubscriptions.set(sessionId, entry)
    entry.poll = async () => {
      if (entry.closed || entry.controller || document.hidden) return
      entry.controller = new AbortController()
      const timeout = setTimeout(() => entry.controller?.abort(), 10000)
      try {
        const res = await fetch(STATE_ROUTE + '?sessionId=' + encodeURIComponent(sessionId), { signal: entry.controller.signal, headers: entry.etag ? { 'If-None-Match': entry.etag } : {} })
        if (res.status === 304) return
        if (!res.ok) throw new Error('state request failed')
        const json = await res.json()
        if (!entry.closed) {
          entry.etag = res.headers?.get('etag') || null
          entry.value = { state: json.state || null, enabled: json.enabled !== false, paused: json.paused === true }
          for (const callback of entry.listeners) callback(entry.value)
        }
      } catch {} finally {
        clearTimeout(timeout)
        entry.controller = null
        if (!entry.closed && !document.hidden) {
          const state = entry.value.state
          const pending = state?.thinks?.some(t => t.segments.some(s => !s.refined && !s.skipReason && !s.unrefinedReason))
          entry.timer = setTimeout(entry.poll, state?.active || pending ? 1500 : 5000)
        }
      }
    }
    entry.visibility = () => {
      clearTimeout(entry.timer)
      entry.timer = null
      if (document.hidden) entry.controller?.abort()
      else void entry.poll()
    }
    document.addEventListener('visibilitychange', entry.visibility)
  }
  entry.listeners.add(listener)
  listener(entry.value)
  if (!entry.timer) void entry.poll()
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size) return
    entry.closed = true
    clearTimeout(entry.timer)
    entry.controller?.abort()
    document.removeEventListener('visibilitychange', entry.visibility)
    thinkSubscriptions.delete(sessionId)
  }
}
function useThinkState(sessionId) {
  const [snapshot, setSnapshot] = React.useState({ sessionId, value: { state: null, enabled: true, paused: false } })
  React.useEffect(() => subscribeThinkState(sessionId, value => setSnapshot({ sessionId, value })), [sessionId])
  return snapshot.sessionId === sessionId ? snapshot.value : { state: null, enabled: true, paused: false }
}

/**
 * 原生 dsh chevron-down-outline-14 图标（对齐默认箭头，非实心字符）。
 * 路径取自 dsh-client-ui-primitives IconChevronDownOutline14；颜色跟 currentColor，
 * 由使用处 CSS class 控制；旋转交给父级 class 的 transform。
 */
function chevronEl(className) {
  return React.createElement(
    'svg',
    {
      className, width: 14, height: 14, viewBox: '0 0 14 14', fill: 'currentColor',
      'aria-hidden': 'true', style: { flex: 'none' },
    },
    React.createElement('path', {
      d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
    }),
  )
}

/**
 * 原生 dsh 播放/暂停图标（对齐 primitives IconPlayOutline16 / IconPauseOutline16，
 * 16px，颜色跟 currentColor）。暂停态显示播放（继续），运行态显示暂停。
 */
function playPauseIconEl(className, paused) {
  const paths = paused
    ? [
        // 播放（继续）：三角
        'M14.1446 8C14.1446 4.6062 11.3938 1.85539 8 1.85539C4.6062 1.85539 1.85539 4.6062 1.85539 8C1.85539 11.3938 4.6062 14.1446 8 14.1446C11.3938 14.1446 14.1446 11.3938 14.1446 8ZM15.511 8C15.511 12.148 12.148 15.511 8 15.511C3.85202 15.511 0.489014 12.148 0.489014 8C0.489014 3.85202 3.85202 0.489014 8 0.489014C12.148 0.489014 15.511 3.85202 15.511 8Z',
        'M10.5617 8.42578C10.852 8.21614 10.852 7.78386 10.5617 7.57422L7.25708 5.18751C6.90974 4.93666 6.42436 5.18484 6.42436 5.61329V10.3867C6.42436 10.8152 6.90974 11.0633 7.25708 10.8125L10.5617 8.42578Z',
      ]
    : [
        // 暂停：双竖条
        'M14.1448 8.00024C14.1448 4.60644 11.394 1.85563 8.00024 1.85563C4.60644 1.85563 1.85563 4.60644 1.85563 8.00024C1.85563 11.394 4.60644 14.1448 8.00024 14.1448C11.394 14.1448 14.1448 11.394 14.1448 8.00024ZM15.5112 8.00024C15.5112 12.1482 12.1482 15.5112 8.00024 15.5112C3.85226 15.5112 0.489258 12.1482 0.489258 8.00024C0.489258 3.85226 3.85226 0.489258 8.00024 0.489258C12.1482 0.489258 15.5112 3.85226 15.5112 8.00024Z',
        'M7.14244 5.14258V10.8569H5.71387V5.14258H7.14244Z',
        'M10.286 5.14258V10.8569H8.85742V5.14258H10.286Z',
      ]
  return React.createElement(
    'svg',
    {
      className, width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
      'aria-hidden': 'true', style: { flex: 'none' },
    },
    paths.map((d, i) => React.createElement('path', { key: i, d, fill: 'currentColor' })),
  )
}
