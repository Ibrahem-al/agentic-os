/**
 * Renderer-side IPC helpers: unwrap the IpcResult envelope into data or a
 * typed IpcError, plus a small fetch hook every panel shares (loading /
 * error / data / reload — PRODUCT.md: one instrument, one grammar).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcChannel, IpcErrorCode, IpcRequest, IpcResponse } from '../../../shared/ipc'

export class IpcError extends Error {
  readonly code: IpcErrorCode | string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
  }
}

/** Invoke a channel; throws IpcError with the backend's code + message. */
export async function call<C extends IpcChannel>(channel: C, req: IpcRequest<C>): Promise<IpcResponse<C>> {
  const result = await window.agenticOS.invoke(channel, req)
  if (!result.ok) throw new IpcError(result.code, result.message)
  return result.data
}

export interface IpcQuery<T> {
  readonly data: T | null
  readonly error: IpcError | null
  readonly loading: boolean
  reload(): void
}

/**
 * Fetch-on-mount hook. `req` is serialized for change detection, so inline
 * object literals are fine. `reload()` refetches in place (keeps stale data
 * visible while loading — dense tables must not flash empty).
 */
export function useIpc<C extends IpcChannel>(channel: C, req: IpcRequest<C>): IpcQuery<IpcResponse<C>> {
  const [data, setData] = useState<IpcResponse<C> | null>(null)
  const [error, setError] = useState<IpcError | null>(null)
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)
  const reqKey = JSON.stringify(req ?? null)
  const reqRef = useRef(req)
  reqRef.current = req

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    call(channel, reqRef.current)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof IpcError ? err : new IpcError('INTERNAL', String(err)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channel, reqKey, generation])

  const reload = useCallback(() => setGeneration((g) => g + 1), [])
  return { data, error, loading, reload }
}
