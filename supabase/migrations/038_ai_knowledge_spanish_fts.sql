-- ============================================================
-- 038 — Knowledge-base search: Spanish-aware and typo-tolerant.
--
-- The lexical retrieval built in migration 030 used the language-neutral
-- `'simple'` text-search config. That never stems, so a customer asking
-- for "precios al mayor" failed to match the document's "MAYORISTAS"
-- section — the excerpt with the wholesale prices was never retrieved,
-- and the model fell back to guessing / emitting the prompt's
-- placeholder. (Accounts without an embeddings key rely on this lexical
-- path alone, so the miss was total.)
--
-- Two changes fix it:
--   1. Re-generate the stored `fts` column with the `'spanish'` config
--      so "mayoristas" → 'mayor', "precios" → 'preci', and Spanish stop
--      words ("al", "de", "por") are dropped. Both the index and the
--      query below must share this config to match.
--   2. Loosen `match_ai_knowledge_fts` from AND to OR across the query
--      lexemes. `plainto_tsquery` joins every word with `&`, so a longer
--      natural question ("¿cuánto cuesta el desinfectante al por mayor?")
--      only matched a chunk containing ALL of those stems — almost never.
--      Rewriting `&` → `|` retrieves chunks matching ANY term, and
--      `ts_rank` still floats the most relevant (most terms matched) to
--      the top, where the `LIMIT k` keeps them.
--
-- Semantic retrieval (migration 030) is unchanged; this only touches the
-- lexical path.
-- ============================================================

-- 1. Re-generate the stored tsvector under the Spanish config.
--    Dropping the generated column drops its GIN index too, so recreate
--    both. STORED + GENERATED means every existing row is recomputed on
--    ADD COLUMN — no manual backfill needed.
DROP INDEX IF EXISTS ai_knowledge_chunks_fts_idx;

ALTER TABLE ai_knowledge_chunks DROP COLUMN IF EXISTS fts;

ALTER TABLE ai_knowledge_chunks
  ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', content)) STORED;

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_fts_idx
  ON ai_knowledge_chunks USING gin (fts);

-- 2. Spanish-aware, OR-tolerant lexical match.
--    `replace(... ' & ' -> ' | ')` turns plainto_tsquery's AND-joined
--    query into an OR-joined one. An empty query (all stop words) yields
--    ''::tsquery, which `@@` never matches — degrades to zero rows.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  WITH q AS (
    SELECT replace(
             plainto_tsquery('spanish', p_query)::text,
             ' & ', ' | '
           )::tsquery AS tsq
  )
  SELECT c.id,
         c.content,
         ts_rank(c.fts, q.tsq) AS rank
  FROM ai_knowledge_chunks c, q
  WHERE c.account_id = p_account_id
    AND c.fts @@ q.tsq
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

-- CREATE OR REPLACE preserves grants, but keep them explicit and
-- re-runnable (mirrors migrations 030 / 032).
REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
