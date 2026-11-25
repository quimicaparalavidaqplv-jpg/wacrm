import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadActiveAgents: vi.fn(),
  escalateConversation: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    /** Successive answers for the burst guard's `latestInboundAt` reads.
     *  One entry → every read sees the same newest inbound (the normal
     *  case). Two → a newer message landed mid-generation. */
    inboundAts: [] as string[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
// Only the roster lookup is stubbed — `routeToAgent` runs for real, so
// these tests exercise the actual routing integration rather than a
// mock of it. Default is `[]`: the single-persona behaviour every test
// written before migration 037 assumes.
//
// Partial mock via `importOriginal`: the router imports `agentBySlug`
// and `fallbackAgent` from this same module, and replacing it wholesale
// would strip them.
vi.mock('./agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agents')>()),
  loadActiveAgents: h.loadActiveAgents,
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
// Escalation is its own unit (see escalation.ts) and talks to Telegram +
// the notifications table. Stubbing it keeps these tests focused on the
// dispatch decision, and stops its own `conversations` UPDATE from
// clobbering the handoff payload these tests assert on.
vi.mock('./escalation', () => ({ escalateConversation: h.escalateConversation }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        // Burst guard: .select().eq().eq().order().limit().maybeSingle()
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => {
            // Keep the last entry once the queue is down to one, so a
            // single-value setup answers every read identically.
            const at =
              h.state.inboundAts.length > 1
                ? h.state.inboundAts.shift()
                : h.state.inboundAts[0]
            return Promise.resolve({
              data: at ? { created_at: at } : null,
              error: null,
            })
          },
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    ai_active_agent_id: null,
    ai_context_reset_at: null,
  }
  // Single entry → the newest inbound never changes mid-run, so the
  // burst guard is a no-op unless a test says otherwise.
  h.state.inboundAts = ['2026-08-27T10:44:12.000Z']
  h.state.autoResponders = []
  h.escalateConversation.mockReset()
  h.loadActiveAgents.mockResolvedValue([])
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

// ============================================================
// Specialised agents (migration 037). `loadActiveAgents` is stubbed but
// the router itself is real, so these cover the wiring end to end: the
// classifier's answer selecting a persona, that persona's prompt
// reaching the model, and the choice being remembered on the thread.
// ============================================================
describe('dispatchInboundToAiReply — agent routing', () => {
  const VENTAS = {
    id: 'ag-ventas',
    name: 'Ventas al Mayor',
    slug: 'ventas_mayor',
    description: 'compras por volumen',
    systemPrompt: 'Eres la asesora mayorista.',
    isActive: true,
    isFallback: false,
    sortOrder: 0,
  }
  const ORQ = {
    id: 'ag-orq',
    name: 'Orquestador',
    slug: 'orquestador',
    description: 'mensajes ambiguos',
    systemPrompt: 'Eres el orquestador.',
    isActive: true,
    isFallback: true,
    sortOrder: 1,
  }

  it("injects the routed agent's prompt and remembers the choice", async () => {
    h.loadActiveAgents.mockResolvedValue([VENTAS, ORQ])
    h.generateReply
      .mockResolvedValueOnce({ text: 'ventas_mayor', handoff: false }) // router
      .mockResolvedValueOnce({ text: '¡Claro!', handoff: false }) // reply

    await dispatchInboundToAiReply(ARGS)

    const replyPrompt = h.generateReply.mock.calls[1][0].systemPrompt as string
    expect(replyPrompt).toContain('Eres la asesora mayorista.')
    expect(replyPrompt).not.toContain('Eres el orquestador.')
    expect(h.state.updatePayload).toMatchObject({
      ai_active_agent_id: 'ag-ventas',
    })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: '¡Claro!' }),
    )
  })

  it('skips the classification call when only one agent is active', async () => {
    h.loadActiveAgents.mockResolvedValue([VENTAS])
    h.generateReply.mockResolvedValue({ text: 'Hola', handoff: false })

    await dispatchInboundToAiReply(ARGS)

    // One call total: the reply. No tokens burned on routing.
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.generateReply.mock.calls[0][0].systemPrompt).toContain(
      'Eres la asesora mayorista.',
    )
  })

  it('does not rewrite the sticky agent when routing lands on the same one', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_active_agent_id: 'ag-ventas',
    }
    h.loadActiveAgents.mockResolvedValue([VENTAS, ORQ])
    h.generateReply
      .mockResolvedValueOnce({ text: 'ventas_mayor', handoff: false })
      .mockResolvedValueOnce({ text: 'Sigo yo', handoff: false })

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.updatePayload).toBeNull()
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it.each([
    ['distribuidor', 'compra'],
    ['soporte_humano', 'soporte_humano'],
    ['confirmar_pedido', 'compra'],
    ['informacion_general', null],
  ])('sends the reply and applies the sales alert policy for %s', async (slug, reason) => {
    h.loadActiveAgents.mockResolvedValue([{ ...VENTAS, slug }])
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    if (reason) {
      expect(h.escalateConversation).toHaveBeenCalledWith(expect.objectContaining({ reason }))
    } else {
      expect(h.escalateConversation).not.toHaveBeenCalled()
    }
  })

  it('answers a classified out-of-catalog inquiry without pausing or alerting sales', async () => {
    h.loadActiveAgents.mockResolvedValue([ORQ, { ...VENTAS, slug: 'informacion_general' }])
    h.generateReply.mockResolvedValueOnce({ text: 'fuera_catalogo', handoff: false })
    await dispatchInboundToAiReply({ ...ARGS, accountId: '37cd19c8-7806-4aaf-b7f5-f544899485ab' })
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('productos de limpieza al mayor'),
    }))
    expect(h.escalateConversation).not.toHaveBeenCalled()
    expect(h.state.updatePayload).not.toHaveProperty('ai_autoreply_disabled')
  })

  it('hands off rather than answering when no agent can be routed to', async () => {
    // Agents configured but none marked fallback, and the classifier
    // returns something unrecognisable → nothing legitimate to say.
    h.loadActiveAgents.mockResolvedValue([
      VENTAS,
      { ...ORQ, isFallback: false },
    ])
    h.generateReply
      .mockResolvedValueOnce({ text: 'no sé', handoff: false })
      .mockResolvedValueOnce({ text: 'una respuesta', handoff: false })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    })
  })
})

describe('dispatchInboundToAiReply — burst guard', () => {
  it('replies when its inbound is still the newest', async () => {
    h.state.inboundAts = ['2026-08-27T10:44:12.000Z']
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('stands down when a newer inbound lands mid-generation', async () => {
    // Meta delivers one webhook per message: this run started on the
    // 10:44:12 message, and 10:44:16 arrived while the model was still
    // generating. The later run answers instead — with both messages in
    // context — so this one must not send a second, near-identical reply.
    h.state.inboundAts = ['2026-08-27T10:44:12.000Z', '2026-08-27T10:44:16.000Z']
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not burn a reply-cap slot when it stands down', async () => {
    h.state.inboundAts = ['2026-08-27T10:44:12.000Z', '2026-08-27T10:44:16.000Z']
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('does not hand off on a partial message when superseded', async () => {
    // Without the guard, a customer splitting one thought across two
    // messages could get a handoff decided on the first half alone.
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    h.state.inboundAts = ['2026-08-27T10:44:12.000Z', '2026-08-27T10:44:16.000Z']
    await dispatchInboundToAiReply(ARGS)
    expect(h.escalateConversation).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })
})

describe('dispatchInboundToAiReply — memory watermark', () => {
  it('passes no watermark when the thread was never reset', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.buildConversationContext).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      undefined,
      null,
    )
  })

  it('passes ai_context_reset_at so the bot forgets earlier turns', async () => {
    const resetAt = '2026-08-27T18:00:00.000Z'
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_active_agent_id: null,
      ai_context_reset_at: resetAt,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.buildConversationContext).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      undefined,
      resetAt,
    )
  })
})
