-- 041_verification_user_id_parity.sql

ALTER TABLE public.verification_harnesses
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE public.verification_runs
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_verification_runs_user
  ON public.verification_runs(user_id, project);

NOTIFY pgrst, 'reload schema';
