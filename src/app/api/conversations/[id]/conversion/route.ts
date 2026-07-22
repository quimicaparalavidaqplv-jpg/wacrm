import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/conversations/[id]/conversion  (agent+)
 *
 * Mark a conversation's sales outcome from the chat:
 *   { outcome: 'won' | 'lost' | null }
 * 'won' = the customer bought, 'lost' = escalated but didn't close, null =
 * clear the mark. Feeds the Conversion panel. RLS-scoped, so a
 * conversation outside the caller's account isn't found.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const body = await request.json().catch(() => null)
    const outcome = body?.outcome ?? null
    if (outcome !== 'won' && outcome !== 'lost' && outcome !== null) {
      return NextResponse.json(
        { error: "outcome must be 'won', 'lost' or null" },
        { status: 400 },
      )
    }

    const { data, error } = await supabase
      .from('conversations')
      .update({ conversion_outcome: outcome })
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[conversations/conversion PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, outcome })
  } catch (err) {
    return toErrorResponse(err)
  }
}
