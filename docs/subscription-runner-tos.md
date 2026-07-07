# Subscription runner — Terms-of-Service gate (recorded)

> A recorded process gate, not a code check and not legal advice. It has no
> enforcement beyond this record and the app's off-by-default posture.

## Status

**The subscription runner ships OFF by default.** In a fresh install
`runner.enabled = false` and `runner.mode = 'completion'`; nothing spawns the
`claude` CLI and no text is sent to Anthropic. Turning it on is an explicit,
per-user, consent-gated action (the first-enable dialog in Settings and the
[Subscription runner](../README.md#subscription-runner-optional-off-by-default)
section of the README).

## The gate

The subscription runner routes background reasoning through a user's **consumer
Claude subscription** via the `claude` CLI — including, under
`runner.mode = 'agent'`, a **scheduled, headless** `claude -p` invocation with no
human in the loop at call time. Automated / headless / scheduled use of a consumer
subscription is exactly the kind of usage that Anthropic's **Usage Policy** and
**Consumer Terms of Service** speak to, and those terms change over time.

**Recorded requirement:** before ANY default in this app is ever flipped toward
the subscription runner — enabling it out of the box, defaulting `mode` to
`'agent'`, shipping it pre-consented, or removing the consent dialog — the
then-current Anthropic Usage Policy and Consumer Terms for scheduled/headless use
of a Claude subscription **MUST be re-confirmed**, and a dated line added to the
re-check log below. Whoever proposes changing a runner default owns that
re-confirmation.

## Re-check log

- **2026-07-06** — Recorded at feature ship (phase 20). Runner ships OFF by
  default; no default was flipped. The terms were **not** re-verified in this
  session — this note only *establishes* the gate for any future change. Any
  change toward the subscription default is blocked on a fresh re-check here.

## Not covered by this gate

- **Bring-your-own cloud API keys** (Anthropic / OpenAI / Gemini / OpenRouter)
  are governed by those providers' **API** terms — a separate, metered path —
  not the consumer-subscription terms, and are unchanged by this feature.
- The **local** Ollama + in-process reranker path sends nothing off the machine.

## Related

- [`README.md` → Privacy](../README.md#privacy--what-leaves-your-machine) — what
  leaves the machine when the runner is on.
- [`README.md` → Subscription runner](../README.md#subscription-runner-optional-off-by-default)
  — enable/consent, the local/API fallback, and the still-required Ollama.
