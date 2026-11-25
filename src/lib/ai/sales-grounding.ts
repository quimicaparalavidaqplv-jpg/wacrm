import type { SupabaseClient } from '@supabase/supabase-js'
import { retrieveKnowledge } from './knowledge'
import type { AiConfig } from './types'
import { commercialPolicy, matchReview, QPLV } from './sales-reviews'
import { decisionFor } from './sales-review-store'

export async function salesGrounding(db: SupabaseClient, account: string, config: AiConfig, question: string, simulate = false) {
  const review = account === QPLV ? matchReview(question) : undefined
  let apply = simulate && Boolean(review)
  if (review && !apply) {
    try { apply = await decisionFor(account, review) === 'approved' }
    catch { console.warn('[sales reviews] unavailable, using ordinary retrieval') }
  }
  const query = apply && review ? review.search : question
  const knowledge = await retrieveKnowledge(db, account, config, query)
  const policy = account === QPLV ? commercialPolicy : ''
  return {
    knowledge,
    userPrompt: [config.systemPrompt, policy, apply && knowledge.length && review ? review.guidance : ''].filter(Boolean).join('\n\n'),
  }
}

