import { describe, expect, it } from 'vitest'
import * as config from '../../src/main/config'

describe('config (spec §20 defaults)', () => {
  it('pins the MCP server to streamable HTTP on 127.0.0.1:4517', () => {
    expect(config.MCP_HOST).toBe('127.0.0.1')
    expect(config.MCP_PORT).toBe(4517)
    expect(config.MCP_TRANSPORT).toBe('streamable-http')
    expect(config.HOOK_SESSION_END_URL).toBe('http://127.0.0.1:4517/hooks/session-end')
  })

  it('uses BGE-M3 (1024-dim) as the only embedding model', () => {
    expect(config.EMBEDDING_MODEL).toBe('bge-m3')
    expect(config.EMBEDDING_DIM).toBe(1024)
  })

  it('fuses retrieval scores 0.5 vector / 0.2 keyword / 0.3 graph-proximity', () => {
    const w = config.RETRIEVAL_FUSION_WEIGHTS
    expect(w.vector).toBe(0.5)
    expect(w.keyword).toBe(0.2)
    expect(w.graphProximity).toBe(0.3)
    expect(w.vector + w.keyword + w.graphProximity).toBeCloseTo(1.0)
    expect(config.RETRIEVAL_VECTOR_TOP_K).toBe(30)
    expect(config.RETRIEVAL_FTS_TOP_K).toBe(30)
    expect(config.RETRIEVAL_BUNDLE_TOP_N).toBe(8)
  })

  it('bounds the self-correcting loop at 5 iterations', () => {
    expect(config.LOOP_MAX_ITERATIONS).toBe(5)
  })

  it('sets entity-resolution thresholds 0.90 merge / 0.75 tiebreak floor', () => {
    expect(config.ENTITY_MERGE_COSINE).toBe(0.9)
    expect(config.ENTITY_TIEBREAK_COSINE_LOW).toBe(0.75)
  })

  it('escalates extraction below 0.6 confidence or above 60k tokens', () => {
    expect(config.EXTRACTION_ESCALATE_CONFIDENCE).toBe(0.6)
    expect(config.EXTRACTION_ESCALATE_TRANSCRIPT_TOKENS).toBe(60_000)
  })

  it('retries background jobs 3 times with 1m/5m/25m backoff', () => {
    expect(config.JOB_RETRY_ATTEMPTS).toBe(3)
    expect(config.JOB_RETRY_BACKOFF_MS).toEqual([60_000, 300_000, 1_500_000])
  })

  it('resolves app-data paths under the given userData dir', () => {
    const p = config.appDataPaths('/tmp/userData')
    expect(p.graphDir.replaceAll('\\', '/')).toBe('/tmp/userData/graph')
    expect(p.appDb.replaceAll('\\', '/')).toBe('/tmp/userData/appdata.db')
    expect(p.modelsDir.replaceAll('\\', '/')).toBe('/tmp/userData/models')
    expect(p.backupsDir.replaceAll('\\', '/')).toBe('/tmp/userData/backups')
    expect(p.exportsDir.replaceAll('\\', '/')).toBe('/tmp/userData/exports')
  })

  it('keeps remaining §20 scalars intact', () => {
    expect(config.MCP_INACTIVITY_TIMEOUT_MS).toBe(30 * 60 * 1000)
    expect(config.RERANKER_MODEL).toBe('BAAI/bge-reranker-v2-m3')
    expect(config.RERANKER_QUANTIZATION).toBe('int8')
    expect(config.RERANKER_IDLE_UNLOAD_MS).toBe(5 * 60 * 1000)
    expect(config.SMALL_LLM_MODEL).toBe('qwen3:4b')
    expect(config.TRANSCRIPT_RETENTION_DAYS).toBe(14)
    expect(config.DRIFT_WATCH_USES).toBe(20)
    expect(config.DRIFT_AUTO_REVERT).toBe(false)
    expect(config.SPEND_CEILING_USD_DEFAULT).toBe(0.5)
    expect(config.CHUNK_TARGET_TOKENS).toBe(512)
    expect(config.CHUNK_OVERLAP_TOKENS).toBe(64)
    expect(config.PRUNE_JOB_CRON).toBe('0 3 * * *')
    expect(config.SKILL_JOB_CRON).toBe('0 2 * * *')
    expect(config.EXPORT_JOB_CRON).toBe('30 3 * * 0')
    expect(config.RYUGRAPH_VERSION_PIN).toBe('25.9.1')
  })
})
