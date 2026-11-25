import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decisionFor, decide } from '@/lib/ai/sales-review-store'
import { QPLV, reviews } from '@/lib/ai/sales-reviews'
import { retrieveKnowledge } from '@/lib/ai/knowledge'

export async function GET() {
  try {
    const { accountId, supabase } = await requireRole('admin')
    if (accountId !== QPLV) return NextResponse.json({ items: [] })
    const lexical = { embeddingsApiKey: null }
    const items = await Promise.all(reviews.map(async review => {
      const [decision, excerpts, ordinary] = await Promise.all([
        decisionFor(accountId, review),
        retrieveKnowledge(supabase, accountId, lexical, review.search, 3),
        retrieveKnowledge(supabase, accountId, lexical, review.questions[0], 3),
      ])
      const newSources = excerpts.filter(fragment => !ordinary.includes(fragment)).length
      const finding = !excerpts.length
        ? 'Falta una fuente para evaluar esta propuesta.'
        : newSources
          ? `Para la primera pregunta de prueba, la búsqueda por tema recupera ${newSources} fragmentos adicionales entre los tres primeros resultados de la búsqueda por palabras. Revisa si cubren el caso.`
          : 'Ambas búsquedas encuentran los mismos fragmentos principales. Prueba si la aclaración propuesta mejora la respuesta.'
      return { ...review, decision, excerpts, finding }
    }))
    return NextResponse.json({ items })
  } catch (error) { return toErrorResponse(error) }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId, supabase } = await requireRole('admin')
    const body = await request.json().catch(() => null)
    const review = reviews.find(r => r.id === body?.id)
    if (accountId !== QPLV || !review || !['approved', 'rejected'].includes(body?.decision)) {
      return NextResponse.json({ error: 'Revisión inválida' }, { status: 400 })
    }
    if (body.decision === 'approved') {
      const evidence = await retrieveKnowledge(supabase, accountId, { embeddingsApiKey: null }, review.search, 3)
      if (!evidence.length) return NextResponse.json({ error: 'Agrega primero la fuente en la base de conocimiento.' }, { status: 422 })
    }
    if (!await decide(accountId, review, userId, body.decision)) {
      return NextResponse.json({ error: 'Esta propuesta ya fue revisada. Actualiza la lista.' }, { status: 409 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) { return toErrorResponse(error) }
}

