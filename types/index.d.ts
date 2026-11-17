export type SessionRow = {
  id: string
  title: string
  isRunning: boolean
  lastActivityAt: string
  group: string | null
  link: string | null
  isLinked: boolean
}

export type TaskItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentRow = {
  id: string
  description: string
  type: string
  status: string
}

export type BoardMeta = {
  refreshedAt: number
  error: string | null
}

/** 人が付けるステータス。none は未設定（動いていれば自動で「作業中」扱い） */
export type SessionStatus = 'none' | 'active' | 'waiting' | 'done'

export type SessionNote = {
  status: SessionStatus
  memo: string
  summary: string
  summaryAt: string
}

export type PersonalTask = {
  id: string
  text: string
  isDone: boolean
  createdAt: number
}

export type BoardView = {
  editingId: string | null
  showDone: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'work-board': {
      sessions: SessionRow[]
      tasks: TaskItem[]
      agents: AgentRow[]
      meta: BoardMeta
      notes: Record<string, SessionNote>
      personal: PersonalTask[]
      view: BoardView
    }
  }
}
