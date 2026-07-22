import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import {
  sendTelegramMessage,
  supergroupChatIdVariant,
} from '@/lib/notify/telegram'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/telegram/config
 *
 * Returns whether Telegram alerts are set up + the chat id, but NEVER the
 * bot token (only a `has_token` flag). RLS restricts the row to admins,
 * so non-admins simply see `configured: false`.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('telegram_config')
      .select('chat_id, enabled, bot_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[telegram/config GET] error:', error)
      return NextResponse.json(
        { error: 'Failed to load Telegram configuration' },
        { status: 500 },
      )
    }
    if (!data) return NextResponse.json({ configured: false })
    return NextResponse.json({
      configured: true,
      has_token: !!data.bot_token,
      chat_id: data.chat_id,
      enabled: data.enabled,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/telegram/config  (admin+)
 *
 * Upsert the account's Telegram alert config. Validates the credentials
 * by sending a real test message to the chat before persisting (mirrors
 * the "verify before save" discipline of the WhatsApp/AI configs), then
 * stores the bot token AES-256-GCM-encrypted. When `bot_token` is omitted
 * the stored one is reused (the form sends it only when re-entered).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(
      `telegram-config:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const chatId = typeof body.chat_id === 'string' ? body.chat_id.trim() : ''
    if (!chatId) return bad('chat_id is required')

    const enabled = body.enabled !== false // default true
    const rawToken =
      typeof body.bot_token === 'string' ? body.bot_token.trim() : ''

    // Reuse the stored token when the form didn't send a fresh one.
    const { data: existing } = await supabase
      .from('telegram_config')
      .select('bot_token')
      .eq('account_id', accountId)
      .maybeSingle()

    let tokenPlain: string
    if (rawToken) {
      tokenPlain = rawToken
    } else if (existing?.bot_token) {
      try {
        tokenPlain = decrypt(existing.bot_token)
      } catch {
        return bad('Stored bot token could not be decrypted — re-enter it.')
      }
    } else {
      return bad('bot_token is required')
    }

    // Verify before save: send a real test message. Catches a wrong token,
    // a wrong chat id, or a bot that was never added to the group.
    const testText =
      '✅ <b>QPLV CRM</b> conectado a Telegram. Aquí llegarán las alertas de ventas.'
    let effectiveChatId = chatId
    let ok = await sendTelegramMessage({
      botToken: tokenPlain,
      chatId,
      text: testText,
    })
    // Common mistake: a supergroup id reported without its `-100` prefix.
    // Transparently retry with the corrected id and persist that one.
    if (!ok) {
      const alt = supergroupChatIdVariant(chatId)
      if (alt) {
        ok = await sendTelegramMessage({
          botToken: tokenPlain,
          chatId: alt,
          text: testText,
        })
        if (ok) effectiveChatId = alt
      }
    }
    if (!ok) {
      return bad(
        'No se pudo enviar el mensaje de prueba. Revisa el token, el chat id, y que el bot esté agregado al grupo.',
      )
    }

    const row = {
      account_id: accountId,
      bot_token: encrypt(tokenPlain),
      chat_id: effectiveChatId,
      enabled,
      updated_at: new Date().toISOString(),
    }
    const { error: upErr } = await supabase
      .from('telegram_config')
      .upsert(row, { onConflict: 'account_id' })
    if (upErr) {
      console.error('[telegram/config POST] upsert error:', upErr)
      return NextResponse.json(
        { error: 'Failed to save Telegram configuration' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/telegram/config  (admin+) — remove the integration.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('telegram_config')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[telegram/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete Telegram configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
