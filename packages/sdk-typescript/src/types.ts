/**
 * Types for the VoiceKernel API.
 *
 * Provider and model unions are intentionally `string` with documented known
 * values rather than closed enums: the catalog is generated from the upstream
 * spec and gains entries between SDK releases. A closed union would make a
 * newly supported model a compile error for no good reason - use
 * `client.catalog.list()` to enumerate what the server accepts today.
 */

export interface ListResponse<T> {
  object: 'list';
  data: T[];
  pagination?: {
    total?: number;
    limit: number;
    offset: number;
    hasMore?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface ModelSelection {
  /** e.g. "openai", "anthropic", "google". See catalog.models(). */
  provider: string;
  /** e.g. "gpt-4o", "claude-sonnet-5". */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  toolIds?: string[];
  knowledgeBaseId?: string;
  [key: string]: unknown;
}

export interface VoiceSelection {
  /** e.g. "11labs", "voicekernel", "cartesia". See catalog.voices(). */
  provider: string;
  voiceId?: string;
  speed?: number;
  [key: string]: unknown;
}

export interface TranscriberSelection {
  /** e.g. "deepgram", "assembly-ai". See catalog.transcribers(). */
  provider: string;
  model?: string;
  language?: string;
  [key: string]: unknown;
}

export interface AgentInput {
  name?: string;
  /** The agent's instructions. Becomes the system message. */
  systemPrompt?: string;
  firstMessage?: string | null;
  firstMessageMode?:
    | 'assistant-speaks-first'
    | 'assistant-speaks-first-with-model-generated-message'
    | 'assistant-waits-for-user';
  model?: ModelSelection;
  voice?: VoiceSelection;
  transcriber?: TranscriberSelection;
  toolIds?: string[];
  endCallMessage?: string;
  endCallPhrases?: string[];
  voicemailMessage?: string;
  silenceTimeoutSeconds?: number;
  maxDurationSeconds?: number;
  recordingEnabled?: boolean;
  hipaaEnabled?: boolean;
  compliancePlan?: Record<string, unknown>;
  analysisPlan?: Record<string, unknown>;
  artifactPlan?: Record<string, unknown>;
  server?: { url: string; secret?: string; timeoutSeconds?: number };
  metadata?: Record<string, unknown>;
  /** Escape hatch merged over the generated upstream assistant object. */
  provider?: Record<string, unknown>;
}

export interface Agent {
  id: string;
  object: 'agent';
  name: string | null;
  systemPrompt: string | null;
  firstMessage: string | null;
  model: {
    provider: string | null;
    model: string | null;
    temperature: number | null;
    maxTokens: number | null;
    toolIds: string[];
    knowledgeBaseId: string | null;
  };
  voice: VoiceSelection | null;
  transcriber: TranscriberSelection | null;
  recordingEnabled: boolean | null;
  hipaaEnabled: boolean | null;
  server: { url?: string } | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  /** The untouched upstream object, for fields the facade does not model. */
  provider: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface CreateCallInput {
  /** Destination in E.164, e.g. "+61400000000". */
  to?: string;
  from?: string;
  phoneNumberId?: string;
  agentId?: string;
  squadId?: string;
  workflowId?: string;
  /** Inline, transient agent config - not persisted as a saved agent. */
  agent?: AgentInput;
  name?: string;
  customer?: Record<string, unknown>;
  schedulePlan?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  assistantOverrides?: Record<string, unknown>;
  provider?: Record<string, unknown>;
}

export interface Call {
  id: string;
  object?: 'call';
  assistantId: string | null;
  squadId: string | null;
  phoneNumberId: string | null;
  type: string | null;
  direction: string | null;
  status: string | null;
  endedReason: string | null;
  customer: { number: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  cost: number | null;
  transcript: string | null;
  summary: string | null;
  recordingUrl: string | null;
  analysis: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CallTranscript {
  callId: string;
  transcript: string | null;
  summary: string | null;
  analysis: unknown;
  messages: Array<Record<string, unknown>>;
}

export type CallArtifact =
  | 'recording'
  | 'mono-recording'
  | 'stereo-recording'
  | 'video-recording'
  | 'customer-recording'
  | 'assistant-recording'
  | 'pcap'
  | 'logs';

export interface ArtifactUrl {
  url: string;
  expiresIn: number;
  artifact: string;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface AnalyticsOverview {
  object: 'analytics.overview';
  window: { since: string; until: string };
  calls: {
    total: number;
    completed: number;
    failed: number;
    inProgress: number;
    containmentRate: number | null;
  };
  minutes: { total: number; average: number | null };
  cost: { total: number; perCall: number | null };
  latency: { p50: number | null; p95: number | null };
  resources: Record<string, number>;
}

export interface LatencyBudget {
  object: 'analytics.latency';
  sampleSize: number;
  slaMs: number;
  stages: Array<{ stage: string; label: string; p50: number | null; share: number | null }>;
  totalP50: number | null;
  turnP50: number | null;
  turnP95: number | null;
  headroomMs: number | null;
  withinSla: boolean | null;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  secretLast4: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointCreated extends WebhookEndpoint {
  /** Returned once at creation. Store it; it signs every delivery. */
  secret: string;
  signatureFormat: string;
}

/** The envelope delivered to your endpoint. */
export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  object: 'event';
  /** e.g. "call.ended", "tool.called", "billing.threshold". */
  type: string;
  /** Unix seconds. */
  created: number;
  data: T;
}

export interface CallEndedEvent {
  type: string;
  call?: Call;
  artifact?: { transcript?: string; recordingUrl?: string };
  analysis?: { summary?: string };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  provider: string;
  label: string;
  options: string[];
  freeform: boolean;
}

export interface Catalog {
  object: 'catalog';
  models: CatalogEntry[];
  voices: CatalogEntry[];
  transcribers: CatalogEntry[];
  counts: {
    modelProviders: number;
    voiceProviders: number;
    transcriberProviders: number;
    models: number;
  };
}

// ---------------------------------------------------------------------------
// Billing and governance
// ---------------------------------------------------------------------------

export interface BudgetStatus {
  period: string;
  budget: number | null;
  spend: number;
  minutes: number;
  calls: number;
  used: number | null;
  remaining: number | null;
  projected: number | null;
  overBudget: boolean;
  /** Only outbound campaigns pause; inbound and live calls never do. */
  outboundPaused: boolean;
  note: string;
}

export interface ErasureReceipt {
  object: 'erasure.receipt';
  subject: string;
  requestedAt: string;
  callsFound: number;
  callsRedacted: number;
  upstream: { deleted: number; failed: number; failures: Array<{ callId: string; reason: string }> };
  eventsRedacted: number;
  /** False when provider-side deletion partially failed - retry those IDs. */
  complete: boolean;
  note: string;
}

export interface ListParams {
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}
