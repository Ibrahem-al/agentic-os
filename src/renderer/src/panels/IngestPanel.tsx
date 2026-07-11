/**
 * Add knowledge panel (phase 10; UI redesign) — hand-feed the memory system:
 * a single document into the phase-06 knowledge pipeline or a whole codebase
 * into the phase-07 component-graph pipeline, with live progress pushed over
 * IPC. Same IPC calls and mutation flow as before; re-skinned into plain
 * English with technical breakdowns behind "Details" (brief §P8).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  IngestCodebaseResultDto,
  IngestDocumentResultDto,
  IngestProgressEventDto
} from '../../../shared/ipc'
import type { PanelProps } from '../App'
import { call, IpcError } from '../lib/ipc'
import { plainStatus, plural } from '../lib/plain'
import { Badge, Button, Disclosure, KV, PanelHeader, SectionHeader, TextInput, useToast } from '../ui/kit'
import { Icon } from '../ui/icons'

/** Last `max` chars of a path (progress shows where we are, not the prefix). */
function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? path
}

function toIpcError(err: unknown): IpcError {
  return err instanceof IpcError ? err : new IpcError('INTERNAL', String(err))
}

/** Progress phases → plain words for the "what's happening now" chip. */
const PHASE_LABEL: Record<IngestProgressEventDto['phase'], string> = {
  walking: 'Looking at files',
  parsing: 'Reading code',
  writing: 'Saving to memory',
  knowledge: 'Writing notes',
  skills: 'Finding skills'
}

/** Plain headline sentence for a finished document ingest. */
function documentHeadline(r: IngestDocumentResultDto): string {
  const name = baseName(r.source)
  if (r.status === 'unchanged') return `“${name}” was already up to date — nothing changed.`
  return `Saved “${name}” as ${plural(r.chunkCount, 'piece')}.`
}

/** Plain headline sentence for a finished codebase ingest. */
function codebaseHeadline(r: IngestCodebaseResultDto): string {
  if (r.status === 'unchanged') return `“${r.projectName}” is already up to date — nothing changed.`
  const learned = `Learned ${plural(r.components.total, 'component')} from “${r.projectName}”`
  const failed = r.knowledgeFailed.length
  return failed > 0 ? `${learned} — ${plural(failed, 'file')} couldn’t be read.` : `${learned}.`
}

/** Backend IpcError box — messages are written for operators, shown verbatim. */
function ErrorBox({ error }: { error: IpcError }): React.JSX.Element {
  return (
    <div className="rounded-md border border-err/40 bg-err/10 px-4 py-3" role="alert">
      <div className="font-mono text-[11px] text-err">{error.code}</div>
      <div className="mt-1 text-[13px]">{error.message}</div>
    </div>
  )
}

/** In-text link that routes to another panel (plain-language cross-references). */
function TextLink({ onClick, children }: { onClick: () => void; children: ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer text-accent underline-offset-2 transition-colors duration-120 hover:underline"
    >
      {children}
    </button>
  )
}

/** A mono numeral for the details grid. */
function num(value: number | string): React.JSX.Element {
  return <span className="font-mono text-[12px]">{value}</span>
}

export default function IngestPanel({ onNavigate }: PanelProps): React.JSX.Element {
  const toast = useToast()

  // ── document ingest state ──────────────────────────────────────────────────
  const [docPath, setDocPath] = useState('')
  const [docTags, setDocTags] = useState('')
  const [docRunning, setDocRunning] = useState(false)
  const [docResult, setDocResult] = useState<IngestDocumentResultDto | null>(null)
  const [docError, setDocError] = useState<IpcError | null>(null)

  // ── codebase ingest state ──────────────────────────────────────────────────
  const [codeRoot, setCodeRoot] = useState('')
  const [codeProject, setCodeProject] = useState('')
  const [codeRunning, setCodeRunning] = useState(false)
  const [codeProgress, setCodeProgress] = useState<IngestProgressEventDto | null>(null)
  const [codeResult, setCodeResult] = useState<IngestCodebaseResultDto | null>(null)
  const [codeError, setCodeError] = useState<IpcError | null>(null)

  /** Active progress subscription — severed on completion and on unmount. */
  const unsubRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      unsubRef.current?.()
      unsubRef.current = null
    },
    []
  )

  const pick = async (kind: 'file' | 'folder', apply: (path: string) => void): Promise<void> => {
    try {
      const { path } = await call('ingest.pick', { kind })
      if (path !== null) apply(path)
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    }
  }

  const runDocument = async (): Promise<void> => {
    setDocRunning(true)
    setDocResult(null)
    setDocError(null)
    const tags = docTags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '')
    try {
      const result = await call(
        'ingest.document',
        tags.length > 0 ? { path: docPath.trim(), tags } : { path: docPath.trim() }
      )
      setDocResult(result)
    } catch (err) {
      const ipcErr = toIpcError(err)
      setDocError(ipcErr)
      toast.notify('err', ipcErr.message)
    } finally {
      setDocRunning(false)
    }
  }

  const runCodebase = async (): Promise<void> => {
    setCodeRunning(true)
    setCodeResult(null)
    setCodeError(null)
    setCodeProgress(null)
    const runId = crypto.randomUUID()
    // Subscribe BEFORE invoking so no push is missed.
    const unsub = window.agenticOS.onIngestProgress((p) => {
      if (p.runId === runId) setCodeProgress(p)
    })
    unsubRef.current = unsub
    try {
      const project = codeProject.trim()
      const result = await call(
        'ingest.codebase',
        project !== '' ? { root: codeRoot.trim(), project, runId } : { root: codeRoot.trim(), runId }
      )
      setCodeResult(result)
    } catch (err) {
      const ipcErr = toIpcError(err)
      setCodeError(ipcErr)
      toast.notify('err', ipcErr.message)
    } finally {
      unsub()
      if (unsubRef.current === unsub) unsubRef.current = null
      setCodeRunning(false)
    }
  }

  const docStatus = docResult !== null ? plainStatus(docResult.status) : null
  const codeStatus = codeResult !== null ? plainStatus(codeResult.status) : null

  return (
    <>
      <PanelHeader
        title="Add knowledge"
        subtitle="Give your assistant documents and code to learn from"
        icon={<Icon name="ingest" size={18} />}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        <div className="grid max-w-5xl items-start gap-6 lg:grid-cols-2 lg:gap-8">
          {/* ── add a document ─────────────────────────────────────────────── */}
          <section className="flex min-w-0 flex-col gap-3">
            <div>
              <SectionHeader>
                <span className="inline-flex items-center gap-2">
                  <span className="text-ink-mute">
                    <Icon name="doc" size={16} />
                  </span>
                  Add a document
                </span>
              </SectionHeader>
              <p className="text-[13px] text-ink-mute">
                Point to a Markdown or text file. Its contents are split up, understood, and saved to memory.
                Adding the same file again changes nothing.
              </p>
            </div>

            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  label="File"
                  value={docPath}
                  onChange={setDocPath}
                  mono
                  testId="ingest-doc-path"
                  placeholder="Choose a file to add"
                />
              </div>
              <Button size="default" onClick={() => void pick('file', setDocPath)}>
                <Icon name="doc" size={14} />
                Choose file
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <TextInput label="Tags (optional)" value={docTags} onChange={setDocTags} placeholder="onboarding, api" />
              <p className="text-[12px] text-ink-mute">Comma-separated words to group and find this later.</p>
            </div>

            <div>
              <Button
                variant="primary"
                size="default"
                testId="ingest-doc-run"
                disabled={docRunning || docPath.trim() === ''}
                onClick={() => void runDocument()}
              >
                Add document
              </Button>
            </div>

            {docRunning && (
              <p className="text-[12px] text-ink-mute" role="status">
                Reading and saving <span className="font-mono">{baseName(docPath.trim())}</span>…
              </p>
            )}

            {docError !== null && <ErrorBox error={docError} />}

            {docResult !== null && docStatus !== null && (
              <div data-testid="ingest-doc-result" className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Badge status={docResult.status} label={docStatus.label} title={docStatus.explain} />
                  <span className="text-[13px]">{documentHeadline(docResult)}</span>
                </div>

                {docResult.tags.length > 0 && (
                  <p className="text-[12px] text-ink-mute">
                    Tagged {docResult.tags.map((t) => (t.created ? `${t.name} (new)` : t.name)).join(', ')}
                  </p>
                )}

                {docResult.injectionFlagged && (
                  <div className="rounded-md border border-warn/40 bg-warn/10 p-3">
                    <div className="flex items-start gap-2">
                      <span className="mt-px text-warn">
                        <Icon name="alert" size={14} />
                      </span>
                      <div className="flex flex-col gap-2">
                        <p className="text-[12px] text-ink">
                          Some of this content looked like an attempt to manipulate the assistant, so it was
                          saved as plain data only — it can’t act on the assistant. You can review it under
                          safety flags.
                        </p>
                        <div>
                          <Button onClick={() => onNavigate('review')}>Review safety flags</Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <Disclosure summary="Details">
                  <KV
                    entries={[
                      { k: 'File', v: <span className="font-mono text-[12px] break-all">{docResult.source}</span> },
                      { k: 'Saved as', v: num(plural(docResult.chunkCount, 'piece')) }
                    ]}
                  />
                  {docResult.warnings.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-0.5">
                      {docResult.warnings.map((warning, i) => (
                        <li key={i} className="font-mono text-[11px] text-ink-mute">
                          {warning}
                        </li>
                      ))}
                    </ul>
                  )}
                </Disclosure>
              </div>
            )}
          </section>

          {/* ── add a codebase ─────────────────────────────────────────────── */}
          <section className="flex min-w-0 flex-col gap-3 lg:border-l lg:border-line lg:pl-8">
            <div>
              <SectionHeader>
                <span className="inline-flex items-center gap-2">
                  <span className="text-ink-mute">
                    <Icon name="code" size={16} />
                  </span>
                  Add a codebase
                </span>
              </SectionHeader>
              <p className="text-[13px] text-ink-mute">
                Point to a project folder. The assistant maps out its components and how they connect, and
                writes short notes about the code. Nothing changes if the code hasn’t changed.
              </p>
            </div>

            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  label="Folder"
                  value={codeRoot}
                  onChange={setCodeRoot}
                  mono
                  testId="ingest-code-root"
                  placeholder="Choose a project folder"
                />
              </div>
              <Button size="default" onClick={() => void pick('folder', setCodeRoot)}>
                <Icon name="folder" size={14} />
                Choose folder
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <TextInput
                label="Project name (optional)"
                value={codeProject}
                onChange={setCodeProject}
                placeholder="Matched or created if left blank"
              />
              <p className="text-[12px] text-ink-mute">Groups everything from this folder under one project.</p>
            </div>

            <div>
              <Button
                variant="primary"
                size="default"
                testId="ingest-code-run"
                disabled={codeRunning || codeRoot.trim() === ''}
                onClick={() => void runCodebase()}
              >
                Add codebase
              </Button>
            </div>

            {codeRunning && codeProgress === null && (
              <p className="text-[12px] text-ink-mute" role="status">
                Starting…
              </p>
            )}

            {codeRunning && codeProgress !== null && (
              <div data-testid="ingest-code-progress" className="flex flex-col gap-1.5" role="status">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                  <span className="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent">
                    {PHASE_LABEL[codeProgress.phase]}
                  </span>
                  <span className="text-ink-mute">
                    <span className="font-mono text-ink">{codeProgress.filesWalked}</span> files looked at ·{' '}
                    <span className="font-mono text-ink">{codeProgress.codeFilesParsed}</span> read ·{' '}
                    <span className="font-mono text-ink">{codeProgress.componentsFound}</span> found
                  </span>
                </div>
                {codeProgress.currentFile !== undefined && (
                  <div className="truncate font-mono text-[11px] text-ink-mute">
                    {tail(codeProgress.currentFile, 60)}
                  </div>
                )}
              </div>
            )}

            {codeError !== null && <ErrorBox error={codeError} />}

            {codeResult !== null && codeStatus !== null && (
              <div data-testid="ingest-code-result" className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Badge status={codeResult.status} label={codeStatus.label} title={codeStatus.explain} />
                  <span className="text-[13px]">{codebaseHeadline(codeResult)}</span>
                  {codeResult.projectCreated && <span className="text-[12px] text-ink-mute">new project</span>}
                </div>

                {/* Stage-3 skill extraction: nothing goes live here — staged skills
                    and revisions wait for a human in Approvals. */}
                {codeResult.skills.staged + codeResult.skills.revisions > 0 && (
                  <p className="text-[12px]" data-testid="ingest-code-skills">
                    <span className="text-ink">
                      {plural(codeResult.skills.staged + codeResult.skills.revisions, 'skill')} found
                    </span>
                    <span className="text-ink-mute"> — waiting in </span>
                    <TextLink onClick={() => onNavigate('review')}>Approvals</TextLink>
                    <span className="text-ink-mute">.</span>
                  </p>
                )}
                {codeResult.skills.skippedExisting > 0 && (
                  <p className="text-[12px] text-ink-mute">
                    {plural(codeResult.skills.skippedExisting, 'skill')} already imported before, so{' '}
                    {codeResult.skills.skippedExisting === 1 ? 'it was' : 'they were'} skipped.
                  </p>
                )}

                <Disclosure summary="Details">
                  <KV
                    entries={[
                      { k: 'Files looked at', v: num(codeResult.filesWalked) },
                      { k: 'Files read', v: num(codeResult.codeFilesParsed) },
                      {
                        k: 'Components',
                        v: num(
                          `${codeResult.components.total} (+${codeResult.components.created} / -${codeResult.components.deleted})`
                        )
                      },
                      { k: 'Connections', v: num(codeResult.dependsOn.total) },
                      { k: 'Notes written', v: num(codeResult.knowledgeDocuments) },
                      { k: 'Notes removed', v: num(codeResult.knowledgePruned) },
                      { k: 'Skipped', v: num(codeResult.skipped) },
                      ...(codeResult.skills.discovered > 0 || codeResult.skills.skippedExisting > 0
                        ? [
                            { k: 'Skills found', v: num(codeResult.skills.discovered) },
                            {
                              k: 'Skills waiting for review',
                              v: num(codeResult.skills.staged + codeResult.skills.revisions)
                            },
                            { k: 'Already imported before', v: num(codeResult.skills.skippedExisting) }
                          ]
                        : [])
                    ]}
                  />
                  {codeResult.knowledgeFailed.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-0.5">
                      {codeResult.knowledgeFailed.map((failure) => (
                        <li key={failure.file} className="font-mono text-[11px] text-err">
                          {failure.file}: {failure.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </Disclosure>
              </div>
            )}
          </section>
        </div>

        <p className="max-w-5xl text-[12px] text-ink-mute">
          Want a folder kept in sync automatically? Add it as a watched folder under{' '}
          <TextLink onClick={() => onNavigate('tasks')}>Background work</TextLink>.
        </p>
      </div>
    </>
  )
}
