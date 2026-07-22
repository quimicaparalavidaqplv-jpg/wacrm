import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/conversations/pending
 *
 * The "waiting for an advisor" queue: conversations the bot escalated
 * (`escalated_at` set) that no human has taken yet (`assigned_agent_id`
 * null). Oldest escalation first, so the longest-waiting customer is at
 * the top. Any account member may read it.
 *
 * `?count=1` returns just `{ count }` — used by the sidebar badge without
 * pulling every row.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const countOnly =
      new URL(request.url).searchParams.get('count') === '1'

    if (countOnly) {
      const { count, error } = await supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .not('escalated_at', 'is', null)
        .is('assigned_agent_id', null)
      if (error) {
        console.error('[conversations/pending count] error:', error)
        return NextResponse.json({ count: 0 })
      }
      return NextResponse.json({ count: count ?? 0 })
    }

    const { data, error } = await supabase
      .from('conversations')
      .select(
        'id, escalated_at, escalation_reason, last_message_text, last_message_at, contact:contacts(id, name, phone)',
      )
      .eq('account_id', accountId)
      .not('escalated_at', 'is', null)
      .is('assigned_agent_id', null)
      .order('escalated_at', { ascending: true })
      .limit(100)

    if (error) {
      console.error('[conversations/pending] error:', error)
      return NextResponse.json(
        { error: 'Failed to load pending conversations' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      conversations: data ?? [],
      count: data?.length ?? 0,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
