import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
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
// configured) a Telegram group gets pinged with a summary of the chat and
// a direct WhatsApp link so the advisor can reply in one tap.
//
// Best-effort and self-contained: never throws into the auto-reply path.
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

/** How many recent turns to include as the conversation summary. */
const SUMMARY_TURNS = 8

export async function escalateConversation(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  reason: EscalationReason
  /** Recent turns (oldest-first) used to build the summary for the alert. */
  messages?: ChatMessage[]
  /** Fallback single line when `messages` isn't available. */
  lastCustomerMessage?: string | null
}): Promise<void> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    reason,
    messages,
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

    // Who is it? Name for the alert + phone for the WhatsApp deep link.
    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const who = contact?.name || contact?.phone || 'Un cliente'
    const phone = contact?.phone ?? null

    // Conversation summary: a short transcript of the recent turns so the
    // advisor knows what was already discussed with the bot.
    const summary =
      messages && messages.length > 0
        ? buildTranscript(messages)
        : (lastCustomerMessage ?? '').trim()

    // Sales-queue members (for in-app notifications).
    const { data: members } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', SALES_QUEUE_ROLES as unknown as string[])
    const memberIds = (members ?? []).map(
      (m: { user_id: string }) => m.user_id,
    )

    // 1. In-app notification: the escalation itself.
    if (memberIds.length > 0) {
      const body = summary ? `${who}\n${summary}`.slice(0, 600) : who
      const rows = memberIds.map((uid) => ({
        account_id: accountId,
        user_id: uid,
        type: 'conversation_escalated',
        conversation_id: conversationId,
        contact_id: contactId,
        title: label,
        body,
      }))
      const { error } = await db.from('notifications').insert(rows)
      if (error) console.error('[escalation] in-app insert failed:', error)
    }

    // 2. Telegram alert (optional). On failure, surface it in-app too so
    //    the team isn't left thinking the ping went out.
    const tg = await loadTelegramConfig(db, accountId)
    if (tg) {
      const wa = phone ? waLink(phone) : null
      const text =
        `<b>${escapeTelegramHtml(label)}</b>\n` +
        `👤 ${escapeTelegramHtml(who)}\n` +
        (summary
          ? `\n<b>Resumen de la conversación:</b>\n${escapeTelegramHtml(summary)}\n`
          : '') +
        (wa
          ? `\n💬 <a href="${wa}">Responder por WhatsApp</a>`
          : '')
      const sent = await sendTelegramMessage({
        botToken: tg.botToken,
        chatId: tg.chatId,
        text,
      })
      if (!sent && memberIds.length > 0) {
        const failRows = memberIds.map((uid) => ({
          account_id: accountId,
          user_id: uid,
          type: 'conversation_escalated',
          conversation_id: conversationId,
          contact_id: contactId,
          title: '⚠️ No se pudo enviar la alerta a Telegram',
          body: `Revisa Ajustes → Telegram. Cliente: ${who}`,
        }))
        const { error } = await db.from('notifications').insert(failRows)
        if (error)
          console.error('[escalation] telegram-fail insert failed:', error)
      }
    }
  } catch (err) {
    console.error('[escalation] failed:', err)
  }
}

/** Build a short "🧑 Cliente / 🤖 Bot" transcript of the recent turns. */
function buildTranscript(
  messages: ChatMessage[],
  maxTurns = SUMMARY_TURNS,
): string {
  return messages
    .slice(-maxTurns)
    .map((m) => {
      const who = m.role === 'user' ? '🧑 Cliente' : '🤖 Bot';
      const text = m.content.replace(/\s+/g, ' ').trim().slice(0, 220);
      return `${who}: ${text}`;
    })
    .join('\n')
}

/** Build a wa.me deep link from a stored phone (strips non-digits). */
function waLink(phone: string): string | null {
  const digits = phone.replace(/\D/g, '')
  return digits ? `https://wa.me/${digits}` : null
}
