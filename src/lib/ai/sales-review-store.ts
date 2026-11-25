import { supabaseAdmin } from './admin-client'
import type { Decision, SalesReview } from './sales-reviews'

const bucket = 'ai-sales-reviews'
const key = (account: string, review: SalesReview) => `${process.env.VERCEL_ENV ?? 'development'}/${account}/${review.id}.json`
function missing(error: unknown) {
  return error instanceof Error && /not found|does not exist/i.test(error.message)
}

export async function decisionFor(account: string, review: SalesReview): Promise<Decision | null> {
  const { data, error } = await supabaseAdmin().storage.from(bucket).download(key(account, review))
  if (error && missing(error)) return null
  if (error) throw error
  const row = JSON.parse(await data.text())
  if (row.decision !== 'approved' && row.decision !== 'rejected') throw new Error('Estado de revisión inválido')
  return row.decision
}

export async function decide(account: string, review: SalesReview, user: string, decision: Decision) {
  const storage = supabaseAdmin().storage
  const { error: bucketError } = await storage.createBucket(bucket, { public: false })
  if (bucketError && !/already exists|duplicate/i.test(bucketError.message)) throw bucketError
  const { error } = await storage.from(bucket).upload(key(account, review),
    JSON.stringify({ decision, user, at: new Date().toISOString() }), { contentType: 'application/json', upsert: false })
  if (error && /already exists|duplicate/i.test(error.message)) return false
  if (error) throw error
  return true
}

