import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView, basicSetup } from 'codemirror'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EvidenceSummary, ModelSettings, PermissionPreset, ResultSummary, RoundDetail, RoundMode, SessionSummary, WorkspaceSnapshot } from '../../shared/contracts'
import './styles.css'

const modeLabels: Record<RoundMode, string> = { plan: 'Plan', vibe: 'Vibe', loop: 'Loop' }
const statusLabels: Record<string, string> = {
  active: '进行中', completed: '已完成', blocked: '已阻塞', budget_exhausted: '预算已耗尽', failed: '失败', interrupted: '已中断'
}
const kindLabels: Record<SessionSummary['kind'], string> = {
  new: '尚无 Temporal Round',
  temporal: 'Temporal Session',
  legacy: 'DSH 原生 Session · 无 Temporal Round'
}
const permissionLabels: Record<PermissionPreset, string> = {
  'read-only': 'Read-only（只读）',
  'workspace-write': 'Workspace-write（工作区可写，默认）',
  'danger-full-access': 'Danger full access（完全访问）'
}
const evidenceKindLabels: Record<EvidenceSummary['kind'], string> = {
  command: '命令', workspace: '工作区', artifact: '产物', manual: '人工', runtime: '运行时'
}

function ResultView({ result }: { result: ResultSummary }): React.JSX.Element {
  return <div className="result-block">
    {result.summary && <p className="result-summary">{result.summary}</p>}
    {result.loopTerminal && <div className={`loop-terminal loop-${result.loopTerminal.status}`}><strong>Loop {statusLabels[result.loopTerminal.status] ?? result.loopTerminal.status}</strong><span>{result.loopTerminal.reason}</span></div>}
    {result.changes.length > 0 && <section className="result-section"><h3>Changes</h3><ul>{result.changes.map(change => <li key={change}><code>{change}</code></li>)}</ul></section>}
    {result.verification.length > 0 && <section className="result-section"><h3>Verification</h3><ul>{result.verification.map(line => <li key={line}>{line}</li>)}</ul></section>}
    {result.remaining.length > 0 && <section className="result-section remaining"><h3>Remaining</h3><ul>{result.remaining.map(line => <li key={line}>{line}</li>)}</ul></section>}
  </div>
}

function EvidenceList({ evidence }: { evidence: EvidenceSummary[] }): React.JSX.Element | null {
  if (evidence.length === 0) return null
  return <section className="evidence-block"><h3>Evidence</h3>
    <div className="evidence-rows">{evidence.map(item => <div className={`evidence-row evidence-${item.outcome}`} key={item.id}>
      <span className="evidence-kind">{evidenceKindLabels[item.kind]}</span>
      <span className="evidence-label" title={item.detail}>{item.label}</span>
      <span className="evidence-outcome">{item.outcome}</span>
    </div>)}</div>
  </section>
}

function RoundView({ round }: { round: RoundDetail }): React.JSX.Element {
  const latestVersionIndex = Math.max(round.planVersions.length - 1, 0)
  const [versionIndex, setVersionIndex] = useState(latestVersionIndex)
  // A new Plan version (Plan×N) jumps the view to the latest; manual tab
  // selection still works until the next version arrives.
  useEffect(() => { setVersionIndex(latestVersionIndex) }, [latestVersionIndex])
  const header = <div className="document-header">
    <div className="eyebrow">ROUND {round.sequence} · {modeLabels[round.mode]}</div>
    <h1>{round.title}</h1>
    <div className="document-meta"><span className={`status status-${round.status}`}>{statusLabels[round.status]}</span><span>{new Date(round.updatedAt).toLocaleString()}</span></div>
  </div>

  if (round.mode === 'plan') {
    const version = round.planVersions[versionIndex]
    return <article className="document">
      {header}
      {round.planVersions.length > 1 && <div className="version-tabs" role="tablist" aria-label="Plan 版本">
        {round.planVersions.map((item, index) => <button key={item.id} role="tab" aria-selected={index === versionIndex} className={index === versionIndex ? 'active' : ''} onClick={() => setVersionIndex(index)}>v{item.ordinal}</button>)}
      </div>}
      <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{version?.planMarkdown || round.bodyMarkdown || '本轮尚无计划。'}</ReactMarkdown></div>
      {version && version.submittedSpec.trim() && version.submittedSpec.trim() !== (version.planMarkdown ?? '').trim() && <details className="submitted-spec"><summary>本次提交的 Spec</summary><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{version.submittedSpec}</ReactMarkdown></div></details>}
      <EvidenceList evidence={round.evidence} />
    </article>
  }

  if (round.mode === 'vibe') {
    return <article className="document">
      {header}
      {round.result ? <ResultView result={round.result} /> : <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{round.bodyMarkdown || '本轮尚无结果。'}</ReactMarkdown></div>}
      {round.vibeEntries.length > 0 && <section className="vibe-timeline"><h3>执行记录</h3>
        {round.vibeEntries.map(entry => <article className="vibe-entry" key={entry.id}>
          <div className="vibe-entry-head"><span>#{entry.ordinal}</span><span className="vibe-outcome">{entry.executionOutcome}</span><span className="vibe-time">{new Date(entry.createdAt).toLocaleString()}</span></div>
          <div className="vibe-entry-body">
            <div className="vibe-spec"><h4>Spec</h4><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.specMarkdown}</ReactMarkdown></div></div>
            <div className="vibe-output"><h4>Output</h4><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.assistantOutput || '（无输出）'}</ReactMarkdown></div></div>
          </div>
        </article>)}
      </section>}
      <EvidenceList evidence={round.evidence} />
    </article>
  }

  return <article className="document">
    {header}
    {round.result ? <ResultView result={round.result} /> : <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{round.bodyMarkdown || '本轮尚未产生终态结果。'}</ReactMarkdown></div>}
    <EvidenceList evidence={round.evidence} />
  </article>
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
  const [discoveryError, setDiscoveryError] = useState('')
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<RoundMode>('plan')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sourceView, setSourceView] = useState(true)
  const [runnerOpen, setRunnerOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [permission, setPermission] = useState<PermissionPreset>('workspace-write')
  const [credential, setCredential] = useState('')
  const editorFocused = useRef(false)
  const localDraftDirty = useRef(false)
  const snapshotRef = useRef<WorkspaceSnapshot | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runnerEventsHost = useRef<HTMLDivElement>(null)
  const runnerFollowLatest = useRef(true)
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
      setSelectedId(next.rounds.at(-1)?.id ?? null)
    } else if (previous && next.rounds.length > previous.rounds.length) {
      setSelectedId(next.rounds.at(-1)?.id ?? null)
    }
    if (next.running && !previous?.running) {
      runnerFollowLatest.current = true
      setRunnerOpen(true)
    }
    if (previous?.running && !next.running) {
      setRunnerOpen(false)
      setCancelling(false)
    }
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
    window.temporal.listSessions(workspacePath).then(result => {
      if (!active) return
      setSessions(result.sessions)
      setDiscoveryError(result.discoveryError ?? '')
    })
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
      if (path) { setWorkspacePath(path); setSessions([]); setDiscoveryError('') }
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
    setCancelling(false)
    setRunnerOpen(true)
    try {
      await window.temporal.saveDraft(latest.current.draft, latest.current.mode)
      await window.temporal.submit(spec, latest.current.mode)
      // The product owns the draft after a submit (it clears/replaces it);
      // stop treating the local editor as the source of truth so incoming
      // snapshots refresh the editor again.
      localDraftDirty.current = false
      applySnapshot(await window.temporal.getSnapshot())
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  async function cancelRun(): Promise<void> {
    if (!snapshot?.running || cancelling) return
    setCancelling(true)
    setError('')
    try {
      const accepted = await window.temporal.cancelRun()
      if (!accepted) setCancelling(false)
    } catch (e) {
      setCancelling(false)
      setError(messageOf(e))
    }
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
    try {
      setSettings(await window.temporal.getModelSettings())
      setPermission(snapshotRef.current?.permission ?? 'workspace-write')
      setCredential('')
      setSettingsOpen(true)
    }
    catch (e) { setError(messageOf(e)) }
  }

  async function changePermission(next: PermissionPreset): Promise<void> {
    setError('')
    try {
      await window.temporal.setPermission(next)
      setPermission(next)
    } catch (e) { setError(messageOf(e)) }
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

  useEffect(() => {
    if (!runnerOpen || !runnerFollowLatest.current) return
    const host = runnerEventsHost.current
    if (!host) return
    const frame = requestAnimationFrame(() => {
      host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [runnerEvents.length, runnerOpen])

  function handleRunnerScroll(): void {
    const host = runnerEventsHost.current
    if (!host) return
    const distanceFromBottom = host.scrollHeight - host.scrollTop - host.clientHeight
    runnerFollowLatest.current = distanceFromBottom < 48
  }

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
                <span className="session-icon">{item.title.slice(0, 1).toUpperCase()}</span><span className="session-row-copy"><strong>{item.title}</strong><small>{item.updatedAt ? `${new Date(item.updatedAt).toLocaleString()} · ` : ''}{kindLabels[item.kind]}</small></span><span className="row-arrow">→</span>
              </button>)}
              {sessions.length === 0 && !busy && <p className="empty-sessions">该目录暂无已有 Session；可直接新建。</p>}
              {discoveryError && <p className="empty-sessions" role="alert">DSH 原生 Session 发现失败：{discoveryError}</p>}
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
          <div className="sidebar-header"><button className="icon-button sidebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'} title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}><span className="sidebar-toggle-glyph" aria-hidden="true"><i/></span></button><div className="sidebar-name"><strong>{snapshot.session.title}</strong><small title={snapshot.workspacePath ?? ''}>{snapshot.workspacePath}</small></div></div>
          <nav className="timeline" aria-label="Round 列表">
            {snapshot.rounds.map(round => <button key={round.id} className={`timeline-item ${selectedId === round.id ? 'selected' : ''}`} onClick={() => setSelectedId(round.id)} title={`Round ${round.sequence} · ${modeLabels[round.mode]} · ${statusLabels[round.status]}`}>
              <span className="thumbnail-page" data-round={round.sequence}>
                <span className="thumbnail-eyebrow">{modeLabels[round.mode]} · Round {round.sequence}</span>
                <span className="thumbnail-title">{round.title || `Round ${round.sequence}`}</span>
                <span className="thumbnail-lines" aria-hidden="true"><i/><i/><i/><i/></span>
                <span className={`thumbnail-state state-${round.status}`}>{statusLabels[round.status]}</span>
              </span>
              <span className="timeline-copy"><strong>{round.title || `Round ${round.sequence}`}</strong><small>{modeLabels[round.mode]}</small></span>
            </button>)}
          </nav>
          <button className={`runner-mini ${snapshot.running && !runnerOpen ? 'visible' : ''}`} onClick={() => { runnerFollowLatest.current = true; setRunnerOpen(true) }} aria-label="展开 Runner" tabIndex={snapshot.running && !runnerOpen ? 0 : -1}><span className="live-dot"/><span className="runner-mini-label">{cancelling ? '正在停止…' : '正在运行 · 查看过程'}</span></button>
        </aside>
        <section className="result-pane" aria-label="结果页面">
          <div className="result-scroll">
            {selectedRound ? <RoundView key={selectedRound.id} round={selectedRound} />
              : snapshot.historyState === 'legacy-unavailable' ? <article className="document"><div className="document-header"><div className="eyebrow">EXISTING DSH SESSION</div><h1>Historical transcript unavailable</h1><p>该 DSH Session 的旧对话无法通过公开接口读取。旧历史只读继承、不重建 Temporal Round；第一次提交将沿用此 Session 并创建 Round 1。</p></div></article>
              : <div className="blank-state"><div className="blank-symbol">⌁</div><h2>暂无结果</h2><p>在右侧写下目标，选择模式并提交。</p></div>}
          </div>
          <section className={`runner-panel ${runnerOpen ? 'open' : ''} ${cancelling ? 'stopping' : ''}`} aria-label="Runner 事件" aria-hidden={!runnerOpen}>
            <div className="runner-header">
              <div><span className={snapshot.running ? 'live-dot' : 'idle-dot'}/><strong>{cancelling ? 'Stopping…' : snapshot.running ? 'Running' : 'Runner'}</strong><span>{modeLabels[mode]}</span></div>
              <div className="runner-actions">{snapshot.running && <button className="runner-stop" onClick={() => void cancelRun()} disabled={cancelling} aria-label="停止当前运行">{cancelling ? '停止中…' : '停止'}</button>}<button onClick={() => setRunnerOpen(false)} aria-label="收起 Runner">收起</button></div>
            </div>
            <div className="runner-events" ref={runnerEventsHost} onScroll={handleRunnerScroll} role="log" aria-live="polite">{runnerEvents.length ? runnerEvents.map(event => <div className={`runner-event event-${event.kind}`} key={event.id}><span className="runner-prefix">{event.kind}</span><span className="runner-message">{event.message}</span></div>) : <p className="runner-empty">等待运行事件…</p>}</div>
          </section>
        </section>
        <section className="spec-pane" aria-label="Spec 编辑器"><div className="spec-toolbar"><div className="segmented" aria-label="运行模式">{(['plan', 'vibe', 'loop'] as const).map(item => <button key={item} className={mode === item ? 'active' : ''} onClick={() => queueDraft(draft, item)} disabled={snapshot.running || busy} aria-pressed={mode === item}>{modeLabels[item]}</button>)}</div><div className="segmented" aria-label="编辑器视图"><button className={sourceView ? 'active' : ''} onClick={() => setSourceView(true)} aria-pressed={sourceView}>Source</button><button className={!sourceView ? 'active' : ''} onClick={() => setSourceView(false)} aria-pressed={!sourceView}>MD</button></div></div>
          <div className="spec-body"><div className={`editor-container ${sourceView ? '' : 'hidden'}`}><CodeMirrorEditor key={snapshot.session.id} value={draft} onFocus={() => { editorFocused.current = true }} onBlur={() => { editorFocused.current = false }} onChange={value => queueDraft(value, mode)}/>{!draft && <span className="editor-placeholder" aria-hidden="true"># Spec<br/><br/>描述希望完成的工作…</span>}</div><div className={`spec-preview markdown-body ${sourceView ? 'hidden' : ''}`}>{draft.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown> : <p className="muted">Spec 预览会显示在这里。</p>}</div></div>
          <div className="spec-footer"><div className="footer-actions"><button className="secondary-button" onClick={endRound} disabled={busy || snapshot.running || !snapshot.rounds.some(round => round.status === 'active')}>结束当前轮次</button><button className="primary-button" onClick={submit} disabled={busy || snapshot.running || !draft.trim()}>{snapshot.running ? '运行中…' : '提交'}</button></div></div>
        </section>
      </main>}

    {settingsOpen && settings && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-header"><div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">模型设置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">×</button></div>{error && <div className="dialog-error" role="alert">{error}</div>}<div className="settings-fields"><label>Provider<input value={settings.provider} onChange={event => setSettings({ ...settings, provider: event.target.value })} placeholder="deepseek-official"/></label><label>Model<input value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} placeholder="模型名称"/></label><label>Base URL <small>可选</small><input value={settings.baseUrl ?? ''} onChange={event => setSettings({ ...settings, baseUrl: event.target.value })} placeholder="https://…"/></label><label>会话权限 <small>对当前 Session 生效，运行中不可修改</small><select value={permission} onChange={event => void changePermission(event.target.value as PermissionPreset)} disabled={snapshot?.running || busy}>{(['read-only', 'workspace-write', 'danger-full-access'] as const).map(item => <option key={item} value={item}>{permissionLabels[item]}</option>)}</select></label><label>API 凭证 <small>{settings.hasCredential ? '已保存；留空则保持原凭证' : '尚未保存'}</small><input type="password" autoComplete="new-password" value={credential} onChange={event => setCredential(event.target.value)} placeholder={settings.hasCredential ? '输入新凭证以替换' : '输入 API 凭证'}/></label></div><div className="dialog-actions"><button className="secondary-button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary-button" onClick={saveSettings} disabled={busy || !settings.provider.trim() || !settings.model.trim()}>保存设置</button></div></section></div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
