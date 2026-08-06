-- ===========================================================================
-- Per-stage latency, denormalised from Vapi's artifact.performanceMetrics.
--
-- The console's latency budget (STT → reasoning → TTS against an SLA) needs
-- percentiles across thousands of calls. Computing those by digging into the
-- `raw` JSONB on every render does not hold up, so the five numbers we
-- actually chart get their own columns.
--
-- Nullable throughout: Vapi only populates performance metrics once a call has
-- ended, and older calls predate this column. A NULL means "not measured",
-- which the analytics layer reports as such rather than as zero.
-- ===========================================================================

ALTER TABLE calls
  ADD COLUMN transcriber_latency_ms NUMERIC(10,2),
  ADD COLUMN model_latency_ms       NUMERIC(10,2),
  ADD COLUMN voice_latency_ms       NUMERIC(10,2),
  ADD COLUMN endpointing_latency_ms NUMERIC(10,2),
  ADD COLUMN turn_latency_ms        NUMERIC(10,2),
  ADD COLUMN user_interruptions     INT,
  ADD COLUMN agent_interruptions    INT;

-- Percentile queries filter to measured calls within a window, per org.
CREATE INDEX calls_latency_idx ON calls (org_id, created_at DESC)
  WHERE turn_latency_ms IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill from any call already mirrored with an artifact payload.
-- ---------------------------------------------------------------------------
UPDATE calls SET
  transcriber_latency_ms = NULLIF(raw #>> '{artifact,performanceMetrics,transcriberLatencyAverage}', '')::numeric,
  model_latency_ms       = NULLIF(raw #>> '{artifact,performanceMetrics,modelLatencyAverage}', '')::numeric,
  voice_latency_ms       = NULLIF(raw #>> '{artifact,performanceMetrics,voiceLatencyAverage}', '')::numeric,
  endpointing_latency_ms = NULLIF(raw #>> '{artifact,performanceMetrics,endpointingLatencyAverage}', '')::numeric,
  turn_latency_ms        = NULLIF(raw #>> '{artifact,performanceMetrics,turnLatencyAverage}', '')::numeric,
  user_interruptions     = NULLIF(raw #>> '{artifact,performanceMetrics,numUserInterrupted}', '')::numeric::int,
  agent_interruptions    = NULLIF(raw #>> '{artifact,performanceMetrics,numAssistantInterrupted}', '')::numeric::int
WHERE raw #> '{artifact,performanceMetrics}' IS NOT NULL;
