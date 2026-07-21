import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { loadActiveAgents } from '@/lib/ai/agents'
import { routeToAgent } from '@/lib/ai/router'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    // Route exactly as the live bot does, so the sandbox answers the
    // question that actually matters: *which* agent picks this message
    // up, and what does it then say. The agent + reason travel back to
    // the client so a misrouted message is diagnosable — you can see the
    // wrong specialist was chosen rather than guessing why the wording
    // is off.
    //
    // Uses the RLS-scoped SSR client: an admin testing the sandbox can
    // only ever route to their own account's agents.
    const agents = await loadActiveAgents(supabase, accountId)
    const route = await routeToAgent({
      config,
      agents,
      messages,
      // The sandbox is stateless — every run re-routes from scratch, so
      // testing a given message is reproducible instead of depending on
      // whatever the previous turn happened to pick.
      stickyAgentId: null,
    })

    // Mirrors the live rule in `dispatchInboundToAiReply`: with agents
    // configured but none selectable, the bot hands off rather than
    // answering with the generic persona. Surfacing that here is the
    // point — it's exactly the misconfiguration the sandbox should
    // expose before a customer hits it.
    if (agents.length > 0 && !route.agent) {
      return NextResponse.json({
        reply: '',
        handoff: true,
        agent: null,
        routing: route.reason,
        notice:
          'Ningún agente pudo atender este mensaje. En producción se escalaría a un humano. Marca un agente como predeterminado para cubrir estos casos.',
      })
    }

    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages),
    )
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      agentPrompt: route.agent?.systemPrompt ?? null,
    })

    const { text, handoff } = await generateReply({ config, systemPrompt, messages })
    return NextResponse.json({
      reply: text,
      handoff,
      agent: route.agent
        ? { id: route.agent.id, name: route.agent.name, slug: route.agent.slug }
        : null,
      routing: route.reason,
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
