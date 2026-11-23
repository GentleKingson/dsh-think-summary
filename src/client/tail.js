/**
 * 聊天流内思考总结条（conversation.chat.turnTail 槽位）：
 * 该槽位是 **turn 级**（渲染在整个回复末尾，非每个 think 块下），
 * 因此显示该 turn **所有有段**的思考（按 step 分组，区分每次思考）：
 *  - 匹配：sessionId + think.turn === 节点 turn（取全部有段 think，按 step 排序）
 *  - 每个 think 一个分组：头部"思考 · step N · X 段"（单 think 时省略分组头）
 *  - 组内段摘要 + 原始/精炼双 token + 状态标签；可折叠
 *
 * 槽位契约（Inspect 确认）：owner = { turn: TurnLocation, seq, openFile }；
 * 组件直接接收 owner props。
 */
function makeThinkTail() {
  return function ThinkTail(props) {
    const sessionId = props && props.sessionId
    const turn = props && props.turn
    const { state, enabled } = useThinkState(sessionId)
    const thinks = ((state && state.thinks) || [])
      .filter(t => turn && t.turn === turn.turn && t.segments.length > 0)
      .sort((a, b) => (a.step ?? 0) - (b.step ?? 0))
    const [open, setOpen] = React.useState(false)

    if (!enabled) return null // 插件总开关关闭：不显示总结条
    if (thinks.length === 0) return null

    const totalSegs = thinks.reduce((n, t) => n + t.segments.length, 0)
    const totalRefined = thinks.reduce((n, t) => n + t.segments.filter((s) => s.refined).length, 0)

    // 按 think 分组：多思考时每组标注 step；单思考保持紧凑
    const groups = thinks.map((think) => {
      const segEls = think.segments.map((s) =>
        React.createElement(
          'div', { key: think.id + ':' + s.index, className: 'ts-tail-seg' },
          React.createElement(
            'div', { className: 'ts-tail-seg-head' },
            React.createElement('span', null, segHeadLabel(s, '')),
            segStatusEl(s),
          ),
          React.createElement('div', { className: 'ts-tail-seg-text' }, s.summary),
        ),
      )
      return React.createElement(
        'div', { key: think.id, className: 'ts-tail-group' },
        thinks.length > 1
          ? React.createElement(
              'div', { className: 'ts-tail-group-head' },
              '思考 · step ' + (think.step ?? '?') + ' · ' + think.segments.length + ' 段 · ' + fmtTok(think.tokens) + ' tok',
            )
          : null,
        ...segEls,
      )
    })

    return React.createElement(
      'div', { className: 'ts-tail', 'data-open': open ? 'true' : 'false' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'ts-tail-head',
          onClick: () => setOpen(!open),
        },
        chevronEl('ts-tail-chevron'),
        React.createElement('span', { className: 'ts-tail-title' }, '思考总结'),
        React.createElement('span', { className: 'ts-tail-meta' }, totalSegs + ' 段 · ' + thinks.length + ' 次思考'),
        totalRefined > 0 ? React.createElement('span', { className: 'ts-tail-refined' }, totalRefined + ' 段已精炼') : null,
      ),
      open ? React.createElement('div', { className: 'ts-tail-body' }, ...groups) : null,
    )
  }
}
