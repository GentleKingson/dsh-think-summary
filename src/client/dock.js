/**
 * 输入框上方实时面板（conversation.input.dock 槽位）：
 * 样式配合输入框（宽度对齐官方 todo/queue dock）；可折叠、多行；
 * 展示当前轮次全部摘要，下一轮开始时切换。
 */

function makeInputDock() {
  return function ThinkInputDock(props) {
    const sessionId = props && props.sessionId
    const { state, enabled, paused } = useThinkState(sessionId)
    const [open, setOpen] = React.useState(true)
    const [pauseBusy, setPauseBusy] = React.useState(false)
    const bodyRef = React.useRef(null)
    const latestRef = React.useRef(null)

    const thinks = state && state.sessionId === sessionId ? state.thinks : []
    // 没有轮号的旧记录只能可靠地展示最近一次思考。
    const groups = state?.currentTurn === undefined
      ? thinks.slice(-1)
      : thinks.filter((t) => t.turn === state.currentTurn)
          .sort((a, b) => (a.step ?? Infinity) - (b.step ?? Infinity))
    const active = groups.some((t) => t.active)
    const tokens = groups.reduce((sum, t) => sum + t.tokens, 0)
    const visible = groups.filter((t) => t.segments.length)
    const lastGroup = visible[visible.length - 1]
    const latest = lastGroup?.segments[lastGroup.segments.length - 1]
    const latestKey = latest ? lastGroup.id + ':' + latest.index : null

    React.useLayoutEffect(() => {
      const body = bodyRef.current
      const segment = latestRef.current
      if (!body || !segment) return
      // 只滚动面板，把新段开头带到可视区域。
      body.scrollTop += segment.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientTop
    }, [sessionId, latestKey, open, enabled])

    if (!enabled) return null // 插件总开关关闭：不显示实时思考面板

    // 暂停/继续（全局，非设置项）：暂停后不再产出新总结，旧内容照常显示
    const togglePause = async () => {
      if (pauseBusy) return
      setPauseBusy(true)
      try {
        const res = await fetch(PAUSE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paused: !paused }),
        })
        // 状态由轮询刷新（1.5s 内同步）；失败则下次轮询回弹
        void res.json().catch(() => undefined)
      } catch {
        /* 失败忽略：轮询会恢复显示 */
      } finally {
        setPauseBusy(false)
      }
    }

    const segments = visible.flatMap((t) => t.segments)
    const refinedCount = segments.filter((s) => s.refined).length
    const body = visible.length ? visible.flatMap((t, i) =>
      t.segments.map((s) =>
        React.createElement(
          'div', {
            key: t.id + ':' + s.index,
            className: 'ts-dock-seg',
            ref: s === latest ? latestRef : null,
          },
          React.createElement(
            'div', { className: 'ts-dock-seg-head' },
            React.createElement('span', null, segHeadLabel(s, visible.length > 1 ? '思考 ' + (i + 1) + ' · ' : '')),
            segStatusEl(s),
          ),
          React.createElement('div', { className: 'ts-dock-seg-text' }, s.summary),
        ),
      )
    ) : React.createElement('div', { className: 'ts-dock-placeholder' },
      active ? '正在积累思考…' : '本轮暂无分段摘要',
    )

    return React.createElement(
      'div', { className: 'ts-dock', 'data-open': open ? 'true' : 'false' },
      React.createElement(
        'div', { className: 'ts-dock-panel' },
        React.createElement(
          'div', { className: 'ts-dock-head' },
          // 折叠开关独立为小箭头按钮：点击箭头收起/展开，标题栏其他区域不再响应
          React.createElement(
            'button',
            {
              type: 'button', className: 'ts-dock-toggle', 'aria-expanded': open ? 'true' : 'false',
              title: open ? '收起' : '展开', onClick: () => setOpen(!open),
            },
            chevronEl('ts-dock-chevron'),
          ),
          React.createElement('span', { className: 'ts-dock-title' }, '思考总结'),
          React.createElement(
            'span', { className: 'ts-dock-progress' },
            !groups.length
              ? '等待思考…'
              : paused
                ? '已暂停 · 不再更新'
                : active
                  ? '思考中 · ' + fmtTok(tokens) + ' tok · ' + segments.length + ' 段'
                  : '思考结束 · ' + fmtTok(tokens) + ' tok · ' + segments.length + ' 段',
          ),
          paused ? React.createElement('span', { className: 'ts-dock-paused' }, '已暂停') : null,
          active && !paused ? React.createElement('span', { className: 'ts-dock-dot' }) : null,
          refinedCount > 0 ? React.createElement('span', { className: 'ts-seg-refined' }, refinedCount + ' 段已精炼') : null,
          React.createElement(
            'button',
            {
              type: 'button', className: 'ts-dock-pause' + (paused ? ' on' : ''),
              'aria-label': paused ? '继续思考总结' : '暂停思考总结（旧内容保留）',
              title: paused ? '继续思考总结' : '暂停思考总结（旧内容保留）',
              disabled: pauseBusy, onClick: () => void togglePause(),
            },
            playPauseIconEl('ts-dock-pause-icon', paused),
          ),
        ),
        open ? React.createElement('div', { className: 'ts-dock-body', ref: bodyRef }, body) : null,
      ),
    )
  }
}
