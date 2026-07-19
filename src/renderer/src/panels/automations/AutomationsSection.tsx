/**
 * Automations section (phase 31) — the dashboard authoring surface for
 * user-defined scheduled tasks & watchers (spec agent #5). Lists every
 * automation with an on/off switch, run-now, edit and delete; a "New
 * automation" button opens the editor; broken rule files surface as verbatim
 * error rows with a delete-to-clean action. Every mutation is applied LIVE by
 * the backend (no restart) and is undoable from the toast or History.
 *
 * DASHBOARD-ONLY by design (never MCP, §21 rule 6): a rule is user-authored
 * executable intent + a capability self-declaration.
 */
import { useState } from 'react'
import { call, IpcError, useIpc } from '../../lib/ipc'
import {
  Button,
  DataTable,
  ErrorState,
  LoadingRows,
  Modal,
  SectionHeader,
  Timestamp,
  Toggle,
  useToast,
  type Column
} from '../../ui/kit'
import { describeTrigger } from '../../lib/cron'
import { IPC_RULE_PRESETS } from '../../../../shared/ipc'
import type { RuleDetailDto, RuleFileErrorDto } from '../../../../shared/ipc'
import { AutomationEditor } from './AutomationEditor'

const msg = (err: unknown): string => (err instanceof IpcError ? err.message : String(err))

const describeAction = (action: RuleDetailDto['action']): string => {
  if (action.kind === 'preset') {
    return IPC_RULE_PRESETS.find((p) => p.id === action.preset)?.label ?? action.preset
  }
  const base = action.entry.split(/[\\/]/).pop() ?? action.entry
  return `Run ${base} · ${action.lane === 'deno' ? 'Deno' : 'Docker'} sandbox`
}

/** null = editor closed; 'new' = create; a rule = edit that rule. */
type EditorTarget = RuleDetailDto | 'new' | null

export function AutomationsSection({ onMutated }: { onMutated?: () => void }): React.JSX.Element {
  const rules = useIpc('rules.list', undefined)
  const watched = useIpc('watch.list', undefined)
  const toast = useToast()

  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null)
  const [deleteTarget, setDeleteTarget] = useState<RuleDetailDto | null>(null)
  const [invalidTarget, setInvalidTarget] = useState<RuleFileErrorDto | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)

  const refresh = (): void => {
    rules.reload()
    onMutated?.()
  }

  const undo = async (actionId: string): Promise<void> => {
    try {
      await call('audit.undo', { id: actionId })
      toast.notify('ok', 'Restored.')
      refresh()
    } catch (err) {
      toast.notify('err', msg(err))
    }
  }

  const toggle = async (rule: RuleDetailDto, next: boolean): Promise<void> => {
    setBusyId(rule.id)
    try {
      await call('rules.setEnabled', { id: rule.id, enabled: next })
      refresh()
    } catch (err) {
      toast.notify('err', msg(err))
    } finally {
      setBusyId(null)
    }
  }

  const runNow = async (rule: RuleDetailDto): Promise<void> => {
    setBusyId(rule.id)
    try {
      await call('rules.runNow', { id: rule.id })
      toast.notify(
        'ok',
        `Queued '${rule.id}' — see the Jobs table.${rule.action.kind === 'code' ? ' Its first write or network call may wait in Approvals.' : ''}`
      )
      onMutated?.()
    } catch (err) {
      toast.notify('err', msg(err))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget
    if (target === null) return
    setBusyId(target.id)
    try {
      const res = await call('rules.delete', { id: target.id })
      setDeleteTarget(null)
      toast.notify('ok', `Deleted '${target.id}'.`, { label: 'Undo', onClick: () => void undo(res.auditActionId) })
      refresh()
    } catch (err) {
      toast.notify('err', msg(err))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDeleteInvalid = async (): Promise<void> => {
    const target = invalidTarget
    if (target === null) return
    try {
      const res = await call('rules.deleteInvalid', { file: target.file })
      setInvalidTarget(null)
      toast.notify('ok', 'Removed the broken automation file.', { label: 'Undo', onClick: () => void undo(res.auditActionId) })
      refresh()
    } catch (err) {
      toast.notify('err', msg(err))
    }
  }

  const reloadRules = async (): Promise<void> => {
    setReloading(true)
    try {
      const res = await call('rules.reload', undefined)
      const n = res.added.length + res.removed.length + res.changed.length
      toast.notify('ok', n === 0 ? 'No changes on disk.' : `Reloaded — ${res.added.length} added, ${res.changed.length} changed, ${res.removed.length} removed.`)
      refresh()
    } catch (err) {
      toast.notify('err', msg(err))
    } finally {
      setReloading(false)
    }
  }

  const columns: readonly Column<RuleDetailDto>[] = [
    {
      key: 'id',
      header: 'Automation',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-mono text-[12px] text-ink">{r.id}</span>
          {r.enabled && !r.armed && <span className="text-[11px] text-warn">saved but not running — check for errors</span>}
        </div>
      )
    },
    { key: 'trigger', header: 'When', className: 'text-ink-mute', render: (r) => describeTrigger(r.trigger) },
    { key: 'action', header: 'Does', className: 'text-ink-mute', render: (r) => describeAction(r.action) },
    {
      key: 'next',
      header: 'Next run',
      render: (r) => (r.nextRunAt !== null ? <Timestamp iso={r.nextRunAt} /> : <span className="text-ink-mute">—</span>)
    },
    {
      key: 'on',
      header: 'On',
      render: (r) => (
        <Toggle
          checked={r.enabled}
          disabled={busyId === r.id}
          onChange={(next) => void toggle(r, next)}
          label={`Enable ${r.id}`}
          testId={`rule-toggle-${r.id}`}
        />
      )
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (r) => (
        <span className="flex items-center justify-end gap-1.5">
          <Button disabled={busyId === r.id || !r.enabled} onClick={() => void runNow(r)} testId={`rule-run-${r.id}`}>
            Run now
          </Button>
          <Button onClick={() => setEditorTarget(r)} testId={`rule-edit-${r.id}`}>
            Edit
          </Button>
          <Button variant="danger-ghost" onClick={() => setDeleteTarget(r)} testId={`rule-delete-${r.id}`}>
            Delete
          </Button>
        </span>
      )
    }
  ]

  const editorInitial = editorTarget === 'new' ? null : editorTarget
  const watchedFolders = watched.data ?? []

  return (
    <section>
      <SectionHeader
        meta={
          <span className="flex items-center gap-2">
            <span>Run a job on a schedule or when something changes</span>
            <Button disabled={reloading} onClick={() => void reloadRules()} testId="rules-reload">
              {reloading ? 'Reloading…' : 'Reload'}
            </Button>
            <Button variant="primary" onClick={() => setEditorTarget('new')} testId="rule-new">
              New automation
            </Button>
          </span>
        }
      >
        Automations
      </SectionHeader>

      {rules.error !== null ? (
        <ErrorState error={rules.error} onRetry={rules.reload} />
      ) : rules.data === null ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="flex flex-col gap-3">
          <DataTable
            columns={columns}
            rows={rules.data.rules}
            rowKey={(r) => r.id}
            testId="automations-table"
            empty="No automations yet. Create one to run a job on a schedule or when a file or web page changes."
          />

          {rules.data.errors.map((e) => (
            <div key={e.file} className="flex items-start justify-between gap-3 rounded-md border border-err/40 bg-err/10 px-3 py-2">
              <div className="min-w-0">
                <div className="text-[12px] text-err">A rule file couldn&apos;t be loaded: {e.error}</div>
                <div className="truncate font-mono text-[11px] text-ink-mute" title={e.file}>
                  {e.file}
                </div>
              </div>
              <Button variant="danger-ghost" onClick={() => setInvalidTarget(e)}>
                Delete file
              </Button>
            </div>
          ))}

          {!rules.data.dockerAvailable && (
            <div className="text-[11px] text-ink-mute">Docker isn&apos;t running — automations that run non-JS/TS code will wait until it is.</div>
          )}
        </div>
      )}

      {editorTarget !== null && (
        <Modal
          title={editorInitial !== null ? `Edit automation` : 'New automation'}
          wide
          onClose={() => setEditorTarget(null)}
        >
          <AutomationEditor
            initial={editorInitial}
            watchedFolders={watchedFolders}
            dockerAvailable={rules.data?.dockerAvailable ?? false}
            onClose={() => setEditorTarget(null)}
            onSaved={() => {
              setEditorTarget(null)
              refresh()
            }}
          />
        </Modal>
      )}

      {deleteTarget !== null && (
        <Modal
          title="Delete this automation?"
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <Button onClick={() => setDeleteTarget(null)}>Keep it</Button>
              <Button variant="danger" disabled={busyId === deleteTarget.id} onClick={() => void confirmDelete()} testId="rule-delete-confirm">
                Delete automation
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-ink">
            This removes the automation <span className="font-mono">{deleteTarget.id}</span>.
          </p>
          {deleteTarget.action.kind === 'code' && (
            <p className="mt-2 text-[12px] text-ink-mute">
              Your code file <span className="font-mono">{deleteTarget.action.entry}</span> is not touched.
            </p>
          )}
          <p className="mt-2 text-[12px] text-ink-mute">You can undo this from the toast or the History panel.</p>
        </Modal>
      )}

      {invalidTarget !== null && (
        <Modal
          title="Delete this broken file?"
          onClose={() => setInvalidTarget(null)}
          footer={
            <>
              <Button onClick={() => setInvalidTarget(null)}>Keep it</Button>
              <Button variant="danger" onClick={() => void confirmDeleteInvalid()} testId="rule-delete-invalid-confirm">
                Delete file
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-ink">This deletes a rule file that couldn&apos;t be loaded.</p>
          <p className="mt-2 truncate font-mono text-[11px] text-ink-mute" title={invalidTarget.file}>
            {invalidTarget.file}
          </p>
          <p className="mt-2 text-[12px] text-ink-mute">You can undo this from the toast or the History panel.</p>
        </Modal>
      )}
    </section>
  )
}
