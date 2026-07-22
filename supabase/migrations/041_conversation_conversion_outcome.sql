-- ============================================================
-- 041 — Conversation conversion outcome (Fase 2: Conversión).
--
-- Advisors mark, from the chat, whether an escalated conversation ended in
-- a sale. 'won' = customer bought, 'lost' = escalated but didn't close /
-- went unanswered. NULL = not marked. The conversion panel derives the
-- other two states — "stayed in bot" vs "escalated (pending)" — from
-- escalated_at when the outcome is unset.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS conversion_outcome text;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_conversion_outcome_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_conversion_outcome_check
  CHECK (conversion_outcome IN ('won', 'lost'));

CREATE INDEX IF NOT EXISTS conversations_conversion_idx
  ON conversations (account_id, conversion_outcome);
