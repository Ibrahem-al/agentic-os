/**
 * Skills panel (phase 10, spec §3): skill-performance analytics, re-skinned for
 * the plain-language redesign (brief §P7). Master list reads as plain rows —
 * name, a quality-score meter, times used, what it learned from — with a detail
 * inspector (what the skill tells the assistant, version history, examples,
 * corrections) on the right. Phase 12's improvement section stays: per-skill
 * adoption mode (§17), drift auto-revert toggle (§20), the manual "improve now"
 * trigger, rollback, and the improvement ledger with drift flags.
 *
 * Test-asserted contracts kept verbatim: the skills-table rowKey is row.id, the
 * `skill-detail`/`skill-improvement`/`skill-mode-select`/`skill-improve-now`/
 * `skill-improvement-history` testids, the native `<select>` mode dropdown, the
 * "adoption mode: <mode>" + "improvement task enqueued …" toasts, and the full
 * instructions render (golden-path reads the adopted marker out of it).
 */
import { useState } from 'react'
import { call, useIpc, IpcError } from '../lib/ipc'
import { truncate } from '../lib/format'
import { plainStatus, plural } from '../lib/plain'
import {
  Badge,
  Button,
  Confidence,
  DataTable,
  Disclosure,
  EmptyState,
  ErrorState,
  KV,
  LoadingRows,
  PanelHeader,
  SectionHeader,
  Select,
  Timestamp,
  useToast
} from '../ui/kit'
import type { Column } from '../ui/kit'
import { Icon } from '../ui/icons'
import type { SkillImprovementEntryDto, SkillSummaryDto, SkillVersionDto } from '../../../shared/ipc'

/** Raw backend status word → the shared Badge with its plain label + tooltip. */
function PlainBadge({ status }: { status: string }): React.JSX.Element {
  const plain = plainStatus(status)
  return <Badge status={status} label={plain.label} title={plain.explain} />
}

const SKILL_COLUMNS: readonly Column<SkillSummaryDto>[] = [
  {
    key: 'name',
    header: 'skill',
    render: (row) => (
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-ink">{row.name}</span>
        <span className="font-mono text-[11px] text-ink-mute">
          {row.currentVersion ?? 'no version yet'} · {plural(row.versionCount, 'version')}
        </span>
      </div>
    )
  },
  {
    key: 'quality',
    header: 'quality score',
    render: (row) =>
      row.activeBenchmarkScore == null ? (
        <span className="text-[12px] text-ink-mute">not scored yet</span>
      ) : (
        <Confidence value={row.activeBenchmarkScore} />
      )
  },
  { key: 'uses', header: 'times used', className: 'font-mono text-right', render: (row) => row.sessionUseCount },
  {
    key: 'learned',
    header: 'learned from',
    render: (row) => (
      <span className="text-[12px] text-ink-mute">
        {plural(row.correctionCount, 'correction')} · {plural(row.exampleCount, 'example')}
        {row.failureExampleCount > 0 && (
          <span className="text-warn"> · {row.failureExampleCount} didn’t work</span>
        )}
      </span>
    )
  }
]

const VERSION_COLUMNS: readonly Column<SkillVersionDto>[] = [
  {
    key: 'id',
    header: 'version',
    className: 'font-mono',
    render: (row) => <span title={row.id}>{truncate(row.id, 12)}</span>
  },
  { key: 'status', header: 'status', render: (row) => <PlainBadge status={row.status} /> },
  {
    key: 'quality',
    header: 'quality',
    render: (row) =>
      row.benchmarkScore == null ? <span className="text-ink-mute">—</span> : <Confidence value={row.benchmarkScore} />
  },
  { key: 'created', header: 'created', render: (row) => <Timestamp iso={row.createdAt} /> }
]

/** One improvement-ledger line: outcome, plain reason, drift state, benchmark. */
function ImprovementEntry({ entry }: { entry: SkillImprovementEntryDto }): React.JSX.Element {
  const rolledBack = entry.rolledBackAt !== null
  const drifted = entry.driftFlaggedAt !== null
  const outcome = plainStatus(entry.outcome)
  const hasBenchmark = Object.keys(entry.benchmark).length > 0
  return (
    <li className="flex flex-col gap-1 border-b border-line pb-2 text-[12px] last:border-b-0">
      <div className="flex items-center gap-2">
        <PlainBadge status={entry.outcome} />
        <span className="ml-auto shrink-0">
          <Timestamp iso={entry.createdAt} />
        </span>
      </div>
      {entry.reason !== null && entry.reason !== '' ? (
        <div className="text-ink-mute">{entry.reason}</div>
      ) : outcome.explain !== '' ? (
        <div className="text-ink-mute">{outcome.explain}</div>
      ) : null}
      {(rolledBack || drifted) && (
        <div className="flex flex-wrap items-center gap-2">
          {drifted && <PlainBadge status="drift-flagged" />}
          {rolledBack && <PlainBadge status="rolled-back" />}
          {drifted && entry.driftResolvedAt === null && !rolledBack && (
            <span className="text-ink-mute">Its correction rate looks worse than the version before it.</span>
          )}
        </div>
      )}
      {hasBenchmark && (
        <Disclosure summary="Benchmark details">
          <pre className="overflow-x-auto font-mono text-[11px] leading-4 text-ink-mute">
            {JSON.stringify(entry.benchmark, null, 2)}
          </pre>
        </Disclosure>
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
      <SectionHeader>How it improves</SectionHeader>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={data.settings.mode}
            ariaLabel="when to adopt a better version"
            testId="skill-mode-select"
            options={[
              { value: 'stylistic', label: 'Ask me before adopting' },
              { value: 'verifiable', label: 'Adopt automatically when it scores better' }
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
            ariaLabel="what to do on a possible quality drop"
            testId="skill-autorevert-select"
            options={[
              { value: 'off', label: 'Just flag a quality drop' },
              { value: 'on', label: 'Roll back automatically on a quality drop' }
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
            Improve now
          </Button>
          <Button
            variant="danger"
            disabled={busy || !data.canRollback}
            testId="skill-rollback"
            title={data.canRollback ? 'restore the previous version' : 'no standing adoption to roll back'}
            onClick={() => mutate(() => call('skills.rollback', { skillId }), 'previous version restored')}
          >
            Roll back
          </Button>
        </div>
        <div className="text-[12px] text-ink-mute">
          {data.settings.lastRunAt !== null ? (
            <>
              Last checked <Timestamp iso={data.settings.lastRunAt} />.{' '}
            </>
          ) : (
            'Not checked yet. '
          )}
          Runs automatically overnight when there’s new feedback.
        </div>
        {data.history.length === 0 ? (
          <div className="text-[12px] text-ink-mute">No improvement attempts yet.</div>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="skill-improvement-history">
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
      <div className="flex flex-col gap-1">
        <div className="text-[16px] font-semibold">{skill.name}</div>
        <div className="text-[12px] text-ink-mute">
          {skill.currentVersion !== null ? (
            <>
              Currently using version <span className="font-mono text-ink">{skill.currentVersion}</span>.
            </>
          ) : (
            'No version in use yet.'
          )}
        </div>
        <Disclosure summary="Technical details">
          <KV
            entries={[
              { k: 'skill id', v: <span className="font-mono">{skill.id}</span> },
              { k: 'current version', v: <span className="font-mono">{skill.currentVersion ?? '—'}</span> }
            ]}
          />
        </Disclosure>
      </div>

      <ImprovementSection skillId={id} />

      <section>
        <SectionHeader>What it tells the assistant to do</SectionHeader>
        <div className="max-h-64 overflow-y-auto rounded-md bg-raised p-3 text-[12px] whitespace-pre-wrap">
          {skill.instructions}
        </div>
      </section>

      <section>
        <SectionHeader>Version history</SectionHeader>
        <DataTable
          columns={VERSION_COLUMNS}
          rows={skill.versions}
          rowKey={(row) => row.id}
          empty="No versions recorded yet."
        />
      </section>

      <section>
        <SectionHeader>Examples it learned from</SectionHeader>
        {skill.examples.length === 0 ? (
          <div className="text-[12px] text-ink-mute">No examples recorded yet.</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {skill.examples.map((example) => (
              <li key={example.id} className="flex items-start gap-2 text-[12px]">
                <PlainBadge status={example.kind} />
                <span className="min-w-0" title={example.content}>
                  {truncate(example.content, 140)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader>Corrections you made</SectionHeader>
        {skill.corrections.length === 0 ? (
          <div className="text-[12px] text-ink-mute">No corrections recorded yet.</div>
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
      <PanelHeader
        title="Skills"
        subtitle="Abilities your assistant is learning and improving."
        icon={<Icon name="skills" size={18} />}
      />
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
              empty="No skills learned yet. Your assistant builds skills as it works, and the improvement agent refines them over time."
              testId="skills-table"
            />
          )}
        </div>
        <div className="min-h-0 overflow-y-auto">
          {selectedId !== null ? (
            <SkillDetail key={selectedId} id={selectedId} />
          ) : (
            <EmptyState icon={<Icon name="skills" size={20} />}>Pick a skill to see how it’s doing.</EmptyState>
          )}
        </div>
      </div>
    </>
  )
}
