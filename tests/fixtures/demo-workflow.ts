/**
 * The DoD 3-step demo workflow, shared by the in-process integration tests
 * and the kill/resume child process. Steps record their execution through an
 * injected recorder (an array pusher in-process, a file appender across
 * processes) and accumulate state via patches.
 */
import type { WorkflowStep } from '../../src/main/kernel'

export const DEMO_WORKFLOW_NAME = 'demo-three-step'

/** Printed by the blocking step 2 so the kill test knows when to SIGKILL. */
export const STEP2_HANDSHAKE = 'STEP2_STARTED'

/**
 * `step2` = 'run' completes normally; 'block' logs `process-start`, prints
 * the handshake and hangs forever (the kill test SIGKILLs the process there).
 */
export function demoSteps(record: (line: string) => void, step2: 'run' | 'block' = 'run'): WorkflowStep[] {
  return [
    {
      name: 'fetch',
      run: (state) => {
        record('fetch')
        return { fetched: `payload-${String(state['seed'])}` }
      }
    },
    {
      name: 'process',
      run:
        step2 === 'run'
          ? (state) => {
              record('process')
              return { processed: `${String(state['fetched'])}-processed` }
            }
          : async () => {
              record('process-start')
              console.log(STEP2_HANDSHAKE)
              await new Promise(() => undefined) // hang until SIGKILL
            }
    },
    {
      name: 'finalize',
      run: (state) => {
        record('finalize')
        return { finalized: true, summary: `${String(state['processed'])}-done` }
      }
    }
  ]
}
