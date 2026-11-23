import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' { interface LlmRequestPurposeMap { 'think-summary': true } }
import { countRaw, estimateTokens } from '../detect.js'
import { DEFAULT_REFINE_PROMPT, resolveConfig, type ThinkSummaryConfig } from '../config.js'

export interface RefineTask {
  sessionId: string
  /** 所属 think（每次思考分组）。 */
  thinkId: string
  segmentIndex: number
  /** 段全文（内部裁剪尾部喂入）。 */
  text: string
  /** 主请求的 provider（与主流同 provider）。 */
  provider: string
  /** 原请求的模型 ID。 */
  fallbackModel: string
  signal?: AbortSignal
}

export interface RefineApply {
  (
    sessionId: string,
    thinkId: string,
    segmentIndex: number,
    refinedSummary: string,
    /** 本次精炼实际消耗（估算）：输入 = 裁剪后喂入的 token，输出 = 摘要 token。 */
    refineTokens: { input: number; output: number },
  ): void
}

/** 精炼失败回调：把失败/超时原因写回段（UI 显示"未精炼原因"）。 */
export interface RefineFail {
  (sessionId: string, thinkId: string, segmentIndex: number, reason: string): void
}

/** 展示截断：精炼结果最多保留 ~60 token（约 240 字符）。 */
const DISPLAY_MAX_CHARS = 240

/** llm 服务的最小可用面（防御性类型，不依赖完整契约）。 */
export interface LlmLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * 头尾裁剪（docs/segment-optimization.md §4.C）：保留头部（主题，常在前 20%）
 * 与尾部（结论），丢中段。比"只保尾部"在同等预算下信息量更高。
 */
export function headTailTrim(text: string, budget: number, headRatio = 0.3): string {
  if (estimateTokens(text) <= budget) return text
  const headBudget = Math.max(0, Math.floor(budget * headRatio))
  const tailBudget = budget - headBudget
  const head = takeTokens(text, headBudget, 1)
  const tail = takeTokens(text, tailBudget, -1)
  const mid = '…（中段略）…'
  const out = head + mid + tail
  return estimateTokens(out) <= budget ? out : head + tail
}

/** 从文本一端取约 budget token（按估算密度先取字符再收敛）。 */
function takeTokens(text: string, budget: number, dir: 1 | -1): string {
  const raw = countRaw(text)
  const avg = (raw.cjk + raw.other / 4) / Math.max(1, text.length)
  const targetChars = Math.max(1, Math.floor(budget / Math.max(0.05, avg)))
  let s = dir === 1 ? text.slice(0, targetChars) : text.slice(Math.max(0, text.length - targetChars))
  while (estimateTokens(s) > budget && s.length > 0) {
    s = dir === 1 ? s.slice(0, Math.floor(s.length * 0.9)) : s.slice(Math.ceil(s.length * 0.1))
  }
  return s
}

/** Bounded side queue. Never inherits the primary request's tools or messages. */
export class RefineQueue {
  private queue: (RefineTask & { model: string })[] = []
  private active = new Map<RefineTask, AbortController>()
  private closed = false
  private jobs = new Set<Promise<void>>()
  constructor(
    private getOptions: () => ThinkSummaryConfig,
    private getLlm: () => LlmLike | undefined,
    private apply: RefineApply,
    private onFail?: RefineFail,
  ) {}
  private fail(task: RefineTask, reason: string) {
    try { this.onFail?.(task.sessionId, task.thinkId, task.segmentIndex, reason) } catch {}
  }
  enqueue(task: RefineTask, configuredModel?: string): boolean {
    const o = resolveConfig(this.getOptions())
    if (this.closed || !o.enabled || !o.refineEnabled || task.signal?.aborted) {
      this.fail(task, '精炼已关闭或取消'); return false
    }
    if (this.queue.length >= 64) { this.fail(task, '精炼队列已满'); return false }
    if (!task.provider?.trim() || task.provider === 'unknown' || !task.fallbackModel?.trim()) {
      this.fail(task, '缺少原请求的服务商或模型，仅保留本地摘要'); return false
    }
    const selected = (configuredModel ?? o.refineModel).trim()
    const model = !selected || selected === 'auto' ? task.fallbackModel : selected
    // Bound retained input even while waiting for a worker.
    this.queue.push({ ...task, model, text: headTailTrim(task.text, o.refineMaxInputTokens) })
    this.pump()
    return true
  }
  cancelAll(reason = '精炼已取消') {
    for (const task of this.queue.splice(0)) this.fail(task, reason)
    for (const controller of this.active.values()) controller.abort(new Error(reason))
  }
  cancelThink(sid: string, tid: string) {
    this.queue = this.queue.filter(task => {
      if (task.sessionId !== sid || task.thinkId !== tid) return true
      this.fail(task, '精炼已取消'); return false
    })
    for (const [task, controller] of this.active) {
      if (task.sessionId === sid && task.thinkId === tid) controller.abort(new Error('精炼已取消'))
    }
  }
  async dispose() { this.closed = true; this.cancelAll(); await Promise.allSettled(this.jobs) }
  hasSession(sid: string) { return this.queue.some(t => t.sessionId === sid) || [...this.active.keys()].some(t => t.sessionId === sid) }
  get pending() { return this.queue.length }
  get running() { return this.active.size }
  private pump() {
    const o = resolveConfig(this.getOptions())
    if (this.closed || !o.enabled || !o.refineEnabled) { this.cancelAll(); return }
    const cap = Math.min(4, Math.max(1, Math.floor(o.refineConcurrency) || 1))
    while (this.active.size < cap && this.queue.length) {
      const task = this.queue.shift()!
      const controller = new AbortController()
      this.active.set(task, controller)
      // Start outside the primary stream observer's synchronous stack.
      const job = Promise.resolve().then(() => this.run(task, controller)).catch(() => {
        this.fail(task, '精炼失败')
      }).finally(() => { this.active.delete(task); this.jobs.delete(job); this.pump() }).catch(() => {})
      this.jobs.add(job)
    }
  }
  private async run(task: RefineTask & { model: string }, controller: AbortController) {
    const o = resolveConfig(this.getOptions())
    const signal = controller.signal
    const abort = () => controller.abort(new Error('精炼已取消'))
    task.signal?.addEventListener('abort', abort, { once: true })
    if (task.signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(new Error('精炼超时')), Math.max(1, o.refineTimeout * 1000))
    let rejectAbort: (() => void) | undefined
    try {
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(signal.reason)
        signal.addEventListener('abort', rejectAbort, { once: true })
        if (signal.aborted) rejectAbort()
      })
      const work = async () => {
        signal.throwIfAborted()
        const llm = this.getLlm()
        if (!llm) throw new Error('unavailable')
        if (!o.enabled || !o.refineEnabled) throw new Error('disabled')
        let out = ''
        for await (const chunk of llm.stream({
          provider: task.provider, model: task.model, signal,
          purpose: 'think-summary', maxTokens: o.refineOutputTokens,
          system: DEFAULT_REFINE_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: task.text }] }],
        })) {
          signal.throwIfAborted()
          if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error('provider-error')
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            out = (out + chunk.text).slice(0, DISPLAY_MAX_CHARS)
          }
        }
        if (!out.trim()) throw new Error('empty')
        return out.trim()
      }
      const text = await Promise.race([work(), cancelled])
      signal.throwIfAborted()
      this.apply(task.sessionId, task.thinkId, task.segmentIndex, text, {
        input: estimateTokens(task.text), output: estimateTokens(text),
      })
    } catch {
      // Never persist provider errors: they can contain credentials or request contents.
      this.fail(task, signal.aborted ? (signal.reason?.message === '精炼超时' ? '精炼超时' : '精炼已取消') : '精炼失败，保留原摘要')
    } finally {
      clearTimeout(timer)
      task.signal?.removeEventListener('abort', abort)
      if (rejectAbort) signal.removeEventListener('abort', rejectAbort)
    }
  }
}
