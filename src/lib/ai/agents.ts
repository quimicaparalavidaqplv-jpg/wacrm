import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Specialised agent roster (migration 037).
//
// `ai_configs` owns the credentials and the master switch; this module
// owns the personas. One account has many agents — an order-taker, a
// wholesale rep, a distributor screener — and the router (see
// `router.ts`) picks which one answers each inbound.
// ============================================================

/** One persona, as the engine uses it. */
export interface AiAgent {
  id: string
  name: string
  /** Stable key the router classifies into, e.g. `ventas_mayor`. */
  slug: string
  /** One line telling the router when to pick this agent. */
  description: string
  /** The persona: role, tone, rules, closing techniques. */
  systemPrompt: string
  isActive: boolean
  /** The agent the router falls back to when it can't classify. */
  isFallback: boolean
  sortOrder: number
}

interface AgentRow {
  id: string
  name: string
  slug: string
  description: string | null
  system_prompt: string | null
  is_active: boolean
  is_fallback: boolean
  sort_order: number
}

const AGENT_COLUMNS =
  'id, name, slug, description, system_prompt, is_active, is_fallback, sort_order'

function mapAgent(row: AgentRow): AiAgent {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? '',
    systemPrompt: row.system_prompt ?? '',
    isActive: row.is_active,
    isFallback: row.is_fallback,
    sortOrder: row.sort_order,
  }
}

/**
 * Load the account's **active** agents, in display order.
 *
 * Inactive agents are filtered out here rather than at the call sites —
 * "switched off" must mean the router can never select it, and doing
 * that in one place removes the chance of a caller forgetting.
 *
 * Returns `[]` when the account hasn't set any up; callers then fall
 * back to the single-persona behaviour from migration 029, so an
 * account that never opens this feature keeps working unchanged.
 */
export async function loadActiveAgents(
  db: SupabaseClient,
  accountId: string,
): Promise<AiAgent[]> {
  const { data, error } = await db
    .from('ai_agents')
    .select(AGENT_COLUMNS)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  if (error) throw error
  return ((data ?? []) as AgentRow[]).map(mapAgent)
}

/**
 * Load every agent (active or not) for the management UI. Separate from
 * `loadActiveAgents` so the engine can't accidentally get an inactive
 * one just by reusing the convenient helper.
 */
export async function loadAllAgents(
  db: SupabaseClient,
  accountId: string,
): Promise<AiAgent[]> {
  const { data, error } = await db
    .from('ai_agents')
    .select(AGENT_COLUMNS)
    .eq('account_id', accountId)
    .order('sort_order', { ascending: true })

  if (error) throw error
  return ((data ?? []) as AgentRow[]).map(mapAgent)
}

/** The agent the router falls back to, or null when none is marked. */
export function fallbackAgent(agents: AiAgent[]): AiAgent | null {
  return agents.find((a) => a.isFallback) ?? null
}

/** Find an agent by the slug the classifier returned. */
export function agentBySlug(agents: AiAgent[], slug: string): AiAgent | null {
  const wanted = slug.trim().toLowerCase()
  return agents.find((a) => a.slug === wanted) ?? null
}
