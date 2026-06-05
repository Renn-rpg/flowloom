// AgentTracker —— 多 agent 运行态的唯一真相源（纯数据 + 事件，不碰 ANSI/IO）。
//
// 所有委派路径都把活动喂进这里：
//   · dispatch_agent      （单个隔离子 agent）
//   · dispatch_agents     （并发扇出）
//   · workflow / floom run（脚本编排，带 phase）
// 页脚摘要（footer.ts）与全屏钻入视图（workflow-view.ts）只从 tracker 读，并订阅
// 'update' 事件做节流重绘。把「状态」与「渲染」彻底分开 → 渲染层可换、tracker 可单测。

import { EventEmitter } from 'node:events'

export type AgentStatus = 'queued' | 'running' | 'done' | 'failed'
export type RunStatus = 'running' | 'paused' | 'done' | 'failed'

export interface AgentRow {
  id: string
  label: string
  phase?: string
  model: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  currentTool?: string
  error?: string
}

export interface RunGroup {
  id: string
  title: string
  // 有序 phase 标题（workflow 才有；纯扇出为空数组）。
  phases: string[]
  // 当前 phase 在 phases 中的下标（-1 = 尚无/无 phase）。
  currentPhase: number
  rows: AgentRow[]
  startedAt: number
  endedAt?: number
  status: RunStatus
}

// 单调时钟可注入，便于单测确定性（默认 Date.now）。
type Now = () => number

export class AgentTracker extends EventEmitter {
  private runs: RunGroup[] = []
  private rowIndex = new Map<string, { run: RunGroup; row: AgentRow }>()
  private nextRun = 1
  private nextAgent = 1
  private now: Now

  constructor(now: Now = () => Date.now()) {
    super()
    this.now = now
  }

  startRun(title: string, phases: string[] = []): string {
    const id = `r${this.nextRun++}`
    this.runs.push({
      id,
      title,
      phases: [...phases],
      currentPhase: phases.length > 0 ? 0 : -1,
      rows: [],
      startedAt: this.now(),
      status: 'running',
    })
    this.emit('update')
    return id
  }

  addAgent(runId: string, a: { label: string; phase?: string; model: string }): string {
    const run = this.runs.find((r) => r.id === runId)
    if (!run) return ''
    const id = `a${this.nextAgent++}`
    const row: AgentRow = {
      id,
      label: a.label,
      phase: a.phase,
      model: a.model,
      status: 'queued',
      startedAt: this.now(),
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
    }
    run.rows.push(row)
    this.rowIndex.set(id, { run, row })
    // 新 agent 落在某个 phase 上时，把当前 phase 指针对齐到它（footer 展示「当前 phase」）。
    if (a.phase) {
      const pi = run.phases.indexOf(a.phase)
      if (pi >= 0) run.currentPhase = pi
    }
    this.emit('update')
    return id
  }

  agentRunning(agentId: string): void {
    const e = this.rowIndex.get(agentId)
    if (!e) return
    e.row.status = 'running'
    e.row.startedAt = this.now()
    this.emit('update')
  }

  agentTool(agentId: string, name: string): void {
    const e = this.rowIndex.get(agentId)
    if (!e) return
    e.row.toolCalls++
    e.row.currentTool = name
    this.emit('update')
  }

  agentUsage(agentId: string, u: { inputTokens: number; outputTokens: number }): void {
    const e = this.rowIndex.get(agentId)
    if (!e) return
    e.row.inputTokens = u.inputTokens
    e.row.outputTokens = u.outputTokens
    this.emit('update')
  }

  agentDone(
    agentId: string,
    d: { tokens?: number; tools?: number; isError?: boolean; error?: string } = {},
  ): void {
    const e = this.rowIndex.get(agentId)
    if (!e) return
    const { row } = e
    row.status = d.isError ? 'failed' : 'done'
    row.endedAt = this.now()
    if (typeof d.tokens === 'number') row.outputTokens = d.tokens
    if (typeof d.tools === 'number') row.toolCalls = d.tools
    row.currentTool = undefined
    if (d.error) row.error = d.error
    this.emit('update')
  }

  phaseChange(runId: string, phase: string): void {
    const run = this.runs.find((r) => r.id === runId)
    if (!run) return
    let pi = run.phases.indexOf(phase)
    if (pi < 0) {
      run.phases.push(phase)
      pi = run.phases.length - 1
    }
    run.currentPhase = pi
    this.emit('update')
  }

  endRun(runId: string, status: RunStatus): void {
    const run = this.runs.find((r) => r.id === runId)
    if (!run) return
    run.status = status
    run.endedAt = this.now()
    // 收尾：把仍在 running 的行按 run 终态收口。queued（从未开跑）的行：run 正常结束→视为 done；
    // run 中断/失败→**保留 queued**（它从未被尝试，标 failed 会误导钻入视图/摘要）。
    if (status === 'failed' || status === 'done') {
      for (const row of run.rows) {
        if (row.status === 'running') {
          row.status = status === 'done' ? 'done' : 'failed'
          row.endedAt ??= this.now()
        } else if (row.status === 'queued' && status === 'done') {
          row.status = 'done'
          row.endedAt ??= this.now()
        }
      }
    }
    this.emit('update')
  }

  setRunStatus(runId: string, status: RunStatus): void {
    const run = this.runs.find((r) => r.id === runId)
    if (!run) return
    run.status = status
    this.emit('update')
  }

  // 仍在进行（running/paused）的最近一个 run；页脚摘要据此显隐。
  current(): RunGroup | null {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i]
      if (r.status === 'running' || r.status === 'paused') return r
    }
    return null
  }

  // 最近一个 run（不论是否结束）；钻入视图据此可在跑完后仍查看。
  last(): RunGroup | null {
    return this.runs.length > 0 ? this.runs[this.runs.length - 1] : null
  }

  all(): readonly RunGroup[] {
    return this.runs
  }
}

// ── 纯计算助手（footer / view 共用，可单测）──────────────────────────────────

export interface RunProgress {
  done: number
  total: number
  failed: number
  running: number
  // 摘要标签：有 phase → 「<phase> d/t」；纯扇出 → 「d/t agents」。
  label: string
}

export function runProgress(run: RunGroup): RunProgress {
  const hasPhase = run.phases.length > 0 && run.currentPhase >= 0
  const scope = hasPhase
    ? run.rows.filter((r) => r.phase === run.phases[run.currentPhase])
    : run.rows
  const done = scope.filter((r) => r.status === 'done').length
  const failed = scope.filter((r) => r.status === 'failed').length
  const running = scope.filter((r) => r.status === 'running').length
  const total = scope.length
  const label = hasPhase
    ? `${run.phases[run.currentPhase]} ${done + failed}/${total}`
    : `${done + failed}/${total} agents`
  return { done, total, failed, running, label }
}
