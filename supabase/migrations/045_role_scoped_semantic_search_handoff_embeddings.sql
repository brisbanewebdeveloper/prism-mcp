-- Migration 045: Role-scoped semantic search and handoff embeddings
--
-- Keeps the Supabase schema aligned with SupabaseStorage.searchMemory() and
-- sessionSaveHandoffHandler(), which both use role-scoped embeddings.

ALTER TABLE public.session_handoffs
  ADD COLUMN IF NOT EXISTS embedding vector(768) DEFAULT NULL;
ALTER TABLE public.session_handoffs
  ADD COLUMN IF NOT EXISTS embedding_compressed TEXT DEFAULT NULL;
ALTER TABLE public.session_handoffs
  ADD COLUMN IF NOT EXISTS embedding_format TEXT DEFAULT NULL;
ALTER TABLE public.session_handoffs
  ADD COLUMN IF NOT EXISTS embedding_turbo_radius REAL DEFAULT NULL;

CREATE OR REPLACE FUNCTION public.semantic_search_ledger(
  p_query_embedding vector(768),
  p_project TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 5,
  p_similarity_threshold DOUBLE PRECISION DEFAULT 0.7,
  p_user_id TEXT DEFAULT 'default',
  p_role TEXT DEFAULT NULL
) RETURNS TABLE(
  id UUID,
  project TEXT,
  summary TEXT,
  decisions TEXT[],
  files_changed TEXT[],
  session_date DATE,
  created_at TIMESTAMPTZ,
  similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sl.id,
    sl.project,
    sl.summary,
    sl.decisions,
    sl.files_changed,
    sl.session_date,
    sl.created_at,
    1 - (sl.embedding <=> p_query_embedding) AS similarity
  FROM public.session_ledger sl
  WHERE sl.embedding IS NOT NULL
    AND sl.user_id = p_user_id
    AND (p_project IS NULL OR sl.project = p_project)
    AND (p_role IS NULL OR sl.role = p_role)
    AND sl.deleted_at IS NULL
    AND sl.archived_at IS NULL
    AND 1 - (sl.embedding <=> p_query_embedding) >= p_similarity_threshold
  ORDER BY sl.embedding <=> p_query_embedding
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.semantic_search_ledger(
  vector, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT
) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
