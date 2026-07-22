import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/conversations/conversion?range=30d
 *
 * Conversion funnel counts over a date range (by conversation created_at):
 *   - won        : advisor marked the sale closed
 *   - lost       : advisor marked it lost / unanswered
 *   - escalated  : escalated to sales, not yet resolved (outcome unset)
 *   - bot        : handled by the bot, never escalated, no outcome
 *
 * range ∈ 7d | 30d | 90d | all (default 30d). Any account member may read.
 */
const RANGE_DAYS: Record<string, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const rangeParam = new URL(request.url).searchParams.get('range') ?? '30d'
    const days = rangeParam in RANGE_DAYS ? RANGE_DAYS[rangeParam] : 30
    const sinceIso =
      days == null
        ? null
        : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    // Base builder for a head count over the range.
    const base = () => {
      let q = supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
      if (sinceIso) q = q.gte('created_at', sinceIso)
      return q
    }

    const [wonRes, lostRes, escalatedRes, botRes] = await Promise.all([
      base().eq('conversion_outcome', 'won'),
      base().eq('conversion_outcome', 'lost'),
      base().is('conversion_outcome', null).not('escalated_at', 'is', null),
      base().is('conversion_outcome', null).is('escalated_at', null),
    ])

    const won = wonRes.count ?? 0
    const lost = lostRes.count ?? 0
    const escalated = escalatedRes.count ?? 0
    const bot = botRes.count ?? 0
    const totalEscalated = won + lost + escalated
    // Conversion rate = closed sales among everything that reached sales.
    const conversionRate =
      totalEscalated > 0 ? Math.round((won / totalEscalated) * 100) : 0

    return NextResponse.json({
      range: rangeParam in RANGE_DAYS ? rangeParam : '30d',
      counts: { won, lost, escalated, bot, total: won + lost + escalated + bot },
      totalEscalated,
      conversionRate,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
