import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

const SLUG_RE = /^[a-z0-9_]{1,40}$/

/**
 * PATCH /api/ai/agents/[id]  (admin+)
 *
 * Partial update — the toggle in the roster sends only `is_active`, the
 * editor sends the whole persona. Every field is optional; absent keys
 * are left untouched.
 *
 * Writes go through the RLS-scoped SSR client, so an agent belonging to
 * another account simply isn't found (404) rather than leaking that it
 * exists.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}

    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name) {
        return NextResponse.json(
          { error: 'name cannot be empty' },
          { status: 400 },
        )
      }
      update.name = name
    }
    if (typeof body.slug === 'string') {
      const slug = body.slug.trim().toLowerCase()
      if (!SLUG_RE.test(slug)) {
        return NextResponse.json(
          {
            error:
              'slug must be 1-40 characters, lowercase letters, numbers or underscores only',
          },
          { status: 400 },
        )
      }
      update.slug = slug
    }
    if (typeof body.description === 'string') {
      update.description = body.description.trim()
    }
    if (typeof body.system_prompt === 'string') {
      update.system_prompt = body.system_prompt.trim()
    }
    if (typeof body.is_active === 'boolean') update.is_active = body.is_active
    if (typeof body.sort_order === 'number') update.sort_order = body.sort_order

    // Promoting a fallback is a swap, not a plain write: the partial
    // unique index allows only one per account, so the incumbent has to
    // step down first or the UPDATE below fails with 23505.
    if (body.is_fallback === true) {
      const { error: clearErr } = await supabase
        .from('ai_agents')
        .update({ is_fallback: false })
        .eq('account_id', accountId)
        .eq('is_fallback', true)
        .neq('id', id)
      if (clearErr) {
        console.error('[ai/agents PATCH] clearing old fallback failed:', clearErr)
        return NextResponse.json(
          { error: 'Failed to update fallback agent' },
          { status: 500 },
        )
      }
      update.is_fallback = true
    } else if (body.is_fallback === false) {
      update.is_fallback = false
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('ai_agents')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'That slug is already used by another agent.' },
          { status: 409 },
        )
      }
      console.error('[ai/agents PATCH] update error:', error)
      return NextResponse.json(
        { error: 'Failed to update agent' },
        { status: 500 },
      )
    }
    if (!data) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/agents/[id]  (admin+)
 *
 * Conversations pointing at this agent keep working — the FK is
 * ON DELETE SET NULL, so they just re-open to routing on the next
 * inbound.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const { data, error } = await supabase
      .from('ai_agents')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[ai/agents DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete agent' },
        { status: 500 },
      )
    }
    if (!data) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
