import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { matchSlug, buildRouterPrompt, routeToAgent } from './router'
import type { AiAgent } from './agents'
import type { AiConfig } from './types'

vi.mock('./generate', () => ({ generateReply: vi.fn() }))
import { generateReply } from './generate'

const mockedGenerate = vi.mocked(generateReply)

function agent(overrides: Partial<AiAgent> & { slug: string }): AiAgent {
  return {
    id: `id-${overrides.slug}`,
    name: overrides.slug,
    description: '',
    systemPrompt: '',
    isActive: true,
    isFallback: false,
    sortOrder: 0,
    ...overrides,
  }
}

const VENTAS = agent({ slug: 'ventas_mayor' })
const PEDIDO = agent({ slug: 'confirmar_pedido' })
const ORQ = agent({ slug: 'orquestador', isFallback: true })
const ROSTER = [VENTAS, PEDIDO, ORQ]

const CONFIG: AiConfig = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  apiKey: 'sk-test',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsApiKey: null,
}

describe('matchSlug', () => {
  it('matches a bare slug', () => {
    expect(matchSlug(ROSTER, 'ventas_mayor')?.slug).toBe('ventas_mayor')
  })

  it('is tolerant of casing and trailing punctuation', () => {
    expect(matchSlug(ROSTER, ' Ventas_Mayor. ')?.slug).toBe('ventas_mayor')
  })

  it('digs the slug out of a wrapped answer', () => {
    expect(matchSlug(ROSTER, 'El agente es: confirmar_pedido.')?.slug).toBe(
      'confirmar_pedido',
    )
  })

  it('returns null when no known slug appears', () => {
    expect(matchSlug(ROSTER, 'no tengo idea')).toBeNull()
  })

  it('does not match a slug embedded in a larger token', () => {
    // Underscores are word characters, so a naive \b would match here.
    expect(matchSlug(ROSTER, 'xventas_mayory')).toBeNull()
  })

  it('prefers the longest slug when one is a prefix of another', () => {
    const roster = [agent({ slug: 'ventas' }), VENTAS]
    expect(matchSlug(roster, 'elegido ventas_mayor')?.slug).toBe('ventas_mayor')
  })
})

describe('buildRouterPrompt', () => {
  it('lists every agent with its description', () => {
    const prompt = buildRouterPrompt(
      [agent({ slug: 'ventas_mayor', description: 'compras por volumen' })],
      null,
    )
    expect(prompt).toContain('ventas_mayor: compras por volumen')
  })

  it('falls back to the name when there is no description', () => {
    const prompt = buildRouterPrompt(
      [agent({ slug: 'soporte', name: 'Soporte Humano' })],
      null,
    )
    expect(prompt).toContain('soporte: Soporte Humano')
  })

  it('tells the model to stay with the sticky agent', () => {
    const prompt = buildRouterPrompt(ROSTER, VENTAS)
    expect(prompt).toContain('"ventas_mayor"')
    expect(prompt).toContain('Mantén ese agente')
  })

  it('omits the continuity clause when nothing is sticky', () => {
    expect(buildRouterPrompt(ROSTER, null)).not.toContain('Mantén ese agente')
  })
})

describe('routeToAgent', () => {
  beforeEach(() => {
    mockedGenerate.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const messages = [{ role: 'user' as const, content: 'quiero 10 cajas' }]

  it('returns null when the account has no agents', async () => {
    const result = await routeToAgent({
      config: CONFIG,
      agents: [],
      messages,
      stickyAgentId: null,
    })
    expect(result).toEqual({ agent: null, usage: null, reason: 'none' })
    expect(mockedGenerate).not.toHaveBeenCalled()
  })

  it('skips the classification call when there is only one agent', async () => {
    const result = await routeToAgent({
      config: CONFIG,
      agents: [VENTAS],
      messages,
      stickyAgentId: null,
    })
    expect(result.agent).toBe(VENTAS)
    expect(result.reason).toBe('only_agent')
    expect(mockedGenerate).not.toHaveBeenCalled()
  })

  it('routes to the agent the classifier names', async () => {
    mockedGenerate.mockResolvedValue({
      text: 'confirmar_pedido',
      handoff: false,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    })
    const result = await routeToAgent({
      config: CONFIG,
      agents: ROSTER,
      messages,
      stickyAgentId: null,
    })
    expect(result.agent).toBe(PEDIDO)
    expect(result.reason).toBe('classified')
    expect(result.usage?.totalTokens).toBe(12)
  })

  it('keeps the sticky agent when the answer is unrecognisable', async () => {
    mockedGenerate.mockResolvedValue({
      text: 'ni idea',
      handoff: false,
      usage: null,
    })
    const result = await routeToAgent({
      config: CONFIG,
      agents: ROSTER,
      messages,
      stickyAgentId: VENTAS.id,
    })
    expect(result.agent).toBe(VENTAS)
    expect(result.reason).toBe('sticky_fallthrough')
  })

  it('falls back to the fallback agent with no sticky agent', async () => {
    mockedGenerate.mockResolvedValue({
      text: 'ni idea',
      handoff: false,
      usage: null,
    })
    const result = await routeToAgent({
      config: CONFIG,
      agents: ROSTER,
      messages,
      stickyAgentId: null,
    })
    expect(result.agent).toBe(ORQ)
    expect(result.reason).toBe('fallback')
  })

  it('degrades to the fallback agent instead of throwing when the provider fails', async () => {
    mockedGenerate.mockRejectedValue(new Error('provider down'))
    const result = await routeToAgent({
      config: CONFIG,
      agents: ROSTER,
      messages,
      stickyAgentId: null,
    })
    expect(result.agent).toBe(ORQ)
    expect(result.reason).toBe('fallback')
    expect(result.usage).toBeNull()
  })

  it('reports no agent when classification fails and nothing can catch it', async () => {
    mockedGenerate.mockRejectedValue(new Error('provider down'))
    const result = await routeToAgent({
      config: CONFIG,
      agents: [VENTAS, PEDIDO], // no fallback marked
      messages,
      stickyAgentId: null,
    })
    expect(result.agent).toBeNull()
    expect(result.reason).toBe('none')
  })
})
