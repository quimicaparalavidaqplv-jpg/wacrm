'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { SalesReview, Decision } from '@/lib/ai/sales-reviews'

type Item = SalesReview & { decision: Decision | null; excerpts: string[]; finding: string }

async function api(url: string, body?: unknown) {
  const res = await fetch(url, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'No se pudo completar la operación.')
  return data
}

export function SalesReviews() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [results, setResults] = useState<Record<string, string>>({})
  const [questions, setQuestions] = useState<Record<string, string>>({})
  async function refresh() {
    const data = await api('/api/ai/sales-reviews')
    setItems(data.items)
  }
  useEffect(() => { refresh().catch(e => setError(e.message)) }, [])

  async function action(item: Item, choice: Decision | 'test') {
    setBusy(item.id)
    setError('')
    try {
      if (choice === 'test') {
        const question = questions[item.id] ?? item.questions[0]
        const messages = [{ role: 'user', content: question }]
        const run = async (simulateReview: boolean) => {
          const data = await api('/api/ai/playground', { messages, simulateReview })
          return data.reply || (data.handoff ? 'Derivaría la conversación a un asesor.' : 'Sin respuesta.')
        }
        const current = await run(false)
        const proposed = await run(true)
        setResults(prev => ({ ...prev, [item.id]: `Respuesta actual\n${current}\n\nCon la propuesta\n${proposed}` }))
      } else {
        await api('/api/ai/sales-reviews', { id: item.id, decision: choice })
        await refresh()
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Intenta nuevamente.') }
    finally { setBusy('') }
  }
  return <section className="space-y-4">
    <h2 className="text-lg font-semibold">Mejoras pendientes</h2>
    <p className="text-sm text-muted-foreground">Compara cómo responde el bot a preguntas de prueba. Al aprobar una propuesta, esas preguntas consultarán la fuente indicada en la base vigente.</p>
    {error && <p role="alert">{error} <button className="underline" onClick={() => { setError(''); refresh().catch(e => setError(e.message)) }}>Actualizar</button></p>}
    {!items && !error && <p>Cargando propuestas…</p>}
    {items?.length === 0 && <p>No hay propuestas para esta cuenta.</p>}
    {items?.map(item => <article key={item.id} className="space-y-3 rounded-lg border p-4">
      <h3 className="font-semibold">{item.title}</h3>
      <p className="text-sm text-muted-foreground">{item.finding}</p>
      <p className="text-sm">{item.guidance}</p>
      <details><summary>Ver fragmentos de la base ({item.excerpts.length})</summary>
        {item.excerpts.map((s, i) => <p key={i} className="my-2 whitespace-pre-wrap border-l-2 pl-3 text-sm">{s}</p>)}
      </details>
      {item.decision ? <p>{item.decision === 'approved' ? 'Aprobada' : 'Rechazada'}</p> : <>
        <label className="block text-sm">Pregunta de prueba
          <select className="mt-1 block w-full rounded border bg-background p-2" value={questions[item.id] ?? item.questions[0]} disabled={!!busy}
            onChange={e => { setQuestions({ ...questions, [item.id]: e.target.value }); setResults({ ...results, [item.id]: '' }) }}>
            {item.questions.map(q => <option key={q}>{q}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!!busy} onClick={() => action(item, 'test')}>Probar</Button>
          <Button disabled={!!busy || !item.excerpts.length} onClick={() => action(item, 'approved')}>Aprobar</Button>
          <Button variant="outline" disabled={!!busy} onClick={() => action(item, 'rejected')}>Rechazar</Button>
        </div>
        {busy === item.id && <p role="status">Procesando…</p>}
      </>}
      {results[item.id] && <p className="whitespace-pre-wrap text-sm">{results[item.id]}</p>}
    </article>)}
  </section>
}

