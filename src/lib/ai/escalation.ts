import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadTelegramConfig,
  sendTelegramMessage,
  escapeTelegramHtml,
} from '@/lib/notify/telegram'

// ============================================================
// Sales escalation.
//
// When the bot decides a conversation needs a human — the customer wants
// to buy ('compra'), asked for an advisor ('soporte_humano'), or the bot
// couldn't resolve it ('handoff') — we alert the sales queue so nobody
// slips through: the whole team gets an in-app notification, and (when
// configured) a Telegram group gets pinged.
//
// Marks the conversation exactly once (first escalation wins) so
// re-classification on later inbounds doesn't re-alert. Best-effort and
// self-contained: never throws into the auto-reply path.
// ============================================================

export type EscalationReason = 'compra' | 'soporte_humano' | 'handoff'

const REASON_LABEL: Record<EscalationReason, string> = {
  compra: '🔥 Cliente quiere comprar',
  soporte_humano: '🙋 Cliente pide un asesor',
  handoff: '⚠️ El bot no pudo resolver — requiere atención',
}

/** Roles that make up the "sales queue" — everyone who can pick up a
 *  chat. Viewers are read-only, so they're excluded. */
const SALES_QUEUE_ROLES = ['owner', 'admin', 'agent'] as const

/**
 * Re-alert throttle. A conversation that escalated within this window
 * won't alert again, so a chat that keeps hitting "confirmar_pedido"
 * doesn't spam the team. Past the window (the customer is still waiting,
 * or escalates afresh later) it re-alerts — a useful nudge. */
const RE_ALERT_AFTER_MS = 15 * 60 * 1000

export async function escalateConversation(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  reason: EscalationReason
  lastCustomerMessage?: string | null
}): Promise<void> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    reason,
    lastCustomerMessage,
  } = args

  try {
    // Claim the escalation. Fires when the thread never escalated OR its
    // last escalation is older than the re-alert window, so repeated
    // classifications in a short burst alert once, but a customer left
    // waiting (or escalating again later) re-alerts. The conditional
    // UPDATE is the concurrency guard — two inbounds racing can't both win.
    const cutoffIso = new Date(Date.now() - RE_ALERT_AFTER_MS).toISOString()
    const { data: claimed } = await db
      .from('conversations')
      .update({
        escalated_at: new Date().toISOString(),
        escalation_reason: reason,
      })
      .eq('id', conversationId)
      .or(`escalated_at.is.null,escalated_at.lt.${cutoffIso}`)
      .select('id')
      .maybeSingle()
    if (!claimed) return // escalated too recently — don't spam the team

    const label = REASON_LABEL[reason]

    // Who is it? Best-effort name for the alert.
    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const who = contact?.name || contact?.phone || 'Un cliente'
    const snippet = (lastCustomerMessage ?? '').trim()

    // 1. In-app notification for every member of the sales queue.
    const { data: members } = await db
      .from('profiles')
      .select('user_id, account_role')
      .eq('account_id', accountId)
      .in('account_role', SALES_QUEUE_ROLES as unknown as string[])
    if (members && members.length > 0) {
      const rows = members.map((m: { user_id: string }) => ({
        account_id: accountId,
        user_id: m.user_id,
        type: 'conversation_escalated',
        conversation_id: conversationId,
        contact_id: contactId,
        title: label,
        body: snippet ? `${who}: ${snippet.slice(0, 140)}` : who,
      }))
      const { error: notifErr } = await db.from('notifications').insert(rows)
      if (notifErr) console.error('[escalation] in-app insert failed:', notifErr)
    }

    // 2. Telegram alert (optional — no-op when unconfigured).
    const tg = await loadTelegramConfig(db, accountId)
    if (tg) {
      // Deep link into the inbox. Falls back to the current Vercel domain
      // so the link works without a NEXT_PUBLIC_APP_URL env var set; update
      // the fallback when a custom domain is added.
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL || 'https://wacrm-kappa-ruby.vercel.app'
      const text =
        `<b>${escapeTelegramHtml(label)}</b>\n` +
        `👤 ${escapeTelegramHtml(who)}\n` +
        (snippet ? `💬 ${escapeTelegramHtml(snippet.slice(0, 300))}\n` : '') +
        (appUrl ? `\n👉 <a href="${appUrl}/inbox">Abrir la bandeja</a>` : '')
      await sendTelegramMessage({
        botToken: tg.botToken,
        chatId: tg.chatId,
        text,
      })
    }
  } catch (err) {
    console.error('[escalation] failed:', err)
  }
}
