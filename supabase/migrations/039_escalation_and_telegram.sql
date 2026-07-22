-- ============================================================
-- 039 — Sales escalation + Telegram notifications.
--
-- When the bot detects a hot lead (customer wants to buy, or asks for a
-- human), we now escalate: mark the conversation, alert the sales queue
-- in-app, and (optionally) ping a Telegram group so an advisor sees it on
-- their phone even without the app open.
--
-- This migration adds:
--   1. escalation state on `conversations` (when + why it escalated), so
--      the inbox can surface a "pending / waiting for an advisor" view and
--      the upcoming conversion module can measure bot-vs-sales outcomes.
--   2. `telegram_config` — per-account bot token (encrypted) + chat id.
-- ============================================================

-- 1. Escalation state. `escalated_at` NULL = never escalated; set once on
--    the first escalation so re-classification on later messages doesn't
--    re-alert. `escalation_reason` is a short slug ('compra',
--    'soporte_humano', 'handoff') for the pending view + reporting.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS escalated_at     timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_reason text;

-- Partial index: the "pending escalations" view scans only escalated rows.
CREATE INDEX IF NOT EXISTS conversations_escalated_idx
  ON conversations (account_id, escalated_at)
  WHERE escalated_at IS NOT NULL;

-- 2. Telegram config, one row per account. `bot_token` is stored
--    AES-256-GCM encrypted (same scheme as whatsapp_config.access_token);
--    `chat_id` is the target group/chat id (not secret).
CREATE TABLE IF NOT EXISTS telegram_config (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  bot_token  text        NOT NULL,
  chat_id    text        NOT NULL,
  enabled    boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_config ENABLE ROW LEVEL SECURITY;

-- Admins/owners manage the integration from Settings. The webhook reads it
-- with the service role, which bypasses RLS — so no SELECT policy for the
-- bot path is needed here.
DROP POLICY IF EXISTS telegram_config_admin_all ON telegram_config;
CREATE POLICY telegram_config_admin_all ON telegram_config
  FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
