import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

// ============================================================
// Telegram notifications.
//
// A lightweight outbound channel so an advisor sees a hot lead on their
// phone even without the CRM open. One bot per account posts to a sales
// group; config lives in `telegram_config` (migration 039), bot token
// stored encrypted.
//
// Best-effort everywhere: a missing / disabled config or a Telegram API
// error returns false and is logged, never thrown — an alert failing must
// not break the customer-facing reply path.
// ============================================================

const TELEGRAM_TIMEOUT_MS = 10_000

interface TelegramConfig {
  botToken: string
  chatId: string
}

/** Load + decrypt the account's Telegram config, or null when unset /
 *  disabled / undecryptable. */
export async function loadTelegramConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<TelegramConfig | null> {
  const { data, error } = await db
    .from('telegram_config')
    .select('bot_token, chat_id, enabled')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data || !data.enabled) return null
  try {
    return { botToken: decrypt(data.bot_token), chatId: data.chat_id }
  } catch {
    console.error(
      `[telegram] bot token for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return null
  }
}

/**
 * Send a message to a Telegram chat via the Bot API. Returns true on a
 * 2xx from Telegram, false on any failure. `text` may use a small subset
 * of HTML (<b>, <i>, <a>) since we send parse_mode=HTML.
 */
export async function sendTelegramMessage(args: {
  botToken: string
  chatId: string
  text: string
}): Promise<boolean> {
  const { botToken, chatId, text } = args
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS)
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(
        `[telegram] sendMessage failed (${res.status}): ${detail.slice(0, 200)}`,
      )
      return false
    }
    return true
  } catch (err) {
    console.error('[telegram] request failed:', err)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Escape a string for safe inclusion in a Telegram HTML message. */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
