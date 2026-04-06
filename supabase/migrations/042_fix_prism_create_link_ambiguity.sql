-- Migration 042: Fix PL/pgSQL output-column ambiguity in prism_create_link

BEGIN;

CREATE OR REPLACE FUNCTION public.prism_create_link(
  p_user_id TEXT,
  p_source_id UUID,
  p_target_id UUID,
  p_link_type TEXT,
  p_strength REAL DEFAULT 1.0,
  p_metadata JSONB DEFAULT NULL
)
RETURNS TABLE (
  source_id UUID,
  target_id UUID,
  link_type TEXT,
  strength REAL,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  last_traversed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_strength REAL := GREATEST(0.0, LEAST(COALESCE(p_strength, 1.0), 1.0));
BEGIN
  IF p_link_type IS NULL OR btrim(p_link_type) = '' THEN
    RAISE EXCEPTION 'p_link_type is required';
  END IF;

  PERFORM public.prism_assert_ledger_owner(p_user_id, p_source_id);
  PERFORM public.prism_assert_ledger_owner(p_user_id, p_target_id);

  INSERT INTO public.memory_links (
    source_id,
    target_id,
    link_type,
    strength,
    metadata
  )
  VALUES (
    p_source_id,
    p_target_id,
    p_link_type,
    v_strength,
    p_metadata
  )
  ON CONFLICT ON CONSTRAINT memory_links_pkey
  DO UPDATE SET
    strength = EXCLUDED.strength,
    metadata = EXCLUDED.metadata,
    last_traversed_at = now();

  RETURN QUERY
  SELECT m.source_id, m.target_id, m.link_type, m.strength, m.metadata, m.created_at, m.last_traversed_at
  FROM public.memory_links m
  WHERE m.source_id = p_source_id
    AND m.target_id = p_target_id
    AND m.link_type = p_link_type;
END;
$$;

GRANT EXECUTE ON FUNCTION public.prism_create_link(TEXT, UUID, UUID, TEXT, REAL, JSONB) TO service_role, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;