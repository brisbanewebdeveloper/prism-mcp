-- v7.8.4: Persistent retry metadata for missing ledger embeddings

ALTER TABLE public.session_ledger
  ADD COLUMN IF NOT EXISTS embedding_status TEXT DEFAULT NULL;

ALTER TABLE public.session_ledger
  ADD COLUMN IF NOT EXISTS embedding_last_error TEXT DEFAULT NULL;

ALTER TABLE public.session_ledger
  ADD COLUMN IF NOT EXISTS embedding_retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.session_ledger
  ADD COLUMN IF NOT EXISTS embedding_last_attempt_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_session_ledger_embedding_retry
  ON public.session_ledger(user_id, embedding_status, embedding_last_attempt_at)
  WHERE archived_at IS NULL AND embedding IS NULL;

NOTIFY pgrst, 'reload schema';
