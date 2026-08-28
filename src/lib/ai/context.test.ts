import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/**
 * Minimal fake matching the query chain in buildConversationContext:
 *   from().select().eq().in()[.gt()].order().limit() → { data, error }
 *
 * `.gt()` is only in the chain when a reset watermark is passed, so the
 * fake records the calls it receives and lets a test assert on them.
 */
function fakeDb(rows: unknown[]) {
  const calls: { gt?: [string, unknown]; limit?: number } = {}
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    gt: (col: string, val: unknown) => {
      calls.gt = [col, val]
      return chain
    },
    order: () => chain,
    limit: (n: number) => {
      calls.limit = n
      return Promise.resolve({ data: rows, error: null })
    },
  }
  return { db: chain as unknown as SupabaseClient, calls }
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows).db, 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]).db,
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]).db,
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  // --- memory watermark (migration 042) --------------------------------

  it('does not filter by created_at when no reset watermark is set', async () => {
    const f = fakeDb([{ sender_type: 'customer', content_text: 'hi' }])
    await buildConversationContext(f.db, 'conv-1', 20, null)
    expect(f.calls.gt).toBeUndefined()
  })

  it('only reads messages after the reset watermark when one is set', async () => {
    const f = fakeDb([{ sender_type: 'customer', content_text: 'hi' }])
    const resetAt = '2026-08-27T18:00:00.000Z'
    await buildConversationContext(f.db, 'conv-1', 20, resetAt)
    expect(f.calls.gt).toEqual(['created_at', resetAt])
  })
})
