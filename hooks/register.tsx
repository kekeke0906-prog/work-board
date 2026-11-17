import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentRow,
  BoardMeta,
  BoardView,
  PersonalTask,
  SessionNote,
  SessionRow,
  SessionStatus,
  TaskItem,
} from '../types'

const PANE = 'work-board'
const TITLE = '作業ボード'
const REFRESH_MS = 60_000
const SESSION_LIMIT = 15
const SUMMARY_FETCHES_PER_REFRESH = 4
const SUMMARY_CHARS = 70

// $.state の参照。plugin と key はリテラルのまま使う（validate がここを読む）
const SESSIONS = { plugin: 'work-board', key: 'sessions' } as const
const TASKS = { plugin: 'work-board', key: 'tasks' } as const
const AGENTS = { plugin: 'work-board', key: 'agents' } as const
const META = { plugin: 'work-board', key: 'meta' } as const
const NOTES = { plugin: 'work-board', key: 'notes' } as const
const PERSONAL = { plugin: 'work-board', key: 'personal' } as const
const VIEW = { plugin: 'work-board', key: 'view' } as const

// $.store（セッションをまたいで残る）のキー
const STORE_NOTES = 'notes-1'
const STORE_PERSONAL = 'personal-1'

const EMPTY_META: BoardMeta = { refreshedAt: 0, error: null }
const EMPTY_NOTE: SessionNote = { status: 'none', memo: '', summary: '', summaryAt: '' }
const EMPTY_VIEW: BoardView = { editingId: null, showDone: false }

// ---- state の書き込み（版を見て3回まで試す） ----

async function setSessions($: EngineInterface, rows: SessionRow[]): Promise<void> {
  const held = await $.state.get(SESSIONS)
  await $.state.set(SESSIONS, rows, { ifVersion: held.version })
}

async function setAgents($: EngineInterface, rows: AgentRow[]): Promise<void> {
  const held = await $.state.get(AGENTS)
  await $.state.set(AGENTS, rows, { ifVersion: held.version })
}

async function setMeta($: EngineInterface, fn: (prev: BoardMeta) => BoardMeta): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const held = await $.state.get(META)
    const done = await $.state.set(META, fn(held.value ?? EMPTY_META), { ifVersion: held.version })
    if (done.isSet) return
  }
}

async function setTasks($: EngineInterface, fn: (prev: TaskItem[]) => TaskItem[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const held = await $.state.get(TASKS)
    const done = await $.state.set(TASKS, fn(held.value ?? []), { ifVersion: held.version })
    if (done.isSet) return
  }
}

async function setView($: EngineInterface, fn: (prev: BoardView) => BoardView): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const held = await $.state.get(VIEW)
    const done = await $.state.set(VIEW, fn(held.value ?? EMPTY_VIEW), { ifVersion: held.version })
    if (done.isSet) return
  }
}

async function setNotes(
  $: EngineInterface,
  fn: (prev: Record<string, SessionNote>) => Record<string, SessionNote>,
): Promise<void> {
  let next: Record<string, SessionNote> | null = null
  for (let i = 0; i < 3; i++) {
    const held = await $.state.get(NOTES)
    next = fn(held.value ?? {})
    const done = await $.state.set(NOTES, next, { ifVersion: held.version })
    if (done.isSet) break
  }
  if (next) await $.store.set(STORE_NOTES, next)
}

async function setPersonal(
  $: EngineInterface,
  fn: (prev: PersonalTask[]) => PersonalTask[],
): Promise<void> {
  let next: PersonalTask[] | null = null
  for (let i = 0; i < 3; i++) {
    const held = await $.state.get(PERSONAL)
    next = fn(held.value ?? [])
    const done = await $.state.set(PERSONAL, next, { ifVersion: held.version })
    if (done.isSet) break
  }
  if (next) await $.store.set(STORE_PERSONAL, next)
}

// 起動時に store から state へ読み戻す
async function loadFromStore($: EngineInterface): Promise<void> {
  const notes = await $.store.get(STORE_NOTES)
  if (notes && typeof notes === 'object' && !Array.isArray(notes)) {
    const held = await $.state.get(NOTES)
    await $.state.set(NOTES, notes as Record<string, SessionNote>, { ifVersion: held.version })
  }
  const personal = await $.store.get(STORE_PERSONAL)
  if (Array.isArray(personal)) {
    const held = await $.state.get(PERSONAL)
    await $.state.set(PERSONAL, personal as PersonalTask[], { ifVersion: held.version })
  }
}

// ---- セッション一覧（ccd_session_mgmt を呼ぶ） ----

type RawSession = {
  sessionId?: string
  title?: string
  isRunning?: boolean
  lastActivityAt?: string
  group?: { name?: string } | null
  link?: string
  name?: string
  startedBy?: string
}

function textOf(result: { content: Array<{ type?: string; text?: string }> }): string {
  return result.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').map(one => one.trim()).find(one => one.length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// 別セッションの直近の発言から「いま何をしているか」を一行にする。
// 最後の [user] の依頼を優先し、無ければ最後の [assistant] の冒頭。
function summarize(transcript: string): string {
  const lines = transcript.split('\n')
  let lastUser = ''
  let lastAssistant = ''
  for (const line of lines) {
    if (line.startsWith('[user] ')) {
      const body = line.slice('[user] '.length).trim()
      if (body && !body.startsWith('<') && !body.startsWith('[')) lastUser = body
    } else if (line.startsWith('[assistant] ')) {
      const body = line.slice('[assistant] '.length).trim()
      if (body) lastAssistant = body
    }
  }
  const picked = lastUser || lastAssistant
  return picked ? firstLine(picked, SUMMARY_CHARS) : ''
}

async function fetchSummary($: EngineInterface, sessionId: string): Promise<string | null> {
  try {
    const res = await $.mcp.call('ccd_session_mgmt', 'list_events', { session_id: sessionId, limit: 12 })
    if (res.isError) return null
    return summarize(textOf(res))
  } catch {
    return null
  }
}

async function refreshSummaries($: EngineInterface, rows: SessionRow[]): Promise<void> {
  const held = await $.state.get(NOTES)
  const notes = held.value ?? {}
  const stale = rows.filter(one => (notes[one.id]?.summaryAt ?? '') !== one.lastActivityAt)
  const picked = stale.slice(0, SUMMARY_FETCHES_PER_REFRESH)
  for (const row of picked) {
    const summary = await fetchSummary($, row.id)
    if (summary === null) continue
    await setNotes($, prev => ({
      ...prev,
      [row.id]: { ...(prev[row.id] ?? EMPTY_NOTE), summary, summaryAt: row.lastActivityAt },
    }))
  }
}

async function refreshSessions($: EngineInterface): Promise<void> {
  try {
    const res = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: SESSION_LIMIT })
    if (res.isError) throw new Error(textOf(res).slice(0, 200))
    const raw = JSON.parse(textOf(res)) as RawSession[]
    const rows: SessionRow[] = raw
      .filter(one => typeof one.sessionId === 'string')
      .map(one => ({
        id: one.sessionId as string,
        title: one.title ?? '(無題)',
        isRunning: one.isRunning === true,
        lastActivityAt: one.lastActivityAt ?? '',
        group: one.group?.name ?? null,
        link: one.link ?? null,
        isLinked: typeof one.startedBy === 'string' || typeof one.name === 'string',
      }))
    await setSessions($, rows)
    const now = await $.clock.now()
    await setMeta($, () => ({ refreshedAt: now, error: null }))
    await refreshSummaries($, rows)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await setMeta($, prev => ({ ...prev, error: message }))
  }
}

async function refreshAgents($: EngineInterface): Promise<void> {
  try {
    const list = await $.agent.list()
    const rows: AgentRow[] = list.map(one => ({
      id: one.id,
      description: one.description,
      type: one.type,
      status: one.status,
    }))
    await setAgents($, rows)
  } catch {
    // サブエージェント一覧が取れない時は前の値を残す
  }
}

async function refreshAll($: EngineInterface): Promise<void> {
  await Promise.all([refreshSessions($), refreshAgents($)])
}

// ---- Claude のタスク（update_plan の呼び出しを横で読む） ----

type PlanArgs = {
  items?: Array<{ content?: string; status?: string }>
  advance?: boolean
  done?: number[]
  start?: number
}

function isStatus(value: unknown): value is TaskItem['status'] {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

function applyPlan(prev: TaskItem[], args: PlanArgs): TaskItem[] {
  if (Array.isArray(args.items)) {
    return args.items
      .filter(one => typeof one.content === 'string')
      .map(one => ({
        content: one.content as string,
        status: isStatus(one.status) ? one.status : 'pending',
      }))
  }
  let list = prev.map(one => ({ ...one }))
  if (Array.isArray(args.done)) {
    for (const n of args.done) {
      const item = list[n - 1]
      if (item) item.status = 'completed'
    }
  }
  if (typeof args.start === 'number') {
    list = list.map(one => (one.status === 'in_progress' ? { ...one, status: 'completed' } : one))
    const item = list[args.start - 1]
    if (item) item.status = 'in_progress'
  }
  if (args.advance) {
    const current = list.findIndex(one => one.status === 'in_progress')
    if (current >= 0) list[current].status = 'completed'
    const nextIdx = list.findIndex(one => one.status === 'pending')
    if (nextIdx >= 0) list[nextIdx].status = 'in_progress'
  }
  return list
}

// ---- 表示の補助 ----

function ago(iso: string, nowMs: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const min = Math.max(0, Math.round((nowMs - t) / 60_000))
  if (min < 1) return '今'
  if (min < 60) return `${min}分前`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}時間前`
  return `${Math.round(hours / 24)}日前`
}

function clock(ms: number): string {
  if (!ms) return '--:--'
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function taskGlyph(status: TaskItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '▶'
  return '○'
}

/** 表示上のステータス: 人が付けたものを優先し、未設定でも動いていれば作業中 */
function effectiveStatus(row: SessionRow, note: SessionNote | undefined): SessionStatus {
  const set = note?.status ?? 'none'
  if (set !== 'none') return set
  return row.isRunning ? 'active' : 'none'
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: '作業中',
  waiting: '待ち',
  done: '完了',
  none: '未設定',
}

const STATUS_COLOR: Record<SessionStatus, 'success' | 'warning' | 'merged' | 'text'> = {
  active: 'success',
  waiting: 'warning',
  done: 'merged',
  none: 'text',
}

const SECTIONS = [
  { key: 'sec-personal', label: '自分のタスク' },
  { key: 'sec-progress', label: 'このセッション' },
  { key: 'sec-sessions', label: 'セッション一覧' },
] as const

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

// ---- 登録 ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'board',
      description: '作業ボード（セッション一覧・個人タスク）を右側に開く',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void loadFromStore($).then(() => refreshAll($))
    $.clock.every(REFRESH_MS, () => {
      void refreshAll($)
    })
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refreshAll($)
    return { text: '作業ボードを開きました。' }
  })

  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const args = e as unknown as PlanArgs
    await setTasks($, prev => applyPlan(prev, args))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    await setTasks($, prev => prev.map(one => ({ ...one, status: 'completed' as const })))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__ccd_session__start_session' }, async ($, e, next) => {
    const ran = await next(e)
    void refreshAll($)
    return ran
  })
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    void refreshAgents($)
    const ran = await next(e)
    void refreshAgents($)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const [hs, ht, ha, hm, hn, hp, hv] = await Promise.all([
      $.state.get(SESSIONS),
      $.state.get(TASKS),
      $.state.get(AGENTS),
      $.state.get(META),
      $.state.get(NOTES),
      $.state.get(PERSONAL),
      $.state.get(VIEW),
    ])
    const list = hs.value ?? []
    const todo = ht.value ?? []
    const subs = ha.value ?? []
    const info = hm.value ?? EMPTY_META
    const notes = hn.value ?? {}
    const personal = hp.value ?? []
    const view = hv.value ?? EMPTY_VIEW
    const nowMs = info.refreshedAt || Date.now()

    const liveAgents = subs.filter(
      one => one.status === 'running' || one.status === 'pending' || one.status === 'waiting',
    )
    const remaining = todo.filter(one => one.status !== 'completed').length

    const jump = (key: string) => void $.ui.scroll({ in: PANE, to: { key }, block: 'start' })

    const setStatus = (id: string, status: SessionStatus) =>
      void setNotes($, prev => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_NOTE), status } }))
    const setMemo = (id: string, memo: string) =>
      void setNotes($, prev => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_NOTE), memo: memo.trim() } })).then(
        () => setView($, prev => ({ ...prev, editingId: null })),
      )

    const byStatus: Record<SessionStatus, SessionRow[]> = { active: [], waiting: [], none: [], done: [] }
    for (const row of list) byStatus[effectiveStatus(row, notes[row.id])].push(row)

    const sessionRow = (s: SessionRow) => {
      const note = notes[s.id] ?? EMPTY_NOTE
      const status = effectiveStatus(s, note)
      const isEditing = view.editingId === s.id
      const line = note.memo || note.summary
      return (
        <Box
          flexDirection="column"
          gap="xs"
          borderStyle="round"
          borderDimColor
          paddingX="sm"
          paddingY="xs"
          marginBottom="xs"
        >
          <Box flexDirection="row" gap="xs" alignItems="center">
            <Text color={STATUS_COLOR[status]}>{s.isRunning ? '●' : '○'}</Text>
            <Text weight="semibold">{s.title}</Text>
          </Box>
          {line ? (
            <Text size="caption" dimColor={!note.memo}>
              {note.memo ? '📝 ' : '→ '}
              {line}
            </Text>
          ) : (
            <Text size="caption" dimColor>（要約を取得中）</Text>
          )}
          <Text dimColor size="caption">
            {[s.group, ago(s.lastActivityAt, nowMs), s.isLinked ? '子セッション' : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Box flexDirection="row" gap="xs" alignItems="center">
            {(['active', 'waiting', 'done'] as const).map(one => (
              <Button
                key={`st-${one}-${s.id}`}
                onPress={() => setStatus(s.id, note.status === one ? 'none' : one)}
              >
                <Text color={STATUS_COLOR[one]} inverse={status === one} dimColor={status !== one}>
                  {status === one ? ` ● ${STATUS_LABEL[one]} ` : ` ${STATUS_LABEL[one]} `}
                </Text>
              </Button>
            ))}
            <Button
              key={`memo-${s.id}`}
              plain
              dimColor
              onPress={() => void setView($, prev => ({ ...prev, editingId: isEditing ? null : s.id }))}
            >
              {isEditing ? '閉じる' : 'メモ'}
            </Button>
          </Box>
          {isEditing && (
            <Input
              key={`memo-input-${s.id}`}
              value={note.memo}
              placeholder="このセッションで何をしているか（Enter で保存、空で消す）"
              submitLabel="保存"
              autoFocus
              onSubmit={value => setMemo(s.id, value)}
            />
          )}
        </Box>
      )
    }

    const section = (label: string, rows: SessionRow[]) =>
      rows.length === 0 ? null : (
        <Box flexDirection="column" gap="xs">
          <Text weight="semibold" size="caption" dimColor>
            {label} {rows.length}
          </Text>
          {rows.map(sessionRow)}
        </Box>
      )

    const openPersonal = personal.filter(one => !one.isDone)
    const donePersonal = personal.filter(one => one.isDone)

    return (
      <Box flexDirection="column" gap="sm" padding="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="heading" weight="semibold">{TITLE}</Text>
          <Box flexDirection="row" gap="xs" alignItems="center">
            <Text dimColor size="caption">{clock(info.refreshedAt)} 更新</Text>
            <Button key="refresh" plain onPress={() => void refreshAll($)}>
              更新
            </Button>
          </Box>
        </Box>
        {info.error && (
          <Text color="warning" size="caption">
            セッション一覧の取得に失敗: {info.error}
          </Text>
        )}

        {/* タブ: 押すと該当セクションまでスクロール */}
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          {SECTIONS.map(sec => (
            <Button key={`tab-${sec.key}`} onPress={() => jump(sec.key)}>
              {sec.label}
            </Button>
          ))}
        </Box>

        {/* 自分のタスク */}
        <Box key="sec-personal" flexDirection="column" gap="xs">
          <Text weight="semibold">
            自分のタスク{' '}
            <Text dimColor size="caption">
              {openPersonal.length > 0 ? `残り ${openPersonal.length}` : ''}
            </Text>
          </Text>
          <Input
            key="personal-add"
            placeholder="タスクを書いて Enter で追加"
            submitLabel="追加"
            onSubmit={value => {
              const text = value.trim()
              if (!text) return
              void setPersonal($, prev => [
                ...prev,
                { id: newId(), text, isDone: false, createdAt: Date.now() },
              ])
            }}
          />
          {openPersonal.length === 0 && donePersonal.length === 0 && (
            <Text dimColor>まだありません</Text>
          )}
          {openPersonal.map(one => (
            <Box flexDirection="row" gap="xs" alignItems="center">
              <Button
                key={`p-done-${one.id}`}
                plain
                onPress={() =>
                  void setPersonal($, prev =>
                    prev.map(t => (t.id === one.id ? { ...t, isDone: true } : t)),
                  )
                }
              >
                ☐
              </Button>
              <Text>{one.text}</Text>
              <Button
                key={`p-del-${one.id}`}
                plain
                dimColor
                onPress={() => void setPersonal($, prev => prev.filter(t => t.id !== one.id))}
              >
                ×
              </Button>
            </Box>
          ))}
          {donePersonal.length > 0 && (
            <Button
              key="personal-toggle-done"
              plain
              dimColor
              onPress={() => void setView($, prev => ({ ...prev, showDone: !prev.showDone }))}
            >
              {view.showDone ? `完了を隠す (${donePersonal.length})` : `完了を見る (${donePersonal.length})`}
            </Button>
          )}
          {view.showDone &&
            donePersonal.map(one => (
              <Box flexDirection="row" gap="xs" alignItems="center">
                <Button
                  key={`p-undo-${one.id}`}
                  plain
                  dimColor
                  onPress={() =>
                    void setPersonal($, prev =>
                      prev.map(t => (t.id === one.id ? { ...t, isDone: false } : t)),
                    )
                  }
                >
                  ☑
                </Button>
                <Text dimColor strikethrough>{one.text}</Text>
                <Button
                  key={`p-del-${one.id}`}
                  plain
                  dimColor
                  onPress={() => void setPersonal($, prev => prev.filter(t => t.id !== one.id))}
                >
                  ×
                </Button>
              </Box>
            ))}
        </Box>

        {/* Claude がこのセッションで進めているタスク */}
        <Box key="sec-progress" flexDirection="column" gap="xs">
          <Text weight="semibold">
            このセッションの進み{' '}
            <Text dimColor size="caption">
              {todo.length === 0 ? '' : `残り ${remaining}/${todo.length}`}
            </Text>
          </Text>
          {todo.length === 0 && <Text dimColor>作業中のタスクはありません</Text>}
          {todo.map(one => (
            <Box flexDirection="row" gap="xs">
              <Text
                color={
                  one.status === 'completed'
                    ? 'success'
                    : one.status === 'in_progress'
                      ? 'claude'
                      : 'inactive'
                }
              >
                {taskGlyph(one.status)}
              </Text>
              <Text dimColor={one.status === 'completed'} strikethrough={one.status === 'completed'}>
                {one.content}
              </Text>
            </Box>
          ))}
        </Box>

        {liveAgents.length > 0 && (
          <Box flexDirection="column" gap="xs">
            <Text weight="semibold">動いているサブエージェント</Text>
            {liveAgents.map(one => (
              <Box flexDirection="row" gap="xs">
                <Text color="claude">⟳</Text>
                <Text>{one.description || one.type}</Text>
                <Text dimColor size="caption">{one.status}</Text>
              </Box>
            ))}
          </Box>
        )}

        {/* 他のセッション */}
        <Box key="sec-sessions" flexDirection="column" gap="xs">
          <Text weight="semibold">
            他のセッション{' '}
            <Text dimColor size="caption">
              {byStatus.active.length > 0 ? `${byStatus.active.length} 件が作業中` : `${list.length} 件`}
            </Text>
          </Text>
          {list.length === 0 && !info.error && <Text dimColor>読み込み中…</Text>}
          {section('作業中', byStatus.active)}
          {section('待ち', byStatus.waiting)}
          {section('未設定', byStatus.none)}
          {byStatus.done.length > 0 && (
            <Button
              key="sessions-toggle-done"
              plain
              dimColor
              onPress={() => void setView($, prev => ({ ...prev, showDone: !prev.showDone }))}
            >
              {view.showDone ? `完了を隠す (${byStatus.done.length})` : `完了を見る (${byStatus.done.length})`}
            </Button>
          )}
          {view.showDone && section('完了', byStatus.done)}
        </Box>
      </Box>
    )
  })
}
