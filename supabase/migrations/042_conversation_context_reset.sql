-- ============================================================
-- 042_conversation_context_reset.sql — per-conversation AI memory reset
--
-- A conversation thread in this CRM is eternal: `resolveConversation`
-- matches an inbound by phone and reopens the SAME row forever, so a
-- customer who returns months later lands in the thread they left. That
-- is right for the humans — the inbox should show the whole relationship
-- — but wrong for the bot, which then reads stale turns as if they were
-- the current exchange and stays glued to whichever specialist last
-- handled the thread (`ai_active_agent_id`).
--
-- The operator needs a way to say "forget what came before and start
-- fresh with this customer" WITHOUT destroying the transcript the sales
-- team relies on. Deleting messages would do it, but it throws away the
-- history a human needs to pick the conversation up.
--
-- Design notes
--   - `ai_context_reset_at` is a watermark, not a delete. Only the AI
--     context builder honours it (`buildConversationContext` filters to
--     messages created strictly after it); the inbox, the conversion
--     module and every export keep reading the full thread.
--   - NULL means "never reset" — the pre-existing behaviour, so every
--     current row keeps working untouched.
--   - Clearing the bot's memory without also releasing `ai_active_agent_id`
--     would be a half-reset: the router's stickiness rule would keep the
--     thread pinned to the old specialist even with an empty transcript.
--     The reset endpoint clears both; this column only stores the mark.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_context_reset_at timestamptz;

COMMENT ON COLUMN conversations.ai_context_reset_at IS
  'Watermark for the AI auto-reply memory. When set, buildConversationContext '
  'only feeds the model messages created after this instant. NULL = no reset. '
  'Never affects what humans see in the inbox — the transcript stays intact.';

-- The context builder filters by (conversation_id, created_at) already;
-- this column is read from the conversations row itself, so no extra
-- index is needed here.
