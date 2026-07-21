-- ============================================================
-- 037_ai_multi_agent.sql — specialised AI agents + intent routing
--
-- Migration 029 gave every account a single `ai_configs.system_prompt`:
-- one persona answering everything. Real sales operations split the job
-- across specialists — an order-taker, a wholesale rep, a distributor
-- screener, a human-handoff desk — each with its own tone, rules and
-- closing techniques. This migration models that.
--
-- Design notes
--   - `ai_agents` is account-scoped, many-per-account. Each row is one
--     persona: a `name` the operator recognises, a `slug` the router
--     classifies into, and the `system_prompt` that drives it.
--   - `ai_configs` keeps owning the credentials + master switch. An
--     agent NEVER carries an API key — provider/model/key stay central
--     so rotating the key is still one edit. `ai_configs.system_prompt`
--     survives as the shared preamble prepended to every agent (brand
--     voice, company facts), so upgrading an existing account loses
--     nothing.
--   - `is_active` per agent is the on/off switch the operator asked
--     for. An inactive agent is invisible to the router — it can't be
--     selected, but its prompt is preserved for later.
--   - `is_fallback` marks the agent the router falls back to when it
--     can't classify confidently (the "orchestrator"). Exactly one per
--     account, enforced by a partial unique index. Without a fallback
--     the router hands off to a human — a safe default, never a crash.
--   - `sort_order` drives display order in the UI only.
--
--   - `conversations.ai_active_agent_id` — agent stickiness. Once a
--     thread is being handled by the wholesale rep, the next inbound
--     stays with them unless the router decides the intent genuinely
--     changed. Cuts classification cost and stops the customer being
--     bounced between personas mid-negotiation. ON DELETE SET NULL so
--     deleting an agent just re-opens routing for its threads.
--
--   - `ai_usage_log.agent_id` + two new `mode` values ('router',
--     'evaluation') so per-agent spend is attributable and the
--     classifier's own token cost is visible rather than hidden.
--
-- RLS
--   Settings-class, mirroring `ai_configs`: any member (viewer+) may
--   read the roster — the inbox shows which agent answered — but only
--   admin+ may create / update / delete. The router and auto-reply
--   engine run under the service-role client (a webhook has no
--   `auth.uid()`), so RLS guards dashboard access, not the engine.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_agents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Operator-facing label, e.g. "Ventas al Mayor".
  name           text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  -- Stable machine key the router classifies into, e.g. "ventas_mayor".
  -- Unique per account so the classifier's answer maps to exactly one row.
  slug           text NOT NULL CHECK (slug ~ '^[a-z0-9_]{1,40}$'),
  -- One line telling the ROUTER when to pick this agent. This is the
  -- text the classifier sees — not the full prompt (too long, and full
  -- of answer-shaping detail the router doesn't need).
  description    text NOT NULL DEFAULT '',
  -- The persona itself: role, tone, rules, closing techniques.
  system_prompt  text NOT NULL DEFAULT '',
  is_active      boolean NOT NULL DEFAULT true,
  is_fallback    boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, slug)
);

-- At most one fallback agent per account. Partial index so the many
-- `false` rows don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agents_one_fallback
  ON ai_agents(account_id)
  WHERE is_fallback;

-- The router's hot path: active agents for one account, in display order.
CREATE INDEX IF NOT EXISTS idx_ai_agents_account_active
  ON ai_agents(account_id, is_active, sort_order);

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agents_select ON ai_agents;
CREATE POLICY ai_agents_select ON ai_agents FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_agents_insert ON ai_agents;
CREATE POLICY ai_agents_insert ON ai_agents FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agents_update ON ai_agents;
CREATE POLICY ai_agents_update ON ai_agents FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agents_delete ON ai_agents;
CREATE POLICY ai_agents_delete ON ai_agents FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- `SET search_path` is pinned (unlike the older `update_*_updated_at`
-- functions in this repo): without it the resolution of `now()` follows
-- the caller's search_path, which the Supabase linter flags as a
-- privilege-escalation vector on SECURITY DEFINER-adjacent code.
CREATE OR REPLACE FUNCTION public.update_ai_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS ai_agents_updated_at ON ai_agents;
CREATE TRIGGER ai_agents_updated_at
  BEFORE UPDATE ON ai_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_agents_updated_at();

-- ============================================================
-- Agent stickiness per conversation.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_active_agent_id uuid
    REFERENCES ai_agents(id) ON DELETE SET NULL;

-- ============================================================
-- Per-agent spend attribution + the classifier's own cost.
-- ============================================================
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL;

-- Widen `mode` to cover the two new LLM surfaces this feature adds:
--   'router'     — the intent classifier picking an agent
--   'evaluation' — the quality reviewer scoring past conversations
-- Dropping and recreating the CHECK is the only way to widen it; the
-- DROP is IF EXISTS so re-running the file is safe.
ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'router', 'evaluation'));
