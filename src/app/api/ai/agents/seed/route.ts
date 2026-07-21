import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { AGENT_TEMPLATES } from '@/lib/ai/agent-templates'

/**
 * POST /api/ai/agents/seed  (admin+)
 *
 * Install the starter roster (`AGENT_TEMPLATES`) into the account.
 *
 * Additive and non-destructive: templates whose slug already exists are
 * skipped, never overwritten. An operator who has spent an hour tuning
 * `ventas_mayor` must be able to press this — to pick up a template
 * added later — without losing that work. The response reports what was
 * created and what was skipped so the UI can say so plainly.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(
      `ai-agents-seed:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { data: existingRows, error: readErr } = await supabase
      .from('ai_agents')
      .select('slug, is_fallback')
      .eq('account_id', accountId)

    if (readErr) {
      console.error('[ai/agents/seed] read error:', readErr)
      return NextResponse.json(
        { error: 'Failed to read existing agents' },
        { status: 500 },
      )
    }

    const existing = new Set((existingRows ?? []).map((r) => r.slug))
    const hasFallback = (existingRows ?? []).some((r) => r.is_fallback)

    const toInsert = AGENT_TEMPLATES.filter((t) => !existing.has(t.slug)).map(
      (t) => ({
        account_id: accountId,
        created_by: userId,
        name: t.name,
        slug: t.slug,
        description: t.description,
        system_prompt: t.systemPrompt,
        is_active: true,
        // Only the template's fallback may claim the flag, and only when
        // the account doesn't already have one — otherwise the partial
        // unique index rejects the whole batch and nothing gets seeded.
        is_fallback: t.isFallback && !hasFallback,
        sort_order: t.sortOrder,
      }),
    )

    if (toInsert.length === 0) {
      return NextResponse.json({
        success: true,
        created: 0,
        skipped: AGENT_TEMPLATES.length,
      })
    }

    const { error: insertErr } = await supabase.from('ai_agents').insert(toInsert)
    if (insertErr) {
      console.error('[ai/agents/seed] insert error:', insertErr)
      return NextResponse.json(
        { error: 'Failed to install the starter agents' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      created: toInsert.length,
      skipped: AGENT_TEMPLATES.length - toInsert.length,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
