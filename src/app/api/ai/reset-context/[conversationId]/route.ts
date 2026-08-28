import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/ai/reset-context/[conversationId]  (agent+)
 *
 * "Reiniciar conversación" — give the bot a clean slate on one thread
 * without destroying anything the humans need.
 *
 * A thread here is eternal: `resolveConversation` matches an inbound by
 * phone and reopens the same row forever. That is right for the inbox and
 * wrong for the bot, which ends up reading months-old turns as if they
 * were the current exchange and stays pinned to whichever specialist last
 * handled the thread. Once a customer's history goes stale — a finished
 * order, an abandoned negotiation, a botched test run — the only way out
 * used to be deleting messages.
 *
 * This does it non-destructively, in one call:
 *   - `ai_context_reset_at = now()` — the memory watermark (migration
 *     042). From here on the model only sees messages sent AFTER this
 *     instant. The transcript itself is untouched: the inbox, the
 *     conversion module and every export still show the full history.
 *   - `ai_active_agent_id = null` — unpin the specialist. Without this
 *     the reset is half-done: the router's stickiness rule would keep the
 *     thread glued to the old agent even with an empty transcript, which
 *     is exactly how a wholesale thread kept answering as the order-taker
 *     and handed off on a plain price question.
 *   - clear the escalation mark, un-pause the bot, release the assignee
 *     and zero the reply counter, so the next inbound is treated like a
 *     first contact.
 *
 * Deliberately manual and rate-limited: a human decides a thread should
 * start over. Nothing automatable calls this.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Same bucket as the other per-user inbox actions.
    const limit = checkRateLimit(`ai-reset-context:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params

    // Confirm the thread is in the caller's account before writing. The
    // RLS-scoped client would block a cross-account write anyway; this
    // turns it into an honest 404 instead of a silent no-op.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/reset-context] conversation lookup error:', convErr)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const resetAt = new Date().toISOString()
    const { error: upErr } = await supabase
      .from('conversations')
      .update({
        ai_context_reset_at: resetAt,
        ai_active_agent_id: null,
        ai_autoreply_disabled: false,
        assigned_agent_id: null,
        ai_reply_count: 0,
        ai_handoff_summary: null,
        escalated_at: null,
        escalation_reason: null,
      })
      .eq('id', conversationId)
      .eq('account_id', accountId)

    if (upErr) {
      console.error('[ai/reset-context] update error:', upErr)
      return NextResponse.json(
        { error: 'Failed to reset the conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, reset_at: resetAt })
  } catch (err) {
    return toErrorResponse(err)
  }
}
