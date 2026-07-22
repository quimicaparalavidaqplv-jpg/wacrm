import { loadAiConfig } from './config'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Voice-note transcription.
//
// WhatsApp voice notes arrive as OGG/Opus audio with no text, so the
// AI auto-reply (which only reads text) silently ignored them. This
// transcribes an inbound audio to text with OpenAI's transcription API
// so the bot — and the human agent reading the thread — can act on it.
//
// Best-effort throughout: any failure (no OpenAI key, media download
// error, provider error) returns null and the caller stores the audio
// as before, untranscribed. Never throws into the webhook path.
// ============================================================

/** Model used for speech-to-text. `whisper-1` is broadly available on
 *  OpenAI keys and cheap (~$0.006/min); kept as a constant so it's easy
 *  to bump to a newer transcription model later. */
const TRANSCRIBE_MODEL = 'whisper-1'

/** Cap on how long we wait for the transcription before giving up — the
 *  webhook's `after()` block has a bounded budget (maxDuration=60). */
const TRANSCRIBE_TIMEOUT_MS = 25_000

/**
 * Transcribe raw audio bytes to text via OpenAI. Returns the trimmed
 * transcript, or null on any failure / empty result.
 */
export async function transcribeAudio(args: {
  apiKey: string
  audio: Buffer
  mimeType: string
  /** Hint OpenAI toward Spanish; improves accuracy for our use case. */
  language?: string
}): Promise<string | null> {
  const { apiKey, audio, mimeType, language = 'es' } = args

  // Pick a filename extension Whisper recognises from the MIME type —
  // WhatsApp voice notes are audio/ogg (opus). The extension matters:
  // OpenAI infers the format from the filename.
  const ext = mimeTypeToExt(mimeType)
  const form = new FormData()
  const blob = new Blob([new Uint8Array(audio)], { type: mimeType || 'audio/ogg' })
  form.append('file', blob, `voice-note.${ext}`)
  form.append('model', TRANSCRIBE_MODEL)
  if (language) form.append('language', language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(
        `[transcribe] OpenAI rejected the request (${res.status}): ${detail.slice(0, 200)}`,
      )
      return null
    }
    const data = (await res.json()) as { text?: string }
    const text = data.text?.trim()
    return text && text.length > 0 ? text : null
  } catch (err) {
    console.error('[transcribe] request failed:', err)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Orchestrate transcription for one inbound WhatsApp voice note:
 * resolve an OpenAI key from the account's AI config, download the audio
 * bytes from Meta, and transcribe. Returns null (never throws) when
 * anything is missing or fails, so the webhook falls back to storing the
 * audio untranscribed.
 *
 * The key: transcription is OpenAI-only, so we use the chat `api_key`
 * when the provider is OpenAI, otherwise fall back to the (optional)
 * OpenAI `embeddings_api_key`. `requireActive: false` means we still
 * transcribe for the human agent even when the assistant's master switch
 * is off.
 */
export async function transcribeInboundAudio(args: {
  db: SupabaseClient
  accountId: string
  mediaId: string
  mimeType: string
  accessToken: string
}): Promise<string | null> {
  const { db, accountId, mediaId, mimeType, accessToken } = args

  let openaiKey: string | null = null
  try {
    const config = await loadAiConfig(db, accountId, { requireActive: false })
    if (config) {
      openaiKey =
        config.provider === 'openai' ? config.apiKey : config.embeddingsApiKey
    }
  } catch (err) {
    console.error('[transcribe] could not load AI config:', err)
    return null
  }
  if (!openaiKey) return null // no OpenAI key available → skip silently

  let audio: Buffer
  try {
    const { url } = await getMediaUrl({ mediaId, accessToken })
    const { buffer } = await downloadMedia({ downloadUrl: url, accessToken })
    audio = buffer
  } catch (err) {
    console.error('[transcribe] media download failed:', err)
    return null
  }

  return transcribeAudio({ apiKey: openaiKey, audio, mimeType })
}

function mimeTypeToExt(mimeType: string): string {
  const m = (mimeType || '').toLowerCase()
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a'
  if (m.includes('wav')) return 'wav'
  if (m.includes('webm')) return 'webm'
  return 'ogg' // WhatsApp voice notes default to OGG/Opus
}
