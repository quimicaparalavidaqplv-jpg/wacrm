import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text-bearing messages of a conversation and map them
 * to the provider-neutral chat shape. Customer messages become `user`;
 * agent and bot messages become `assistant`.
 *
 * Includes `text` messages and `audio` messages that carry a transcript
 * (voice notes transcribed at the webhook — see `transcribeInboundAudio`);
 * the trailing `content_text` filter drops audio rows that couldn't be
 * transcribed. Other non-text types (image, document, template,
 * interactive, location) are still excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 *
 * `resetAt` (`conversations.ai_context_reset_at`, migration 042) is the
 * bot's memory watermark: when set, only messages created strictly after
 * it are fed to the model. This is what "Reiniciar conversación" uses to
 * give the bot a clean slate on a thread whose history has gone stale —
 * the transcript itself is never touched, so the inbox keeps showing the
 * whole relationship to the humans working it.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
  resetAt?: string | null,
): Promise<ChatMessage[]> {
  let query = db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio'])

  if (resetAt) query = query.gt('created_at', resetAt)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}
