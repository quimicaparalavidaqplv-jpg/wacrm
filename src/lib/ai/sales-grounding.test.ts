import { beforeEach, describe, expect, it, vi } from 'vitest'
import { salesGrounding } from './sales-grounding'
import { reviews, QPLV } from './sales-reviews'
import { decisionFor } from './sales-review-store'
import { retrieveKnowledge } from './knowledge'
import type { AiConfig } from './types'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('./sales-review-store', () => ({ decisionFor: vi.fn() }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: vi.fn() }))
const db = {} as SupabaseClient
const config = { systemPrompt: 'Contexto' } as AiConfig
const review = reviews[0]
const question = review.questions[1]

describe('revisión de mejoras', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(retrieveKnowledge).mockResolvedValue(['Fuente vigente']) })
  it.each([null, 'rejected'] as const)('mantiene la búsqueda ordinaria con estado %s', async state => {
    vi.mocked(decisionFor).mockResolvedValue(state)
    const result = await salesGrounding(db, QPLV, config, question)
    expect(retrieveKnowledge).toHaveBeenCalledWith(db, QPLV, config, question)
    expect(result.userPrompt).not.toContain(review.guidance)
  })
  it('consulta la base vigente después de aprobar', async () => {
    vi.mocked(decisionFor).mockResolvedValue('approved')
    const result = await salesGrounding(db, QPLV, config, question)
    expect(retrieveKnowledge).toHaveBeenCalledWith(db, QPLV, config, review.search)
    expect(result.userPrompt).toContain(review.guidance)
  })
  it('simula sin guardar y omite la mejora si falta la fuente', async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue([])
    const result = await salesGrounding(db, QPLV, config, question, true)
    expect(decisionFor).not.toHaveBeenCalled()
    expect(result.userPrompt).not.toContain(review.guidance)
  })
  it('mantiene aisladas las cuentas', async () => {
    const result = await salesGrounding(db, 'otra', config, question, true)
    expect(decisionFor).not.toHaveBeenCalled()
    expect(result.userPrompt).toBe('Contexto')
  })
})

