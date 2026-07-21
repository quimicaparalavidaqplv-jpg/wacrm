import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAllAgents } from '@/lib/ai/agents'

/** Mirrors the CHECK constraint on `ai_agents.slug` (migration 037). */
const SLUG_RE = /^[a-z0-9_]{1,40}$/

/**
 * GET /api/ai/agents
 *
 * The account's full agent roster, active and inactive (any member).
 * The inbox reads this to label which agent answered a thread, so it is
 * deliberately not admin-gated.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const agents = await loadAllAgents(supabase, accountId)
    return NextResponse.json({ agents })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/agents  (admin+)
 *
 * Create one agent. `slug` must be unique within the account — the
 * router maps the classifier's answer to exactly one row, so a duplicate
 * would make routing ambiguous. The DB's UNIQUE(account_id, slug) is the
 * real guard; we translate its error into a readable 409.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : ''
    const description =
      typeof body?.description === 'string' ? body.description.trim() : ''
    const systemPrompt =
      typeof body?.system_prompt === 'string' ? body.system_prompt.trim() : ''

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (!SLUG_RE.test(slug)) {
      return NextResponse.json(
        {
          error:
            'slug must be 1-40 characters, lowercase letters, numbers or underscores only',
        },
        { status: 400 },
      )
    }

    const { data, error } = await supabase
      .from('ai_agents')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        slug,
        description,
        system_prompt: systemPrompt,
        is_active: body?.is_active !== false,
        is_fallback: body?.is_fallback === true,
        sort_order: Number.isFinite(body?.sort_order) ? body.sort_order : 0,
      })
      .select('id')
      .single()

    if (error) {
      // 23505 = unique_violation: either the slug is taken, or the
      // account already has a fallback agent (partial unique index).
      if (error.code === '23505') {
        const isFallbackClash = error.message.includes('one_fallback')
        return NextResponse.json(
          {
            error: isFallbackClash
              ? 'This account already has a fallback agent. Unset the current one first.'
              : `An agent with the slug "${slug}" already exists.`,
          },
          { status: 409 },
        )
      }
      console.error('[ai/agents POST] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to create agent' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
