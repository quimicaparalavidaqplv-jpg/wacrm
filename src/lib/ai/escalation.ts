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
    // Claim the escalation: only the first one flips escalated_at from
    // NULL, so a thread that keeps hitting "confirmar_pedido" alerts once.
    const { data: claimed } = await db
      .from('conversations')
      .update({
        escalated_at: new Date().toISOString(),
        escalation_reason: reason,
      })
      .eq('id', conversationId)
      .is('escalated_at', null)
      .select('id')
      .maybeSingle()
    if (!claimed) return // already escalated — don't spam the team

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
      const appUrl = process.env.NEXT_PUBLIC_APP_URL
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
