/**
 * 状态存储（v2）：会话级 + "每次思考"分组。
 * 说明：流上无法获得 turn（探测确认 GenerateOptions 无 turn 字段），
 * 实时路径以"每次 llm/stream 调用"为一个 think（id: s<序号>），
 * 兜底路径以 turn 为一个 think（id: t<turn>）；客户端按 think 分组折叠展示。
 */

export interface SegmentSummary {
  index: number
  summary: string
  /** 段文本 token（进缓冲的内容）。 */
  tokens: number
  /** 原始 token = 段文本 + 本段之前被忽略的代码/表格 token（精炼前/忽略前口径）。 */
  rawTokens?: number
  refined: boolean
  /** 'code'/'table' = 结构化摘要已足够，未调小模型精炼（省 token）。 */
  skipReason?: 'code' | 'table'
  /** 'self' = 主模型自产小结（selfSummary 模式捕获，直接展示，不经启发式/精炼）。 */
  kind?: 'self'
  /** 未精炼原因（小段/精炼失败/超时等；UI 状态标签显示）。 */
  unrefinedReason?: string
  /** 精炼实际消耗（估算）：输入 = 裁剪后喂入的 token，输出 = 摘要 token。 */
  refineTokens?: { input?: number; output?: number }
  ts: number
}

export interface ThinkGroup {
  /** think 唯一 id：实时 s<序号> / 兜底 t<turn>。 */
  id: string
  active: boolean
  /** 该次思考累计 token。 */
  tokens: number
  startedAt: number
  segments: SegmentSummary[]
  /** 会话 turn/step 标记（assistant/message 事件打标，供聊天流内 turnTail 匹配）。 */
  turn?: number
  step?: number
}

export interface ThinkState {
  sessionId: string
  currentTurn?: number
  /** 是否有活跃思考。 */
  active: boolean
  /** 当前思考是否已判定长思考。 */
  inSplice: boolean
  /** 当前思考的 token 数（进度头用）。 */
  thinkingTokens: number
  updatedAt: number
  thinks: ThinkGroup[]
  /** think 序号（s<序号> 分配）。 */
  nextThinkId: number
}

/** 无段会话的清理 TTL（10 分钟空闲即清）。 */
const TTL_MS = 10 * 60 * 1000
/** 有思考总结段的会话保留更久（回看历史消息仍能显示总结条）。 */
const TTL_SEG_MS = Infinity

/** 磁盘持久化格式（dsh-think-summary.json 单文件）。 */
export interface SavedThinkState {
  sessionId: string
  currentTurn?: number
  thinkingTokens: number
  updatedAt: number
  thinks: ThinkGroup[]
  /** 下一条实时 think 序号（避免重启后 id 冲突）。 */
  nextThinkId: number
}

export class ThinkStateStore {
  private map = new Map<string, ThinkState>()
  /** 最近活跃会话（侧边栏面板缺省 sessionId 时使用）。 */
  private lastActiveSessionId: string | undefined
  /** 状态变更监听（持久化写盘用）。 */
  private listeners = new Set<() => void>()

  // GenerateOptions only carries the session ID. The next assistant event binds
  // a skipped primary request to its turn and step, even after a resume.
  readonly untaggedPausedRequests = new Set<string>()

  /**
   * 全局暂停（客户端标题栏"暂停"按钮，非设置项）：
   * 暂停后不再检测/分段/精炼/兜底任何新思考，旧总结照常显示；
   * 与配置 enabled 区分：enabled=false 客户端隐藏全部总结 UI，
   * paused=true 仅停止新产出，UI 保留。
   */
  private _paused = false
  private pauseListeners = new Set<() => void>()
  get paused() { return this._paused }
  set paused(value: boolean) {
    this._paused = value
    if (value) for (const listener of this.pauseListeners) { try { listener() } catch {} }
  }
  onPause(listener: () => void) { this.pauseListeners.add(listener) }
  touch(sessionId: string): void {
    const state = this.get(sessionId)
    if (state) { state.updatedAt = Date.now(); this.notify() }
  }
  updateSegment(sid: string, tid: string, index: number, patch: Partial<SegmentSummary>): void {
    const segment = this.get(sid)?.thinks.find(t => t.id === tid)?.segments.find(s => s.index === index)
    if (segment) { Object.assign(segment, patch); this.touch(sid) }
  }

  get(sessionId: string): ThinkState | undefined {
    return this.map.get(sessionId)
  }

  /** 订阅状态变更（begin/end/push/清理等任何写操作后触发）。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const l of this.listeners) { try { l() } catch { /* observer isolation */ } }
  }

  private create(sessionId: string): ThinkState {
    const s: ThinkState = {
      sessionId,
      active: false,
      inSplice: false,
      thinkingTokens: 0,
      updatedAt: Date.now(),
      thinks: [],
      nextThinkId: 1,
    }
    this.map.set(sessionId, s)
    return s
  }

  startTurn(sessionId: string, turn: number): void {
    const state = this.get(sessionId) ?? this.create(sessionId)
    if (state.currentTurn !== undefined && turn <= state.currentTurn) return
    state.currentTurn = turn
    state.updatedAt = Date.now()
    this.notify()
  }

  /** 实时路径：开始一次新思考（每次 llm/stream 调用 = 一个新 think）。 */
  beginThink(sessionId: string): { state: ThinkState; think: ThinkGroup } {
    let s = this.map.get(sessionId)
    if (!s) s = this.create(sessionId)
    const think: ThinkGroup = {
      id: `s${s.nextThinkId++}`,
      turn: s.currentTurn,
      active: true,
      tokens: 0,
      startedAt: Date.now(),
      segments: [],
    }
    s.thinks.push(think)
    s.active = true
    s.inSplice = false
    s.thinkingTokens = 0
    s.updatedAt = Date.now()
    this.lastActiveSessionId = sessionId
    this.notify()
    return { state: s, think }
  }

  /** 兜底路径：取或建一个按 key 键控的 think（保持 active=false）。 */
  ensureThink(sessionId: string, thinkId: string): { state: ThinkState; think: ThinkGroup } {
    let s = this.map.get(sessionId)
    if (!s) s = this.create(sessionId)
    let think = s.thinks.find((t) => t.id === thinkId)
    if (!think) {
      think = { id: thinkId, active: false, tokens: 0, startedAt: Date.now(), segments: [] }
      s.thinks.push(think)
      this.notify()
    }
    return { state: s, think }
  }

  /** 流结束：结束指定 think 并刷新会话活跃态。 */
  endThink(sessionId: string, thinkId: string): void {
    const s = this.get(sessionId)
    if (!s) return
    const think = s.thinks.find((t) => t.id === thinkId)
    if (think) think.active = false
    s.active = s.thinks.some((t) => t.active)
    s.updatedAt = Date.now()
    this.notify()
  }

  /** 推入一个分段到指定 think。 */
  pushSegment(state: ThinkState, thinkId: string, segment: SegmentSummary): void {
    const think = state.thinks.find((t) => t.id === thinkId)
    if (!think) return
    think.segments.push(segment)
    state.updatedAt = Date.now()
    this.notify()
  }

  /** 过期清理（空闲超过 TTL）；返回移除数。 */
  sweep(now = Date.now()): number {
    let removed = 0
    for (const [k, s] of this.map) {
      if (s.active) continue
      const idle = now - s.updatedAt
      // 有思考总结段的会话保留更久（回看历史消息仍能显示总结条）
      const hasSegs = s.thinks.some((t) => t.segments.length > 0)
      if (idle > (hasSegs ? TTL_SEG_MS : TTL_MS)) {
        this.map.delete(k)
        removed++
      }
    }
    return removed
  }

  /** 供 Client 轮询的纯 JSON 视图（剥离内部 hashes/nextThinkId）。 */
  view(sessionId: string): Omit<ThinkState, 'nextThinkId'> | undefined {
    const s = this.get(sessionId)
    if (!s) return undefined
    return {
      sessionId: s.sessionId,
      currentTurn: s.currentTurn,
      active: s.active,
      inSplice: s.inSplice,
      thinkingTokens: s.thinkingTokens,
      updatedAt: s.updatedAt,
      thinks: s.thinks.map((t) => ({ ...t, segments: t.segments.slice() })),
    }
  }

  get lastActive(): string | undefined {
    return this.lastActiveSessionId
  }

  /** 导出全部会话（持久化写盘；剥离运行时字段，保留 think 分组与段）。
   *  只导出**有段输出**的会话——与 loadAll 的恢复规则对称，
   *  文件只含真正的思考总结（空段会话不占磁盘）。 */
  exportAll(): SavedThinkState[] {
    const out: SavedThinkState[] = []
    for (const s of this.map.values()) {
      const hasSegs = s.thinks.some((t) => t.segments && t.segments.length > 0)
      if (!hasSegs) continue
      out.push({
        sessionId: s.sessionId,
        currentTurn: s.currentTurn,
        thinkingTokens: s.thinkingTokens,
        updatedAt: s.updatedAt,
        thinks: s.thinks.map((t) => ({
          id: t.id,
          active: false, // 重启后无活跃流
          tokens: t.tokens,
          startedAt: t.startedAt,
          turn: t.turn,
          step: t.step,
          segments: t.segments.filter(seg => seg && typeof seg.summary === 'string' && Number.isInteger(seg.index)).map(seg => ({ ...seg })),
        })),
        nextThinkId: s.nextThinkId,
      })
    }
    return out
  }

  /** 从持久化数据恢复（apply 启动时；仅合并有段的会话，保留内存运行态）。 */
  loadAll(saved: SavedThinkState[] | undefined): void {
    if (!Array.isArray(saved)) return
    for (const rec of saved) {
      if (!rec || typeof rec.sessionId !== 'string' || !Array.isArray(rec.thinks)) continue
      const hasSegs = rec.thinks.some((t) => t && Array.isArray(t.segments) && t.segments.length > 0)
      if (!hasSegs) continue // 只恢复有输出的总结
      const live = this.get(rec.sessionId)
      const s = live ?? this.create(rec.sessionId)
      if (!live) {
        s.thinkingTokens = typeof rec.thinkingTokens === 'number' ? rec.thinkingTokens : 0
        s.updatedAt = typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now()
      }
      if (Number.isSafeInteger(rec.nextThinkId)) s.nextThinkId = Math.max(s.nextThinkId, rec.nextThinkId)
      const restored: ThinkGroup[] = rec.thinks
        .filter((t) => t && Array.isArray(t.segments))
        .map((t) => ({
          id: String(t.id),
          active: false,
          tokens: typeof t.tokens === 'number' ? t.tokens : 0,
          startedAt: typeof t.startedAt === 'number' ? t.startedAt : Date.now(),
          turn: typeof t.turn === 'number' ? t.turn : undefined,
          step: typeof t.step === 'number' ? t.step : undefined,
          segments: t.segments.filter(seg => seg && typeof seg.summary === 'string' && Number.isInteger(seg.index)).map(seg => ({ ...seg, unrefinedReason: !seg.refined && !seg.skipReason && !seg.unrefinedReason && seg.kind !== 'self' ? '上次运行已结束，保留原摘要' : seg.unrefinedReason })),
        }))
      s.currentTurn ??= Number.isSafeInteger(rec.currentTurn) ? rec.currentTurn
        : restored.reduce<number | undefined>((latest, t) =>
          t.turn === undefined ? latest : Math.max(latest ?? t.turn, t.turn), undefined)
      const used = new Set(s.thinks.map(t => t.id))
      for (const t of restored) {
        const serial = /^s\d+$/.test(t.id) ? Number(t.id.slice(1)) : 0
        if (Number.isSafeInteger(serial)) s.nextThinkId = Math.max(s.nextThinkId, serial + 1)
      }
      for (const t of restored) {
        // Queued refinements and stream closures already reference the live IDs.
        if (used.has(t.id)) t.id = `s${s.nextThinkId++}`
        used.add(t.id)
      }
      s.thinks = restored.concat(s.thinks)
    }
  }

}
