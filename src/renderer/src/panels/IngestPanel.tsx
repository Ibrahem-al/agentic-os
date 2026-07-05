/**
 * Ingestion panel (phase 10): feed the memory system by hand — a single
 * document into the phase-06 knowledge pipeline or a whole codebase into the
 * phase-07 component-graph pipeline, with live progress pushed over IPC.
 */
import { useEffect, useRef, useState } from 'react'
import type {
  IngestCodebaseResultDto,
  IngestDocumentResultDto,
  IngestProgressEventDto
} from '../../../shared/ipc'
import { call, IpcError } from '../lib/ipc'
import { Badge, Button, KV, PanelHeader, SectionHeader, TextInput, useToast } from '../ui/kit'

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

export default function IngestPanel(): React.JSX.Element {
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

  return (
    <>
      <PanelHeader title="ingestion" meta="knowledge documents and codebases become graph memory" />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        {/* ── document ─────────────────────────────────────────────────────── */}
        <section className="max-w-3xl">
          <SectionHeader meta="markdown and plain text, chunked and embedded; re-adding unchanged content is a no-op">
            ingest a document
          </SectionHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  label="path"
                  value={docPath}
                  onChange={setDocPath}
                  mono
                  testId="ingest-doc-path"
                  placeholder="absolute path to a document"
                />
              </div>
              <Button size="default" onClick={() => void pick('file', setDocPath)}>
                browse
              </Button>
            </div>
            <TextInput label="tags" value={docTags} onChange={setDocTags} placeholder="tags, comma separated" />
            <div>
              <Button
                variant="primary"
                size="default"
                testId="ingest-doc-run"
                disabled={docRunning || docPath.trim() === ''}
                onClick={() => void runDocument()}
              >
                ingest document
              </Button>
            </div>
            {docRunning && (
              <div className="font-mono text-[12px] text-ink-mute" role="status">
                embedding and writing... {baseName(docPath.trim())}
              </div>
            )}
            {docError !== null && (
              <div className="rounded-md border border-err/40 bg-err/10 px-4 py-3" role="alert">
                <div className="font-mono text-[11px] text-err">{docError.code}</div>
                <div className="mt-1 text-[13px]">{docError.message}</div>
              </div>
            )}
            {docResult !== null && (
              <div data-testid="ingest-doc-result" className="flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  <Badge status={docResult.status} />
                  <span className="font-mono text-[12px]">{docResult.chunkCount} chunks</span>
                  {docResult.tags.length > 0 && (
                    <span className="font-mono text-[11px] text-ink-mute">
                      {docResult.tags.map((t) => (t.created ? `${t.name} (new)` : t.name)).join(' · ')}
                    </span>
                  )}
                </div>
                {docResult.injectionFlagged && (
                  <div className="rounded-md border border-warn/40 bg-warn/10 p-3">
                    <div className="text-[12px] text-warn">
                      flagged by the injection scanner - stored as inert data, findings in review queue &gt; flagged
                      documents
                    </div>
                    {docResult.warnings.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-0.5">
                        {docResult.warnings.map((warning, i) => (
                          <li key={i} className="font-mono text-[11px] text-ink-mute">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {!docResult.injectionFlagged && docResult.warnings.length > 0 && (
                  <ul className="flex flex-col gap-0.5">
                    {docResult.warnings.map((warning, i) => (
                      <li key={i} className="font-mono text-[11px] text-ink-mute">
                        {warning}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── codebase ─────────────────────────────────────────────────────── */}
        <section className="max-w-3xl border-t border-line pt-5">
          <SectionHeader meta="tree-sitter component graph + doc digests; unchanged re-ingest writes nothing">
            ingest a codebase
          </SectionHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  label="root"
                  value={codeRoot}
                  onChange={setCodeRoot}
                  mono
                  testId="ingest-code-root"
                  placeholder="absolute path to a repository root"
                />
              </div>
              <Button size="default" onClick={() => void pick('folder', setCodeRoot)}>
                browse
              </Button>
            </div>
            <TextInput
              label="project"
              value={codeProject}
              onChange={setCodeProject}
              placeholder="project name (optional, matched or created)"
            />
            <div>
              <Button
                variant="primary"
                size="default"
                testId="ingest-code-run"
                disabled={codeRunning || codeRoot.trim() === ''}
                onClick={() => void runCodebase()}
              >
                ingest codebase
              </Button>
            </div>
            {codeRunning && codeProgress === null && (
              <div className="font-mono text-[12px] text-ink-mute" role="status">
                starting...
              </div>
            )}
            {codeRunning && codeProgress !== null && (
              <div data-testid="ingest-code-progress" className="flex flex-col gap-1.5" role="status">
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[11px] text-accent">
                    {codeProgress.phase}
                  </span>
                  <span className="font-mono text-[12px]">{codeProgress.filesWalked} walked</span>
                  <span className="font-mono text-[12px]">{codeProgress.codeFilesParsed} parsed</span>
                  <span className="font-mono text-[12px]">{codeProgress.componentsFound} components</span>
                </div>
                {codeProgress.currentFile !== undefined && (
                  <div className="truncate font-mono text-[11px] text-ink-faint">
                    {tail(codeProgress.currentFile, 60)}
                  </div>
                )}
              </div>
            )}
            {codeError !== null && (
              <div className="rounded-md border border-err/40 bg-err/10 px-4 py-3" role="alert">
                <div className="font-mono text-[11px] text-err">{codeError.code}</div>
                <div className="mt-1 text-[13px]">{codeError.message}</div>
              </div>
            )}
            {codeResult !== null && (
              <div data-testid="ingest-code-result" className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2.5">
                  <Badge status={codeResult.status} />
                  <span className="text-[13px]">
                    {codeResult.projectName}
                    {codeResult.projectCreated ? ' (created)' : ''}
                  </span>
                </div>
                <KV
                  entries={[
                    {
                      k: 'files walked',
                      v: <span className="font-mono text-[12px]">{codeResult.filesWalked}</span>
                    },
                    {
                      k: 'parsed',
                      v: <span className="font-mono text-[12px]">{codeResult.codeFilesParsed}</span>
                    },
                    {
                      k: 'components',
                      v: (
                        <span className="font-mono text-[12px]">
                          {codeResult.components.total} (+{codeResult.components.created}/-
                          {codeResult.components.deleted})
                        </span>
                      )
                    },
                    {
                      k: 'depends_on',
                      v: <span className="font-mono text-[12px]">{codeResult.dependsOn.total}</span>
                    },
                    {
                      k: 'knowledge docs',
                      v: <span className="font-mono text-[12px]">{codeResult.knowledgeDocuments}</span>
                    },
                    {
                      k: 'pruned',
                      v: <span className="font-mono text-[12px]">{codeResult.knowledgePruned}</span>
                    },
                    {
                      k: 'skipped',
                      v: <span className="font-mono text-[12px]">{codeResult.skipped}</span>
                    }
                  ]}
                />
                {codeResult.knowledgeFailed.length > 0 && (
                  <ul className="flex flex-col gap-0.5">
                    {codeResult.knowledgeFailed.map((failure) => (
                      <li key={failure.file} className="font-mono text-[11px] text-err">
                        {failure.file}: {failure.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>

        <div className="text-[11px] text-ink-faint">recurring folders live in tasks &amp; watchers as watched folders</div>
      </div>
    </>
  )
}
