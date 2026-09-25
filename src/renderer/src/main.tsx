import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView, basicSetup } from 'codemirror'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ModelSettings, RoundMode, SessionSummary, WorkspaceSnapshot } from '../../shared/contracts'
import './styles.css'

const modeLabels: Record<RoundMode, string> = { plan: 'Plan', vibe: 'Vibe', loop: 'Loop' }
const statusLabels: Record<string, string> = {
  active: '进行中', completed: '已完成', blocked: '已阻塞', budget_exhausted: '预算已耗尽', failed: '失败', interrupted: '已中断'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function CodeMirrorEditor({ value, onChange, onFocus, onBlur }: {
  value: string
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const applyingExternalValue = useRef(false)
  const callbacks = useRef({ onChange, onFocus, onBlur })
  callbacks.current = { onChange, onFocus, onBlur }

  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      doc: value,
      parent: host.current,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Spec Markdown' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !applyingExternalValue.current) callbacks.current.onChange(update.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          focus: () => callbacks.current.onFocus(),
          blur: () => callbacks.current.onBlur()
        })
      ]
    })
    view.current = editor
    return () => { editor.destroy(); view.current = null }
  }, [])

  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    applyingExternalValue.current = true
    try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } }) }
    finally { applyingExternalValue.current = false }
  }, [value])

  return <div className="code-editor" ref={host} />
}

function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<RoundMode>('plan')
  const [selectedId, setSelectedId] = useState<string | 'history' | null>(null)
  const [sourceView, setSourceView] = useState(true)
  const [runnerOpen, setRunnerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [credential, setCredential] = useState('')
  const editorFocused = useRef(false)
  const localDraftDirty = useRef(false)
  const snapshotRef = useRef<WorkspaceSnapshot | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ draft, mode })
  latest.current = { draft, mode }

  function applySnapshot(next: WorkspaceSnapshot): void {
    const previous = snapshotRef.current
    const sessionChanged = previous?.session?.id !== next.session?.id
    snapshotRef.current = next
    setSnapshot(next)
    if (sessionChanged) localDraftDirty.current = false
    if (sessionChanged || (!editorFocused.current && !localDraftDirty.current)) {
      setDraft(next.draft)
      setMode(next.mode)
    }
    if (sessionChanged) {
      setSelectedId(next.rounds.at(-1)?.id ?? (next.importedHistoryMarkdown?.trim() ? 'history' : null))
    } else if (previous && next.rounds.length > previous.rounds.length) {
      setSelectedId(next.rounds.at(-1)?.id ?? null)
    }
    if (next.running && !previous?.running) setRunnerOpen(true)
  }

  useEffect(() => {
    let active = true
    const unsubscribe = window.temporal.onSnapshot(next => { if (active) applySnapshot(next) })
    window.temporal.getSnapshot().then(next => {
      if (!active) return
      applySnapshot(next)
      setWorkspacePath(next.workspacePath)
    }).catch(e => { if (active) setError(messageOf(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!workspacePath || snapshot?.session) return
    let active = true
    setBusy(true)
    window.temporal.listSessions(workspacePath).then(items => { if (active) setSessions(items) })
      .catch(e => { if (active) setError(messageOf(e)) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [workspacePath, snapshot?.session?.id])

  function queueDraft(nextDraft: string, nextMode: RoundMode): void {
    localDraftDirty.current = true
    setDraft(nextDraft)
    setMode(nextMode)
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      window.temporal.saveDraft(nextDraft, nextMode).catch(e => setError(`草稿保存失败：${messageOf(e)}`))
    }, 450)
  }

  async function chooseWorkspace(): Promise<void> {
    try {
      setError('')
      const path = await window.temporal.chooseWorkspace()
      if (path) { setWorkspacePath(path); setSessions([]) }
    } catch (e) { setError(messageOf(e)) }
  }

  async function openSession(sessionId?: string): Promise<void> {
    if (!workspacePath) return
    setBusy(true)
    setError('')
    try {
      const next = await window.temporal.openSession(workspacePath, sessionId)
      editorFocused.current = false
      applySnapshot(next)
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  async function submit(): Promise<void> {
    const spec = latest.current.draft.trim()
    if (!spec || !snapshot?.session || snapshot.running) return
    if (draftTimer.current) clearTimeout(draftTimer.current)
    setBusy(true)
    setError('')
    setRunnerOpen(true)
    try {
      await window.temporal.saveDraft(latest.current.draft, latest.current.mode)
      await window.temporal.submit(spec, latest.current.mode)
      applySnapshot(await window.temporal.getSnapshot())
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  async function endRound(): Promise<void> {
    if (!snapshot?.session || snapshot.running) return
    setBusy(true)
    setError('')
    try { await window.temporal.endRound(); applySnapshot(await window.temporal.getSnapshot()) }
    catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  async function showSettings(): Promise<void> {
    setError('')
    try { setSettings(await window.temporal.getModelSettings()); setCredential(''); setSettingsOpen(true) }
    catch (e) { setError(messageOf(e)) }
  }

  async function saveSettings(): Promise<void> {
    if (!settings) return
    setBusy(true)
    setError('')
    try {
      const saved = await window.temporal.saveModelSettings({
        provider: settings.provider.trim(), model: settings.model.trim(), baseUrl: settings.baseUrl?.trim() || undefined,
        ...(credential ? { credential } : {})
      })
      setSettings(saved)
      setCredential('')
      setSettingsOpen(false)
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  const selectedRound = snapshot?.rounds.find(round => round.id === selectedId)
  const runnerEvents = snapshot?.runnerEvents ?? []

  return <div className="app-shell">
    <header className="titlebar">
      <div className="brand"><span className="brand-mark">T</span><span>Temporal Workspace</span></div>
      <span className="title-context">{snapshot?.session?.title ?? 'Workspace'}</span>
      <button className="text-button settings-trigger" onClick={showSettings} aria-label="模型设置">模型设置</button>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
    {snapshot?.error && snapshot.error !== error && <div className="error-banner" role="alert">{snapshot.error}</div>}

    {loading ? <main className="center-stage"><p>正在加载工作区…</p></main> : !snapshot?.session ?
      <main className="launcher center-stage">
        <div className="launcher-content">
          <div className="eyebrow">TEMPORAL WORKSPACE</div>
          <h1>{workspacePath ? '选择一个 Session' : '打开一个 Workspace'}</h1>
          <p className="muted">{workspacePath ? '继续本产品已记录的 Session，或在此目录中开始新工作。' : '先选择项目目录，再继续已有 Session 或创建新的 Session。'}</p>
          <div className="launch-card">
            <div className="launch-card-head"><div><strong>Workspace</strong><span>{workspacePath ?? '尚未选择目录'}</span></div><button className="secondary-button" onClick={chooseWorkspace} disabled={busy}>{workspacePath ? '更换目录' : '选择目录'}</button></div>
            {workspacePath && <div className="session-list">
              {sessions.map(item => <button className="session-row" key={item.id} onClick={() => openSession(item.id)} disabled={busy}>
                <span className="session-icon">{item.title.slice(0, 1).toUpperCase()}</span><span className="session-row-copy"><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleString()} · {item.hasTemporalHistory ? 'Temporal Session' : '尚无 Temporal Round'}</small></span><span className="row-arrow">→</span>
              </button>)}
              {sessions.length === 0 && !busy && <p className="empty-sessions">暂无本产品记录的 Session；DSH 原生 Session 发现尚未接入。</p>}
              <button className="session-row new-session" onClick={() => openSession()} disabled={busy}>
                <span className="session-icon">＋</span><span className="session-row-copy"><strong>New Session</strong><small>创建后从 Plan 开始</small></span><span className="row-arrow">→</span>
              </button>
            </div>}
          </div>
          {busy && <p className="muted loading-caption">正在读取 Session…</p>}
        </div>
      </main> :
      <main className={`workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className="sidebar" aria-label="Session 时间线">
          <div className="sidebar-header"><button className="icon-button" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}>{sidebarCollapsed ? '›' : '‹'}</button><div className="sidebar-name"><strong>{snapshot.session.title}</strong><small title={snapshot.workspacePath ?? ''}>{snapshot.workspacePath}</small></div></div>
          <nav className="timeline" aria-label="Round 列表">
            {snapshot.importedHistoryMarkdown?.trim() && <button className={`timeline-item ${selectedId === 'history' ? 'selected' : ''}`} onClick={() => setSelectedId('history')} title="Imported DSH Session History"><span className="round-index">H</span><span className="timeline-copy"><strong>Imported History</strong><small>DSH 原生历史 · 只读</small></span></button>}
            {snapshot.rounds.map(round => <button key={round.id} className={`timeline-item ${selectedId === round.id ? 'selected' : ''}`} onClick={() => setSelectedId(round.id)} title={`Round ${round.sequence} · ${modeLabels[round.mode]} · ${statusLabels[round.status]}`}>
              <span className="round-index">{round.sequence}</span><span className="timeline-copy"><strong>{round.title || `Round ${round.sequence}`}</strong><small>{modeLabels[round.mode]} · {statusLabels[round.status]}</small></span>
            </button>)}
          </nav>
          {snapshot.running && !runnerOpen && <button className="runner-mini" onClick={() => setRunnerOpen(true)} aria-label="展开 Runner"><span className="live-dot"/><span className="runner-mini-label">正在运行 · 查看过程</span></button>}
        </aside>
        <section className="result-pane" aria-label="结果页面">
          {selectedRound ? <article className="document"><div className="document-header"><div className="eyebrow">ROUND {selectedRound.sequence} · {modeLabels[selectedRound.mode]}</div><h1>{selectedRound.title}</h1><div className="document-meta"><span className={`status status-${selectedRound.status}`}>{statusLabels[selectedRound.status]}</span><span>{new Date(selectedRound.updatedAt).toLocaleString()}</span></div></div><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedRound.bodyMarkdown || '本轮尚无结果。'}</ReactMarkdown></div></article>
            : selectedId === 'history' && snapshot.importedHistoryMarkdown?.trim() ? <article className="document"><div className="document-header"><div className="eyebrow">IMPORTED DSH SESSION</div><h1>History</h1><p>原生历史只读继承；Temporal Round 从首次提交开始。</p></div><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{snapshot.importedHistoryMarkdown}</ReactMarkdown></div></article>
            : <div className="blank-state"><div className="blank-symbol">⌁</div><h2>暂无结果</h2><p>在右侧写下目标，选择模式并提交。若这是已有 DSH Session，其原生历史目前没有可展示的数据。</p></div>}
          {runnerOpen && <section className="runner-panel" aria-label="Runner 事件"><div className="runner-header"><div><span className={snapshot.running ? 'live-dot' : 'idle-dot'}/><strong>{snapshot.running ? 'Running' : 'Runner'}</strong><span>{modeLabels[mode]}</span></div><button onClick={() => setRunnerOpen(false)} aria-label="收起 Runner">收起</button></div><div className="runner-events" role="log" aria-live="polite">{runnerEvents.length ? runnerEvents.map(event => <div className={`runner-event event-${event.kind}`} key={event.id}><span>{event.kind}</span><p>{event.message}</p></div>) : <p className="runner-empty">等待运行事件…</p>}</div></section>}
        </section>
        <section className="spec-pane" aria-label="Spec 编辑器"><div className="spec-toolbar"><div className="segmented" aria-label="运行模式">{(['plan', 'vibe', 'loop'] as const).map(item => <button key={item} className={mode === item ? 'active' : ''} onClick={() => queueDraft(draft, item)} disabled={snapshot.running || busy || item === 'loop'} title={item === 'loop' ? 'Loop 尚未通过架构验收' : undefined} aria-pressed={mode === item}>{modeLabels[item]}</button>)}</div><div className="segmented" aria-label="编辑器视图"><button className={sourceView ? 'active' : ''} onClick={() => setSourceView(true)} aria-pressed={sourceView}>Source</button><button className={!sourceView ? 'active' : ''} onClick={() => setSourceView(false)} aria-pressed={!sourceView}>MD</button></div></div>
          <div className="spec-body"><div className={`editor-container ${sourceView ? '' : 'hidden'}`}><CodeMirrorEditor key={snapshot.session.id} value={draft} onFocus={() => { editorFocused.current = true }} onBlur={() => { editorFocused.current = false }} onChange={value => queueDraft(value, mode)}/>{!draft && <span className="editor-placeholder" aria-hidden="true"># Spec<br/><br/>描述希望完成的工作…</span>}</div><div className={`spec-preview markdown-body ${sourceView ? 'hidden' : ''}`}>{draft.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown> : <p className="muted">Spec 预览会显示在这里。</p>}</div></div>
          <div className="spec-footer"><p>{mode === 'loop' ? 'Loop 尚未通过架构验收，暂不可提交' : snapshot.running ? '当前任务正在执行' : 'Spec 会自动保存到当前 Session'}</p><div className="footer-actions"><button className="secondary-button" onClick={endRound} disabled={busy || snapshot.running || !snapshot.rounds.some(round => round.status === 'active')}>结束当前轮次</button><button className="primary-button" onClick={submit} disabled={busy || snapshot.running || mode === 'loop' || !draft.trim()}>{snapshot.running ? '运行中…' : '提交'}</button></div></div>
        </section>
      </main>}

    {settingsOpen && settings && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-header"><div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">模型设置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">×</button></div>{error && <div className="dialog-error" role="alert">{error}</div>}<div className="settings-fields"><label>Provider<input value={settings.provider} onChange={event => setSettings({ ...settings, provider: event.target.value })} placeholder="deepseek-official"/></label><label>Model<input value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} placeholder="模型名称"/></label><label>Base URL <small>可选</small><input value={settings.baseUrl ?? ''} onChange={event => setSettings({ ...settings, baseUrl: event.target.value })} placeholder="https://…"/></label><label>API 凭证 <small>{settings.hasCredential ? '已保存；留空则保持原凭证' : '尚未保存'}</small><input type="password" autoComplete="new-password" value={credential} onChange={event => setCredential(event.target.value)} placeholder={settings.hasCredential ? '输入新凭证以替换' : '输入 API 凭证'}/></label></div><div className="dialog-actions"><button className="secondary-button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary-button" onClick={saveSettings} disabled={busy || !settings.provider.trim() || !settings.model.trim()}>保存设置</button></div></section></div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
