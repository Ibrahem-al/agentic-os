/**
 * Skills panel (phase 10, spec §3): skill-performance analytics. Master list
 * (uses, examples, corrections, active benchmark) with a detail inspector
 * (instructions, version history, examples, corrections) on the right.
 * Phase 12 adds the improvement section: per-skill adoption mode (§17),
 * drift auto-revert toggle (§20), the manual "improve now" trigger, rollback,
 * and the improvement ledger with drift flags.
 */
import { useState } from 'react'
import { call, useIpc, IpcError } from '../lib/ipc'
import { conf, truncate } from '../lib/format'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  PanelHeader,
  SectionHeader,
  Select,
  Timestamp,
  useToast
} from '../ui/kit'
import type { Column } from '../ui/kit'
import type { SkillImprovementEntryDto, SkillSummaryDto, SkillVersionDto } from '../../../shared/ipc'

const SKILL_COLUMNS: readonly Column<SkillSummaryDto>[] = [
  { key: 'name', header: 'name', render: (row) => row.name },
  {
    key: 'current',
    header: 'current version',
    className: 'font-mono',
    render: (row) => row.currentVersion ?? '-'
  },
  { key: 'versions', header: 'versions', className: 'font-mono text-right', render: (row) => row.versionCount },
  { key: 'uses', header: 'uses', className: 'font-mono text-right', render: (row) => row.sessionUseCount },
  {
    key: 'examples',
    header: 'examples',
    className: 'font-mono',
    render: (row) => (
      <>
        {row.exampleCount}
        {row.failureExampleCount > 0 && <span className="text-err"> ({row.failureExampleCount} fail)</span>}
      </>
    )
  },
  {
    key: 'corrections',
    header: 'corrections',
    className: 'font-mono text-right',
    render: (row) => row.correctionCount
  },
  {
    key: 'score',
    header: 'active score',
    className: 'font-mono text-right',
    render: (row) => (row.activeBenchmarkScore == null ? '-' : conf(row.activeBenchmarkScore))
  }
]

const VERSION_COLUMNS: readonly Column<SkillVersionDto>[] = [
  {
    key: 'id',
    header: 'version',
    className: 'font-mono',
    render: (row) => <span title={row.id}>{truncate(row.id, 12)}</span>
  },
  { key: 'status', header: 'status', render: (row) => <Badge status={row.status} /> },
  {
    key: 'benchmark',
    header: 'benchmark',
    className: 'font-mono text-right',
    render: (row) => (row.benchmarkScore == null ? '-' : conf(row.benchmarkScore))
  },
  { key: 'created', header: 'created', render: (row) => <Timestamp iso={row.createdAt} /> }
]

/** One improvement-ledger line: outcome, drift state, timestamps. */
function ImprovementEntry({ entry }: { entry: SkillImprovementEntryDto }): React.JSX.Element {
  const rolledBack = entry.rolledBackAt !== null
  const drifted = entry.driftFlaggedAt !== null
  return (
    <li className="flex flex-col gap-0.5 border-b border-line pb-1.5 text-[12px] last:border-b-0">
      <div className="flex items-center gap-2">
        <Badge status={entry.outcome} />
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-mute" title={entry.candidateVersionId}>
          {truncate(entry.candidateVersionId, 28)}
        </span>
        <span className="ml-auto shrink-0">
          <Timestamp iso={entry.createdAt} />
        </span>
      </div>
      {entry.reason !== null && entry.reason !== '' && (
        <div className="text-ink-mute" title={entry.reason}>
          {truncate(entry.reason, 160)}
        </div>
      )}
      {(rolledBack || drifted) && (
        <div className="flex items-center gap-2">
          {drifted && <Badge status="drift-flagged" label="drift flagged" />}
          {rolledBack && <Badge status="rolled-back" label="rolled back" />}
          {drifted && entry.driftResolvedAt === null && !rolledBack && (
            <span className="text-[11px] text-ink-mute">worse corrections rate than predecessor (spec 20 watch)</span>
          )}
        </div>
      )}
    </li>
  )
}

/** §17 per-skill adoption setting + manual trigger + rollback + ledger. */
function ImprovementSection({ skillId }: { skillId: string }): React.JSX.Element {
  const improvement = useIpc('skills.improvement', { skillId })
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  if (improvement.error !== null) return <ErrorState error={improvement.error} onRetry={improvement.reload} />
  if (improvement.data === null) return <LoadingRows rows={2} />
  const data = improvement.data

  const mutate = (work: () => Promise<unknown>, okMessage: string): void => {
    setBusy(true)
    work()
      .then(() => {
        toast.notify('ok', okMessage)
        improvement.reload()
      })
      .catch((err: unknown) => {
        toast.notify('err', err instanceof IpcError ? `${err.code}: ${err.message}` : String(err))
      })
      .finally(() => setBusy(false))
  }

  return (
    <section data-testid="skill-improvement">
      <SectionHeader>improvement</SectionHeader>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={data.settings.mode}
            ariaLabel="adoption mode"
            testId="skill-mode-select"
            options={[
              { value: 'stylistic', label: 'stylistic - human approves' },
              { value: 'verifiable', label: 'verifiable - auto-adopt on win' }
            ]}
            onChange={(value) =>
              mutate(
                () =>
                  call('skills.improvementSettings', {
                    skillId,
                    mode: value === 'verifiable' ? 'verifiable' : 'stylistic',
                    autoRevert: data.settings.autoRevert
                  }),
                `adoption mode: ${value}`
              )
            }
          />
          <Select
            value={data.settings.autoRevert ? 'on' : 'off'}
            ariaLabel="drift auto-revert"
            testId="skill-autorevert-select"
            options={[
              { value: 'off', label: 'drift: flag only' },
              { value: 'on', label: 'drift: auto-revert' }
            ]}
            onChange={(value) =>
              mutate(
                () =>
                  call('skills.improvementSettings', {
                    skillId,
                    mode: data.settings.mode,
                    autoRevert: value === 'on'
                  }),
                `drift auto-revert ${value}`
              )
            }
          />
          <Button
            variant="primary"
            disabled={busy}
            testId="skill-improve-now"
            onClick={() =>
              mutate(
                () => call('skills.improveNow', { skillId }),
                'improvement task enqueued - watch tasks & watchers'
              )
            }
          >
            improve now
          </Button>
          <Button
            variant="danger"
            disabled={busy || !data.canRollback}
            testId="skill-rollback"
            title={data.canRollback ? 'restore the previous version' : 'no standing adoption to roll back'}
            onClick={() => mutate(() => call('skills.rollback', { skillId }), 'previous version restored')}
          >
            rollback
          </Button>
        </div>
        <div className="font-mono text-[11px] text-ink-faint">
          last improvement run: {data.settings.lastRunAt ?? 'never'} · nightly slot 02:00 (event-gated)
        </div>
        {data.history.length === 0 ? (
          <div className="text-[12px] text-ink-mute">no improvement attempts yet</div>
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="skill-improvement-history">
            {data.history.map((entry) => (
              <ImprovementEntry key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function SkillDetail({ id }: { id: string }): React.JSX.Element {
  const detail = useIpc('skills.detail', { id })

  if (detail.error !== null) return <ErrorState error={detail.error} onRetry={detail.reload} />
  if (detail.data === null) return <LoadingRows />
  const skill = detail.data

  return (
    <div className="flex flex-col gap-4 px-4 py-3" data-testid="skill-detail">
      <div>
        <div className="text-[16px] font-semibold">{skill.name}</div>
        <div className="font-mono text-[11px] text-ink-faint">{skill.id}</div>
        <div className="mt-1 font-mono text-[12px] text-ink-mute">current: {skill.currentVersion ?? '-'}</div>
      </div>

      <ImprovementSection skillId={id} />

      <section>
        <SectionHeader>instructions</SectionHeader>
        <div className="max-h-64 overflow-y-auto rounded-md bg-raised p-3 text-[12px] whitespace-pre-wrap">
          {skill.instructions}
        </div>
      </section>

      <section>
        <SectionHeader>versions</SectionHeader>
        <DataTable
          columns={VERSION_COLUMNS}
          rows={skill.versions}
          rowKey={(row) => row.id}
          empty="no versions recorded"
        />
      </section>

      <section>
        <SectionHeader>examples</SectionHeader>
        {skill.examples.length === 0 ? (
          <div className="text-[12px] text-ink-mute">no examples recorded</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {skill.examples.map((example) => (
              <li key={example.id} className="flex items-start gap-2 text-[12px]">
                <Badge status={example.kind} label={example.kind} />
                <span className="min-w-0" title={example.content}>
                  {truncate(example.content, 140)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader>corrections</SectionHeader>
        {skill.corrections.length === 0 ? (
          <div className="text-[12px] text-ink-mute">no corrections recorded</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {skill.corrections.map((correction) => (
              <li key={correction.id} className="flex items-start gap-2">
                <span className="shrink-0 font-mono text-[11px] leading-5 text-ink-mute">corr</span>
                <span className="min-w-0 text-[12px]">{correction.content}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default function SkillsPanel(): React.JSX.Element {
  const skills = useIpc('skills.list', undefined)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  return (
    <>
      <PanelHeader title="skills" />
      <div className="grid min-h-0 flex-1 grid-cols-[3fr_2fr]">
        <div className="min-h-0 overflow-y-auto border-r border-line">
          {skills.error !== null ? (
            <ErrorState error={skills.error} onRetry={skills.reload} />
          ) : skills.data === null ? (
            <LoadingRows />
          ) : (
            <DataTable
              columns={SKILL_COLUMNS}
              rows={skills.data}
              rowKey={(row) => row.id}
              onRowClick={(row) => setSelectedId(row.id)}
              selectedKey={selectedId}
              empty="no skills saved yet - skills arrive via get_skill usage and the improvement agent"
              testId="skills-table"
            />
          )}
        </div>
        <div className="min-h-0 overflow-y-auto">
          {selectedId !== null ? <SkillDetail key={selectedId} id={selectedId} /> : <EmptyState>select a skill</EmptyState>}
        </div>
      </div>
    </>
  )
}
