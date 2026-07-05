/**
 * Golden-path e2e seed (phase 13). Prepares a FRESH userData profile for the
 * release-gate spec (tests/e2e/golden-path.spec.ts):
 *
 *   - ONE Skill node ('golden-writer') the MCP session will use, seeded with
 *     the exact retrieval render embedding (skillEmbedText + fakeTextEmbedding
 *     — consistent with the fake model server's /api/embed);
 *   - settings.json {"cloudProvider": "openai"} so launch 2 arms the scripted
 *     cloud tier the moment a key lands in the keychain;
 *   - one AUDITED file write via the REAL AuditLog: golden-notes.txt is
 *     created with ORIGINAL bytes, then overwritten through
 *     AuditLog.fileWrite — the spec undoes that action from the dashboard and
 *     byte-compares the restore.
 *
 * Runs as a CHILD process (the dashboard-seed pattern): ryugraph 25.9.1's
 * Database.close() poisons process teardown, so the engine handle is retained
 * and only process exit releases the graph lock for the app under test.
 *
 *   npx esbuild tests/fixtures/golden-seed.ts --bundle --platform=node
 *     --format=esm --outfile=out/smoke/golden-seed.mjs
 *   node out/smoke/golden-seed.mjs <scratchUserDataDir> --json
 */
import { mkdirSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RYU_EXTENSION_VERSION_DIR } from '../../src/main/config'
import { openAppData, openRyuGraphEngine } from '../../src/main/storage'
import { AuditLog } from '../../src/main/security'
import { skillEmbedText } from '../../src/main/agents/skills/lifecycle'
import { fakeTextEmbedding } from './graph-seed'
import { GOLDEN_SKILL_ID, GOLDEN_SKILL_INSTRUCTIONS, GOLDEN_SKILL_NAME } from './fake-model-server'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/** ASCII-only so the byte-for-byte restore assert is encoding-proof. */
export const GOLDEN_NOTES_ORIGINAL = 'golden original notes v1 - restore me byte for byte\n'
export const GOLDEN_NOTES_OVERWRITTEN = 'OVERWRITTEN by golden seed\n'

export interface GoldenSeedResult {
  readonly userDataDir: string
  readonly skillId: string
  readonly skillName: string
  /** The file the audited write overwrote; undo must restore ORIGINAL bytes. */
  readonly auditedFilePath: string
  readonly originalContent: string
  /** The reversible audit action the spec undoes from the dashboard. */
  readonly undoActionId: string
}

export async function seedGoldenPath(userDataDir: string): Promise<GoldenSeedResult> {
  mkdirSync(userDataDir, { recursive: true })
  const appData = openAppData(join(userDataDir, 'appdata.db'))
  const engine = await openRyuGraphEngine({
    graphDir: join(userDataDir, 'graph'),
    backupsDir: join(userDataDir, 'backups'),
    extensionsDir: join(repoRoot, 'resources', 'extensions', RYU_EXTENSION_VERSION_DIR)
  })

  try {
    // ── the one seeded Skill (extraction links IMPROVED to it by exact name;
    //    the improvement job later rewrites + adopts it) ──────────────────────
    await engine.upsertNode('Skill', {
      id: GOLDEN_SKILL_ID,
      name: GOLDEN_SKILL_NAME,
      instructions: GOLDEN_SKILL_INSTRUCTIONS,
      current_version: '',
      // Exactly what retrieval renders for a Skill — same bag-of-words hash
      // the fake server's /api/embed serves, so vectors stay consistent.
      embedding: fakeTextEmbedding(skillEmbedText(GOLDEN_SKILL_NAME, GOLDEN_SKILL_INSTRUCTIONS))
    })

    // ── settings: the scripted cloud provider (key arrives via the dashboard) ─
    writeFileSync(
      join(userDataDir, 'settings.json'),
      `${JSON.stringify({ cloudProvider: 'openai', cloudModels: {} }, null, 2)}\n`,
      'utf8'
    )

    // ── one REAL audited, reversible file write (pre-image → backups/audit/) ─
    const auditedFilePath = join(userDataDir, 'golden-notes.txt')
    writeFileSync(auditedFilePath, GOLDEN_NOTES_ORIGINAL, 'utf8')
    const audit = new AuditLog({ db: appData.db, backupsDir: join(userDataDir, 'backups'), engine })
    const { actionId: undoActionId } = audit.fileWrite('system', auditedFilePath, GOLDEN_NOTES_OVERWRITTEN)

    return {
      userDataDir,
      skillId: GOLDEN_SKILL_ID,
      skillName: GOLDEN_SKILL_NAME,
      auditedFilePath,
      originalContent: GOLDEN_NOTES_ORIGINAL,
      undoActionId
    }
  } finally {
    // ryugraph 25.9.1: Database.close() poisons process teardown — checkpoint
    // and close the connection only (the app quit path's discipline); the
    // retained handle is why this seed MUST run as a child process.
    await engine.close({ skipDatabaseClose: true })
    appData.close()
  }
}

// CLI entry (esbuild-bundled; see module header).
// pathToFileURL, NOT a hand-built `file:///${argv[1]}` (see dashboard-seed —
// the hand-built form silently no-ops on POSIX absolute paths).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const dir = process.argv[2]
  if (dir === undefined || dir === '') {
    console.error('usage: node golden-seed.mjs <scratchUserDataDir> [--json]')
    process.exit(1)
  }
  seedGoldenPath(dir)
    .then((result) => {
      if (process.argv.includes('--json')) {
        // writeSync, not console.log: process.exit(0) below drops async-
        // buffered pipe writes on Linux (see dashboard-seed).
        writeSync(1, JSON.stringify(result) + '\n')
      } else {
        console.log(`[golden-seed] profile seeded at ${result.userDataDir}`)
        console.log(`[golden-seed]   skill: ${result.skillId} ('${result.skillName}')`)
        console.log(`[golden-seed]   audited file write: ${result.undoActionId} → ${result.auditedFilePath}`)
      }
      // Explicit clean exit: the retained ryugraph handle would otherwise
      // fault during natural process teardown (phase-01/08 finding).
      process.exit(0)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
