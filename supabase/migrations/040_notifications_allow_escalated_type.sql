-- ============================================================
-- 040 — Allow the 'conversation_escalated' notification type.
--
-- The notifications.type CHECK (from the notifications feature) only
-- permitted 'conversation_assigned'. Migration 039 added sales escalation,
-- whose in-app alert inserts type='conversation_escalated' — which the old
-- CHECK rejected, so the notification silently failed to insert. Widen the
-- constraint to cover both types.
-- ============================================================

DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'notifications'::regclass AND contype = 'c';
  IF cname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE notifications DROP CONSTRAINT ' || quote_ident(cname);
  END IF;
END $$;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'conversation_escalated'));
