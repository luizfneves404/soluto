import type { Lock, QueueEntry } from 'chat'

const SNAPSHOT_KEY = 'chat-state-snapshot-v1'

type Cached<T> = { value: T; expiresAt: number | null }

type Snapshot = {
  subscriptions: string[]
  locks: Record<string, Lock>
  cache: Record<string, Cached<unknown>>
  queues: Record<string, QueueEntry[]>
}

function generateToken() {
  return `do_${crypto.randomUUID().replace(/-/g, '')}`
}

export class ChatStateDurableObject implements DurableObject {
  private subscriptions = new Set<string>()
  private locks = new Map<string, Lock>()
  private cache = new Map<string, Cached<unknown>>()
  private queues = new Map<string, QueueEntry[]>()
  private loaded = false

  constructor(
    private readonly ctx: DurableObjectState,
    _env: unknown,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }
    const snap = await this.ctx.storage.get<Snapshot>(SNAPSHOT_KEY)
    if (snap) {
      this.subscriptions = new Set(snap.subscriptions ?? [])
      this.locks = new Map(Object.entries(snap.locks ?? {}))
      this.cache = new Map(
        Object.entries(snap.cache ?? {}).map(([key, entry]) => [
          key,
          entry as Cached<unknown>,
        ]),
      )
      this.queues = new Map(
        Object.entries(snap.queues ?? {}).map(([key, entries]) => [
          key,
          entries as QueueEntry[],
        ]),
      )
    }
    this.loaded = true
  }

  private async persistNow(): Promise<void> {
    const snapshot: Snapshot = {
      subscriptions: [...this.subscriptions],
      locks: Object.fromEntries(this.locks),
      cache: Object.fromEntries(this.cache),
      queues: Object.fromEntries(this.queues),
    }
    await this.ctx.storage.put(SNAPSHOT_KEY, snapshot)
  }

  private cleanExpiredLocks(): void {
    const now = Date.now()
    for (const [threadId, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(threadId)
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded()
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }
    try {
      const body = (await request.json()) as Record<string, unknown>
      const { result, dirty } = await this.dispatch(body)
      if (dirty) {
        await this.persistNow()
      }
      return Response.json({ ok: true, result })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return Response.json({ ok: false, error: message }, { status: 500 })
    }
  }

  private async dispatch(
    body: Record<string, unknown>,
  ): Promise<{ result: unknown; dirty: boolean }> {
    const op = body.op
    let dirty = false
    const mark = () => {
      dirty = true
    }
    switch (op) {
      case 'connect':
      case 'disconnect':
        return { result: null, dirty: false }
      case 'subscribe': {
        const threadId = String(body.threadId)
        this.subscriptions.add(threadId)
        mark()
        return { result: null, dirty }
      }
      case 'unsubscribe': {
        const threadId = String(body.threadId)
        this.subscriptions.delete(threadId)
        mark()
        return { result: null, dirty }
      }
      case 'isSubscribed': {
        const threadId = String(body.threadId)
        return { result: this.subscriptions.has(threadId), dirty: false }
      }
      case 'acquireLock': {
        const threadId = String(body.threadId)
        const ttlMs = Number(body.ttlMs)
        const locksBefore = this.locks.size
        this.cleanExpiredLocks()
        if (this.locks.size !== locksBefore) {
          mark()
        }
        const existingLock = this.locks.get(threadId)
        if (existingLock && existingLock.expiresAt > Date.now()) {
          return { result: null, dirty }
        }
        const lock: Lock = {
          threadId,
          token: generateToken(),
          expiresAt: Date.now() + ttlMs,
        }
        this.locks.set(threadId, lock)
        mark()
        return { result: lock, dirty }
      }
      case 'forceReleaseLock': {
        const threadId = String(body.threadId)
        if (this.locks.has(threadId)) {
          mark()
        }
        this.locks.delete(threadId)
        return { result: null, dirty }
      }
      case 'releaseLock': {
        const lock = body.lock as Lock
        const existingLock = this.locks.get(lock.threadId)
        if (existingLock && existingLock.token === lock.token) {
          this.locks.delete(lock.threadId)
          mark()
        }
        return { result: null, dirty }
      }
      case 'extendLock': {
        const lock = body.lock as Lock
        const ttlMs = Number(body.ttlMs)
        const existingLock = this.locks.get(lock.threadId)
        if (!existingLock || existingLock.token !== lock.token) {
          return { result: false, dirty: false }
        }
        if (existingLock.expiresAt < Date.now()) {
          this.locks.delete(lock.threadId)
          mark()
          return { result: false, dirty }
        }
        existingLock.expiresAt = Date.now() + ttlMs
        mark()
        return { result: true, dirty }
      }
      case 'get': {
        const key = String(body.key)
        const cached = this.cache.get(key)
        if (!cached) {
          return { result: null, dirty: false }
        }
        if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
          this.cache.delete(key)
          return { result: null, dirty: true }
        }
        return { result: cached.value, dirty: false }
      }
      case 'set': {
        const key = String(body.key)
        const value = body.value
        const ttlMs = body.ttlMs as number | undefined
        this.cache.set(key, {
          value,
          expiresAt: ttlMs ? Date.now() + ttlMs : null,
        })
        mark()
        return { result: null, dirty }
      }
      case 'setIfNotExists': {
        const key = String(body.key)
        const value = body.value
        const ttlMs = body.ttlMs as number | undefined
        const existing = this.cache.get(key)
        if (existing) {
          if (existing.expiresAt !== null && existing.expiresAt <= Date.now()) {
            this.cache.delete(key)
          } else {
            return { result: false, dirty: false }
          }
        }
        this.cache.set(key, {
          value,
          expiresAt: ttlMs ? Date.now() + ttlMs : null,
        })
        mark()
        return { result: true, dirty }
      }
      case 'delete': {
        const key = String(body.key)
        if (this.cache.has(key)) {
          mark()
        }
        this.cache.delete(key)
        return { result: null, dirty }
      }
      case 'appendToList': {
        const key = String(body.key)
        const value = body.value
        const maxLength = body.maxLength as number | undefined
        const ttlMs = body.ttlMs as number | undefined
        const cached = this.cache.get(key)
        let list: unknown[]
        if (cached && cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
          list = []
        } else if (cached && Array.isArray(cached.value)) {
          list = cached.value as unknown[]
        } else {
          list = []
        }
        list.push(value)
        if (maxLength && list.length > maxLength) {
          list = list.slice(list.length - maxLength)
        }
        this.cache.set(key, {
          value: list,
          expiresAt: ttlMs ? Date.now() + ttlMs : null,
        })
        mark()
        return { result: null, dirty }
      }
      case 'getList': {
        const key = String(body.key)
        const cached = this.cache.get(key)
        if (!cached) {
          return { result: [], dirty: false }
        }
        if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
          this.cache.delete(key)
          return { result: [], dirty: true }
        }
        if (Array.isArray(cached.value)) {
          return { result: cached.value, dirty: false }
        }
        return { result: [], dirty: false }
      }
      case 'enqueue': {
        const threadId = String(body.threadId)
        const entry = body.entry as QueueEntry
        const maxSize = Number(body.maxSize)
        let queue = this.queues.get(threadId)
        if (!queue) {
          queue = []
          this.queues.set(threadId, queue)
        }
        queue.push(entry)
        if (queue.length > maxSize) {
          queue.splice(0, queue.length - maxSize)
        }
        mark()
        return { result: queue.length, dirty }
      }
      case 'dequeue': {
        const threadId = String(body.threadId)
        const queue = this.queues.get(threadId)
        if (!queue || queue.length === 0) {
          return { result: null, dirty: false }
        }
        const entry = queue.shift()
        if (queue.length === 0) {
          this.queues.delete(threadId)
        }
        mark()
        return { result: entry ?? null, dirty }
      }
      case 'queueDepth': {
        const threadId = String(body.threadId)
        return {
          result: this.queues.get(threadId)?.length ?? 0,
          dirty: false,
        }
      }
      default:
        throw new Error(`unsupported op: ${String(op)}`)
    }
  }
}
