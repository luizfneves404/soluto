import type { Lock, QueueEntry, StateAdapter } from 'chat'

const GLOBAL_SHARD = '__chat_global__'

/**
 * Routes persisted Chat SDK keys to durable object shards:
 * - global: dedupe, callback cache, modals, transcripts, composio tool-router sessions
 * - channel id (e.g. telegram:123): locks, queues, channel-state (Telegram uses lockScope "channel")
 * - full thread id: subscriptions, thread-state, message history for that thread
 */
export function routeCacheKeyToShard(key: string): string {
  if (
    key.startsWith('dedupe:') ||
    key.startsWith('chat:callback:') ||
    key.startsWith('modal-context:') ||
    key.startsWith('transcripts:') ||
    key.startsWith('composio:')
  ) {
    return GLOBAL_SHARD
  }
  if (key.startsWith('thread-state:')) {
    return key.slice('thread-state:'.length)
  }
  if (key.startsWith('channel-state:')) {
    return key.slice('channel-state:'.length)
  }
  if (key.startsWith('msg-history:')) {
    return key.slice('msg-history:'.length)
  }
  return GLOBAL_SHARD
}

export function createDurableObjectStateAdapter(
  namespace: DurableObjectNamespace,
): StateAdapter {
  const rpc = async (
    shardId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    const id = namespace.idFromName(shardId)
    const stub = namespace.get(id)
    const response = await stub.fetch('https://chat-state/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = (await response.json()) as {
      ok?: boolean
      result?: unknown
      error?: string
    }
    if (!response.ok || !json.ok) {
      throw new Error(json.error ?? `DO rpc failed (${response.status})`)
    }
    return json.result
  }

  const adapter: StateAdapter = {
    async connect() {
      return
    },
    async disconnect() {
      return
    },
    async subscribe(threadId: string) {
      await rpc(threadId, { op: 'subscribe', threadId })
    },
    async unsubscribe(threadId: string) {
      await rpc(threadId, { op: 'unsubscribe', threadId })
    },
    async isSubscribed(threadId: string) {
      return Boolean(
        await rpc(threadId, { op: 'isSubscribed', threadId }),
      )
    },
    async acquireLock(threadId: string, ttlMs: number) {
      return (await rpc(threadId, {
        op: 'acquireLock',
        threadId,
        ttlMs,
      })) as Lock | null
    },
    async forceReleaseLock(threadId: string) {
      await rpc(threadId, { op: 'forceReleaseLock', threadId })
    },
    async releaseLock(lock: Lock) {
      await rpc(lock.threadId, { op: 'releaseLock', lock })
    },
    async extendLock(lock: Lock, ttlMs: number) {
      return Boolean(
        await rpc(lock.threadId, { op: 'extendLock', lock, ttlMs }),
      )
    },
    async get<T = unknown>(key: string) {
      const shardId = routeCacheKeyToShard(key)
      return rpc(shardId, { op: 'get', key }) as Promise<T | null>
    },
    async set<T = unknown>(key: string, value: T, ttlMs?: number) {
      const shardId = routeCacheKeyToShard(key)
      await rpc(shardId, { op: 'set', key, value, ttlMs })
    },
    async setIfNotExists(key: string, value: unknown, ttlMs?: number) {
      const shardId = routeCacheKeyToShard(key)
      return Boolean(
        await rpc(shardId, { op: 'setIfNotExists', key, value, ttlMs }),
      )
    },
    async delete(key: string) {
      const shardId = routeCacheKeyToShard(key)
      await rpc(shardId, { op: 'delete', key })
    },
    async appendToList(
      key: string,
      value: unknown,
      options?: { maxLength?: number; ttlMs?: number },
    ) {
      const shardId = routeCacheKeyToShard(key)
      await rpc(shardId, {
        op: 'appendToList',
        key,
        value,
        maxLength: options?.maxLength,
        ttlMs: options?.ttlMs,
      })
    },
    async getList<T = unknown>(key: string) {
      const shardId = routeCacheKeyToShard(key)
      return rpc(shardId, { op: 'getList', key }) as Promise<T[]>
    },
    async enqueue(threadId: string, entry: QueueEntry, maxSize: number) {
      return Number(
        await rpc(threadId, {
          op: 'enqueue',
          threadId,
          entry,
          maxSize,
        }),
      )
    },
    async dequeue(threadId: string) {
      return rpc(threadId, {
        op: 'dequeue',
        threadId,
      }) as Promise<QueueEntry | null>
    },
    async queueDepth(threadId: string) {
      return Number(await rpc(threadId, { op: 'queueDepth', threadId }))
    },
  }

  return adapter
}
