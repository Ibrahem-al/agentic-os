/**
 * Scripted model server for the phase-13 golden-path e2e (the release gate).
 *
 * One plain node:http server impersonates BOTH model tiers the PRODUCTION app
 * talks to over HTTP:
 *
 *  - the Ollama API (GET /api/tags, POST /api/embed, POST /api/generate) —
 *    the app's OllamaClient is pointed here via AGENTIC_OS_OLLAMA_BASE_URL;
 *  - OpenAI chat completions (POST /v1/chat/completions) — the app's cloud
 *    adapter is pointed here via AGENTIC_OS_CLOUD_BASE_URL.
 *
 * Replies dispatch on the SAME stable system-prompt markers the production
 * agents use. Wherever a marker constant is exported by an electron-free
 * module it is imported directly (skills benchmark/candidate/testset,
 * extraction fuzzy); markers that production does not export (critic, query
 * rewrite, injection scanner, project summary, tiebreak, verifier) are kept
 * here as literal copies and PINNED EQUAL to the production sources by
 * tests/unit/fixtures.fakeserver.test.ts — CI fails if they drift.
 *
 * Embeddings are fakeTextEmbedding (bag-of-words) so the app's HTTP-served
 * vectors are consistent with golden-seed's in-process ones.
 *
 * Also exported: the tiny reranker file fixture (a valid ONNX whose logits =
 * ReduceMean(input_ids) + a real-loadable @huggingface/tokenizers WordPiece
 * tokenizer whose token ids are ALL ≥ 40). All ids ≥ 40 ⇒ every logit ≥ 40 ⇒
 * sigmoid saturates to 1.0 for every doc, so the read path's final ordering
 * is decided by the graph-proximity signal — deterministic, and assertions
 * stay set-membership (never order-specific), as the reranker's scores are
 * garbage-but-deterministic by design.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  COMPARATOR_SYSTEM_PROMPT,
  EXECUTOR_SYSTEM_MARKER,
  GRADER_SYSTEM_PROMPT
} from '../../src/main/agents/skills/benchmark'
import { REWRITE_SYSTEM_PROMPT } from '../../src/main/agents/skills/candidate'
import { CASE_GEN_SYSTEM_MARKER } from '../../src/main/agents/skills/testset'
import { FUZZY_SYSTEM_PROMPTS } from '../../src/main/agents/extraction/fuzzy'
import { buildFixtureOnnxModel } from './onnxFixture'
import { fakeTextEmbedding } from './graph-seed'

// ── Golden scenario constants (shared by seed, spec and unit test) ───────────

export const GOLDEN_SKILL_ID = 'skill-golden-writer'
export const GOLDEN_SKILL_NAME = 'golden-writer'
export const GOLDEN_SKILL_INSTRUCTIONS = 'Write things plainly.'
export const GOLDEN_ADOPT_MARKER = 'GOLDEN-ADOPT-MARKER'

/** The 0.9-confidence preference — commits straight through the write gate. */
export const GOLDEN_COMMITTED_PREFERENCE = 'prefer two-space indentation over tabs in this project'
/** The 0.4-confidence preference — no cloud tier ⇒ EXACTLY one staged row. */
export const GOLDEN_STAGED_PREFERENCE = 'weak guess preference that must go to review'
/** The explicit correction; `skill` names the seeded Skill so IMPROVED links. */
export const GOLDEN_CORRECTION_CONTENT = 'When using the golden-writer skill, always state assumptions first.'

// ── Literal marker copies (production does NOT export these — pinned by the
//    unit test against the production sources so drift breaks CI) ────────────

/** src/main/retrieval/critic.ts CRITIC_SYSTEM ("You are a strict retrieval judge…"). */
export const CRITIC_MARKER = 'retrieval judge'
/** src/main/retrieval/critic.ts REWRITE_SYSTEM ("You rewrite search queries…"). */
export const QUERY_REWRITE_MARKER = 'rewrite search queries'
/** src/main/security/scanner.ts LLM verdict system prompt. */
export const SCANNER_MARKER = 'security scanner classifying documents'
/** src/main/ingest/codebase.ts summarizeReadme system prompt. */
export const SUMMARY_MARKER = 'You write short project summaries'
/** src/main/agents/extraction/resolve.ts TIEBREAK_SYSTEM_PROMPT. */
export const TIEBREAK_MARKER = 'entity resolution judge'
/** src/main/agents/extraction/verify.ts VERIFIER_SYSTEM_PROMPT. */
export const VERIFIER_MARKER = 'independent verification judge'

// ── Scripted replies ─────────────────────────────────────────────────────────

/**
 * Per-call confidence math (verified against fuzzy.ts before pinning):
 * components clean-empty = 1, preferences mean(0.9, 0.4) = 0.65, corrections
 * 0.9 ⇒ session ≈ 0.85 ≥ 0.6 ⇒ no cloud escalation. Items: 0.9 commits,
 * 0.4 stages (verify.ts 'skipped-no-cloud' in launch 1).
 */
export const GOLDEN_PREFERENCES_REPLY = JSON.stringify({
  items: [
    {
      statement: GOLDEN_COMMITTED_PREFERENCE,
      tags: ['style'],
      derived_from: null,
      evidence: 'user said so',
      confidence: 0.9
    },
    {
      statement: GOLDEN_STAGED_PREFERENCE,
      tags: [],
      derived_from: null,
      evidence: 'ambiguous',
      confidence: 0.4
    }
  ]
})

export const GOLDEN_CORRECTIONS_REPLY = JSON.stringify({
  items: [
    {
      content: GOLDEN_CORRECTION_CONTENT,
      skill: GOLDEN_SKILL_NAME,
      evidence: 'no - when using the golden-writer skill, always state assumptions first',
      confidence: 0.9
    }
  ]
})

export const GOLDEN_COMPONENTS_REPLY = JSON.stringify({ items: [] })

/** Passing critic verdict — the exact shape the retrieval ScriptedLlm returns. */
export const GOLDEN_CRITIC_REPLY = '{"score": 9, "missing": "none"}'

export const GOLDEN_SCANNER_REPLY = '{"suspicious": false, "reason": ""}'

export const GOLDEN_TIEBREAK_REPLY = '{"same": false}'

/** Passes codebase.ts acceptSummary: 20-600 chars, no narration phrases. */
export const GOLDEN_SUMMARY_REPLY =
  'Sprout panel is a greenhouse control panel that computes watering timetables from sensor readings and serves them over a small HTTP API.'

/** A complete VALID SKILL.md: exact name kept, body carries the adopt marker. */
export const GOLDEN_REWRITE_REPLY = [
  '---',
  `name: ${GOLDEN_SKILL_NAME}`,
  'description: Use this skill to write plainly, stating assumptions before conclusions.',
  '---',
  '',
  'Write things plainly.',
  'State your assumptions first, before any conclusions.',
  `Always include the token ${GOLDEN_ADOPT_MARKER} in your reasoning.`,
  ''
].join('\n')

export const GOLDEN_CASES_REPLY = JSON.stringify([
  { prompt: 'walk through a golden scenario for the golden-writer skill', expectations: ['mentions GOLDEN'] },
  {
    prompt: 'walk through a second golden scenario end to end',
    expectations: ['mentions GOLDEN', 'states assumptions first']
  }
])

export const GOLDEN_COMPARATOR_REPLY = '{"winner": "A", "reasoning": "scripted golden verdict"}'

export const GOLDEN_VERIFIER_REPLY = '{"verdict": "confirm", "confidence": 0.9, "note": "scripted golden verifier"}'

const FALLBACK_TEXT = 'golden fake model reply.'

// ── Dispatch (shared by the Ollama and OpenAI faces) ─────────────────────────

const EXECUTOR_INSTRUCTIONS_RE = /<skill_instructions>\n([\s\S]*)\n<\/skill_instructions>/
const GRADER_OUTPUT_RE = /<output>\n([\s\S]*?)\n<\/output>/

interface Dispatched {
  readonly marker: string
  readonly text: string
  readonly matched: boolean
}

function dispatch(system: string, prompt: string): Dispatched {
  // Extraction fuzzy passes (system markers imported from production).
  if (system.includes(FUZZY_SYSTEM_PROMPTS.components)) {
    return { marker: 'fuzzy-components', text: GOLDEN_COMPONENTS_REPLY, matched: true }
  }
  if (system.includes(FUZZY_SYSTEM_PROMPTS.preferences)) {
    return { marker: 'fuzzy-preferences', text: GOLDEN_PREFERENCES_REPLY, matched: true }
  }
  if (system.includes(FUZZY_SYSTEM_PROMPTS.corrections)) {
    return { marker: 'fuzzy-corrections', text: GOLDEN_CORRECTIONS_REPLY, matched: true }
  }
  // Skill benchmark tier (markers imported from production).
  if (system.startsWith(EXECUTOR_SYSTEM_MARKER)) {
    const instructions = EXECUTOR_INSTRUCTIONS_RE.exec(system)?.[1] ?? ''
    return { marker: 'executor', text: instructions, matched: true }
  }
  if (system === GRADER_SYSTEM_PROMPT) {
    const output = GRADER_OUTPUT_RE.exec(prompt)?.[1] ?? ''
    const passed = output.includes(GOLDEN_ADOPT_MARKER)
    return {
      marker: 'grader',
      text: JSON.stringify({ passed, evidence: passed ? `output carries ${GOLDEN_ADOPT_MARKER}` : 'marker absent from output' }),
      matched: true
    }
  }
  if (system === COMPARATOR_SYSTEM_PROMPT) return { marker: 'comparator', text: GOLDEN_COMPARATOR_REPLY, matched: true }
  if (system === REWRITE_SYSTEM_PROMPT) return { marker: 'skill-rewrite', text: GOLDEN_REWRITE_REPLY, matched: true }
  if (prompt.startsWith(CASE_GEN_SYSTEM_MARKER)) return { marker: 'casegen', text: GOLDEN_CASES_REPLY, matched: true }
  // Literal-copy markers (pinned by the unit test).
  if (system.includes(TIEBREAK_MARKER)) return { marker: 'tiebreak', text: GOLDEN_TIEBREAK_REPLY, matched: true }
  if (system.includes(CRITIC_MARKER)) return { marker: 'critic', text: GOLDEN_CRITIC_REPLY, matched: true }
  if (system.includes(QUERY_REWRITE_MARKER)) {
    return { marker: 'query-rewrite', text: 'watering schedule engine sensor moisture components', matched: true }
  }
  if (system.includes(SCANNER_MARKER)) return { marker: 'scanner', text: GOLDEN_SCANNER_REPLY, matched: true }
  if (system.includes(SUMMARY_MARKER)) return { marker: 'summary', text: GOLDEN_SUMMARY_REPLY, matched: true }
  if (system.includes(VERIFIER_MARKER)) return { marker: 'verifier', text: GOLDEN_VERIFIER_REPLY, matched: true }
  return { marker: 'unmatched', text: FALLBACK_TEXT, matched: false }
}

// ── The server ───────────────────────────────────────────────────────────────

export interface FakeModelRequest {
  readonly method: string
  readonly path: string
  /** Which scripted reply served it ('tags', 'embed', 'fuzzy-preferences', …). */
  readonly marker: string
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export class FakeModelServer {
  /** Every request served, in order — for assertions and failure dumps. */
  readonly requests: FakeModelRequest[] = []
  /** System prompts nothing matched (bounded excerpts) — should stay empty. */
  readonly unmatched: string[] = []
  private http: Server | null = null

  get port(): number {
    if (this.http === null) throw new Error('fake model server is not started')
    return (this.http.address() as AddressInfo).port
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    if (this.http !== null) throw new Error('fake model server already started')
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        console.error('[fake-model-server] handler crashed:', err)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.http = server
  }

  async stop(): Promise<void> {
    const server = this.http
    this.http = null
    if (server === null) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private log(req: IncomingMessage, marker: string): void {
    this.requests.push({ method: req.method ?? '', path: req.url ?? '', marker })
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''

    if (req.method === 'GET' && path === '/api/tags') {
      this.log(req, 'tags')
      this.json(res, 200, { models: [{ name: 'bge-m3' }, { name: 'qwen3:4b' }] })
      return
    }

    if (req.method === 'POST') {
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        this.log(req, 'bad-json')
        this.json(res, 400, { error: 'invalid JSON body' })
        return
      }
      if (!isRecord(body)) {
        this.log(req, 'bad-body')
        this.json(res, 400, { error: 'body must be a JSON object' })
        return
      }

      if (path === '/api/embed') {
        const input = body['input']
        const texts = Array.isArray(input) ? input.map((t) => String(t)) : [String(input ?? '')]
        this.log(req, 'embed')
        this.json(res, 200, { model: 'bge-m3', embeddings: texts.map((t) => fakeTextEmbedding(t)) })
        return
      }

      if (path === '/api/generate') {
        const system = typeof body['system'] === 'string' ? body['system'] : ''
        const prompt = typeof body['prompt'] === 'string' ? body['prompt'] : ''
        const reply = dispatch(system, prompt)
        this.log(req, reply.matched ? reply.marker : 'unmatched-generate')
        if (!reply.matched) this.noteUnmatched('generate', system, prompt)
        this.json(res, 200, {
          model: typeof body['model'] === 'string' ? body['model'] : 'qwen3:4b',
          created_at: new Date().toISOString(),
          response: reply.text,
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 10
        })
        return
      }

      if (path === '/v1/chat/completions') {
        // Accept any Authorization header — this is the scripted cloud tier.
        const messages = Array.isArray(body['messages']) ? body['messages'] : []
        const contentOf = (role: string): string => {
          for (const message of messages) {
            if (isRecord(message) && message['role'] === role && typeof message['content'] === 'string') {
              return message['content']
            }
          }
          return ''
        }
        const system = contentOf('system')
        const user = contentOf('user')
        const reply = dispatch(system, user)
        this.log(req, reply.matched ? `cloud-${reply.marker}` : 'unmatched-chat')
        if (!reply.matched) this.noteUnmatched('chat', system, user)
        this.json(res, 200, {
          id: 'chatcmpl-golden-fake',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'golden-fake',
          choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10 }
        })
        return
      }
    }

    this.log(req, 'not-found')
    console.warn(`[fake-model-server] unhandled ${req.method ?? ''} ${path}`)
    this.json(res, 404, { error: `fake model server: no route for ${req.method ?? ''} ${path}` })
  }

  private noteUnmatched(face: string, system: string, prompt: string): void {
    const note = `${face}: system='${system.slice(0, 120)}' prompt='${prompt.slice(0, 120)}'`
    this.unmatched.push(note)
    console.warn(`[fake-model-server] UNMATCHED ${note}`)
  }
}

// ── Reranker file fixture (AGENTIC_OS_RERANKER_FILES) ────────────────────────

export interface GoldenPinnedFile {
  url: string
  sha256: string
  fileName: string
}

export interface GoldenRerankerFixture {
  /** Matches RerankerOptions['files'] — serialize this as the descriptor JSON. */
  readonly files: { model: GoldenPinnedFile; tokenizer: GoldenPinnedFile; tokenizerConfig: GoldenPinnedFile }
  readonly bytes: { model: Buffer; tokenizer: Buffer; tokenizerConfig: Buffer }
}

/**
 * A real-loadable tokenizer.json for @huggingface/tokenizers (WordPiece +
 * Whitespace + RobertaProcessing, mimicking XLM-R's <s> A </s></s> B </s>
 * pair shape) with `<pad>`/`</s>` present as the production factory requires.
 * EVERY id ≥ 40 so the ONNX fixture's ReduceMean logits saturate sigmoid at
 * 1.0 — see the module header.
 */
function goldenTokenizerJson(): Record<string, unknown> {
  const special = (id: number, content: string): Record<string, unknown> => ({
    id,
    content,
    single_word: false,
    lstrip: false,
    rstrip: false,
    normalized: false,
    special: true
  })
  return {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [special(40, '<s>'), special(41, '<pad>'), special(42, '</s>'), special(43, '<unk>')],
    normalizer: { type: 'Lowercase' },
    pre_tokenizer: { type: 'Whitespace' },
    post_processor: {
      type: 'RobertaProcessing',
      sep: ['</s>', 42],
      cls: ['<s>', 40],
      trim_offsets: true,
      add_prefix_space: false
    },
    decoder: null,
    model: {
      type: 'WordPiece',
      unk_token: '<unk>',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      vocab: {
        '<s>': 40,
        '<pad>': 41,
        '</s>': 42,
        '<unk>': 43,
        schedule: 44,
        watering: 45,
        component: 46,
        golden: 47,
        sprout: 48,
        sensor: 49
      }
    }
  }
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export function buildGoldenRerankerFixture(): GoldenRerankerFixture {
  const model = buildFixtureOnnxModel()
  const tokenizer = Buffer.from(JSON.stringify(goldenTokenizerJson()), 'utf8')
  const tokenizerConfig = Buffer.from(JSON.stringify({ model_max_length: 1024 }), 'utf8')
  return {
    files: {
      model: { url: 'https://golden.invalid/model.onnx', sha256: sha256Hex(model), fileName: 'golden-reranker.onnx' },
      tokenizer: {
        url: 'https://golden.invalid/tokenizer.json',
        sha256: sha256Hex(tokenizer),
        fileName: 'golden-tokenizer.json'
      },
      tokenizerConfig: {
        url: 'https://golden.invalid/tokenizer_config.json',
        sha256: sha256Hex(tokenizerConfig),
        fileName: 'golden-tokenizer_config.json'
      }
    },
    bytes: { model, tokenizer, tokenizerConfig }
  }
}

/**
 * Pre-place the fixture weights in `modelsDir` (so the production Reranker's
 * checksum pass finds verified files and downloads NOTHING) and write the
 * AGENTIC_OS_RERANKER_FILES descriptor JSON at `descriptorPath`.
 */
export function writeGoldenRerankerFixture(modelsDir: string, descriptorPath: string): GoldenRerankerFixture {
  const fixture = buildGoldenRerankerFixture()
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(join(modelsDir, fixture.files.model.fileName), fixture.bytes.model)
  writeFileSync(join(modelsDir, fixture.files.tokenizer.fileName), fixture.bytes.tokenizer)
  writeFileSync(join(modelsDir, fixture.files.tokenizerConfig.fileName), fixture.bytes.tokenizerConfig)
  writeFileSync(descriptorPath, JSON.stringify(fixture.files, null, 2))
  return fixture
}
