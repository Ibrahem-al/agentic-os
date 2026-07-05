/**
 * Tasks & watchers panel (phase 10): background job queue (read-only view of
 * the durable task store) + watched-folder manager (spec §7 — definitions and
 * manual "scan now" only; automatic watching arrives with phase-11 triggers).
 */
import { useState } from 'react'
import { call, IpcError, useIpc } from '../lib/ipc'
import { truncate } from '../lib/format'
import {
  Badge,
  Button,
  DataTable,
  ErrorState,
  LoadingRows,
  PanelHeader,
  SectionHeader,
  TextInput,
  Timestamp,
  useToast
} from '../ui/kit'
import type { Column } from '../ui/kit'
import type { TaskDto, WatchScanResultDto, WatchedFolderDto } from '../../../shared/ipc'

function errMessage(err: unknown): string {
  return err instanceof IpcError ? err.message : String(err)
}

const TASK_COLUMNS: readonly Column<TaskDto>[] = [
  {
    key: 'id',
    header: 'id',
    className: 'font-mono',
    render: (row) => <span title={row.id}>{truncate(row.id, 20)}</span>
  },
  { key: 'kind', header: 'kind', render: (row) => row.kind },
  { key: 'status', header: 'status', render: (row) => <Badge status={row.status} /> },
  { key: 'attempts', header: 'attempts', className: 'font-mono text-right', render: (row) => row.attempts },
  { key: 'updated', header: 'updated', render: (row) => <Timestamp iso={row.updatedAt} /> },
  {
    key: 'error',
    header: 'last error',
    render: (row) =>
      row.lastError === null || row.lastError === '' ? (
        <span className="font-mono text-[11px] text-ink-faint">-</span>
      ) : (
        <span className="font-mono text-[11px] text-err" title={row.lastError}>
          {truncate(row.lastError, 80)}
        </span>
      )
  }
]

export default function TasksPanel(): React.JSX.Element {
  const tasks = useIpc('tasks.list', undefined)
  const watchers = useIpc('watch.list', undefined)
  const toast = useToast()

  const [scanningName, setScanningName] = useState<string | null>(null)
  const [removingName, setRemovingName] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<WatchScanResultDto | null>(null)

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [tags, setTags] = useState('')
  const [adding, setAdding] = useState(false)

  const scanNow = async (folderName: string): Promise<void> => {
    setScanningName(folderName)
    try {
      const result = await call('watch.scan', { name: folderName })
      setScanResult(result)
      toast.notify(
        'ok',
        `scanned ${result.scannedFiles} files: ${result.ingested.length} ingested, ${result.skipped.length} skipped, ${result.failed.length} failed`
      )
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setScanningName(null)
    }
  }

  const removeFolder = async (folderName: string): Promise<void> => {
    setRemovingName(folderName)
    try {
      await call('watch.remove', { name: folderName })
      toast.notify('ok', `removed ${folderName}`)
      watchers.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setRemovingName(null)
    }
  }

  const browse = async (): Promise<void> => {
    try {
      const picked = await call('ingest.pick', { kind: 'folder' })
      if (picked.path !== null) setPath(picked.path)
    } catch (err) {
      toast.notify('err', errMessage(err))
    }
  }

  const addFolder = async (): Promise<void> => {
    setAdding(true)
    try {
      const folderName = name.trim()
      await call('watch.add', {
        name: folderName,
        path: path.trim(),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== '')
      })
      toast.notify('ok', `added ${folderName}`)
      setName('')
      setPath('')
      setTags('')
      watchers.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const watcherColumns: readonly Column<WatchedFolderDto>[] = [
    { key: 'name', header: 'name', render: (row) => row.name },
    {
      key: 'path',
      header: 'path',
      className: 'font-mono max-w-64',
      render: (row) => (
        <span className="block truncate" title={row.path}>
          {row.path}
        </span>
      )
    },
    { key: 'tags', header: 'tags', render: (row) => (row.tags.length > 0 ? row.tags.join(', ') : '-') },
    {
      key: 'extensions',
      header: 'extensions',
      render: (row) =>
        row.extensions !== undefined && row.extensions.length > 0 ? row.extensions.join(', ') : 'all supported'
    },
    { key: 'enabled', header: 'enabled', className: 'font-mono', render: (row) => (row.enabled ? 'yes' : 'no') },
    {
      key: 'actions',
      header: 'actions',
      render: (row) => (
        <span className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            disabled={scanningName !== null}
            onClick={() => void scanNow(row.name)}
            testId={`watch-scan-${row.name}`}
          >
            {scanningName === row.name ? 'scanning…' : 'scan now'}
          </Button>
          <Button
            variant="danger"
            disabled={removingName !== null}
            onClick={() => void removeFolder(row.name)}
            testId={`watch-remove-${row.name}`}
          >
            remove
          </Button>
        </span>
      )
    }
  ]

  return (
    <>
      <PanelHeader title="tasks & watchers" />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        <section>
          <SectionHeader meta="retries: 3 attempts, backoff 1m / 5m / 25m">background jobs</SectionHeader>
          {tasks.error !== null ? (
            <ErrorState error={tasks.error} onRetry={tasks.reload} />
          ) : tasks.data === null ? (
            <LoadingRows rows={3} />
          ) : (
            <DataTable
              columns={TASK_COLUMNS}
              rows={tasks.data}
              rowKey={(row) => row.id}
              empty="no background jobs yet - extraction and scheduled jobs land here"
              testId="tasks-table"
            />
          )}
        </section>

        <section>
          <SectionHeader meta="manual scan now - automatic watching arrives with triggers">
            watched folders
          </SectionHeader>
          {watchers.error !== null ? (
            <ErrorState error={watchers.error} onRetry={watchers.reload} />
          ) : watchers.data === null ? (
            <LoadingRows rows={3} />
          ) : (
            <DataTable
              columns={watcherColumns}
              rows={watchers.data}
              rowKey={(row) => row.name}
              empty="no watched folders - add one below"
              testId="watchers-table"
            />
          )}

          {scanResult !== null && (
            <div
              className="mt-3 max-h-56 overflow-y-auto border border-line px-3 py-2 font-mono text-[11px]"
              data-testid="scan-result"
            >
              <div className="text-ink-mute">
                last scan: {scanResult.folder} ({scanResult.path}) - {scanResult.scannedFiles} files,{' '}
                {scanResult.ingested.length} ingested, {scanResult.skipped.length} skipped,{' '}
                {scanResult.failed.length} failed
              </div>
              {scanResult.ingested.map((entry) => (
                <div key={`ok-${entry.file}`} className="mt-1">
                  <span className="text-ok">{entry.status}</span> {entry.file}{' '}
                  <span className="text-ink-faint">({entry.chunkCount} chunks)</span>
                </div>
              ))}
              {scanResult.skipped.map((entry) => (
                <div key={`skip-${entry.file}`} className="mt-1 text-ink-mute">
                  skipped {entry.file} <span className="text-ink-faint">({entry.reason})</span>
                </div>
              ))}
              {scanResult.failed.map((entry) => (
                <div key={`fail-${entry.file}`} className="mt-1 text-err">
                  failed {entry.file}: {entry.error}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <TextInput label="name" value={name} onChange={setName} testId="watch-name-input" width="w-40" />
            <TextInput label="path" value={path} onChange={setPath} mono testId="watch-path-input" width="w-72" />
            <Button variant="ghost" onClick={() => void browse()}>
              browse
            </Button>
            <TextInput
              label="tags"
              value={tags}
              onChange={setTags}
              placeholder="tags, comma separated"
              width="w-56"
            />
            <Button
              variant="primary"
              disabled={adding || name.trim() === '' || path.trim() === ''}
              onClick={() => void addFolder()}
              testId="watch-add"
            >
              {adding ? 'adding…' : 'add folder'}
            </Button>
          </div>
        </section>
      </div>
    </>
  )
}
