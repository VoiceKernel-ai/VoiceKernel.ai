import { z } from 'zod';
import { config } from '../config';
import { ApiError } from '../errors';
import {
  LLM_BY_PROVIDER,
  TRANSCRIBER_BY_PROVIDER,
  VOICE_BY_PROVIDER,
  validateSelection,
} from '../provider/catalog.generated';

/**
 * The VoiceKernel agent
 * =====================
 * the voice provider's assistant object is powerful but sprawling: the system prompt lives
 * inside `model.messages[0].content`, and swapping an LLM means rebuilding a
 * nested object. Integrators asked for a prompt field and a model field.
 *
 * So `agent` is a flat facade over `assistant`. Everything the voice provider supports is
 * still reachable: `provider` is an escape hatch merged over the mapped object, so
 * a customer never hits a ceiling because our facade lacks a field.
 *
 * The mapping is lossless in both directions for the fields it owns - * toProviderAssistant(fromProviderAssistant(x)) preserves x's meaning.
 */

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool', 'function']),
  content: z.string(),
});

export const modelSelectionSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(100_000).optional(),
    emotionRecognitionEnabled: z.boolean().optional(),
    numFastTurns: z.number().int().min(0).optional(),
    /** Provider tool IDs attached to this agent. */
    toolIds: z.array(z.string()).optional(),
    /** Inline tool definitions, passed through to the voice provider verbatim. */
    tools: z.array(z.record(z.unknown())).optional(),
    knowledgeBaseId: z.string().optional(),
    knowledgeBase: z.record(z.unknown()).optional(),
    /** Extra conversation seed messages appended after the system prompt. */
    messages: z.array(messageSchema).optional(),
  })
  .strict();

export const voiceSelectionSchema = z
  .object({
    provider: z.string().min(1),
    voiceId: z.string().min(1).optional(),
    speed: z.number().positive().optional(),
    stability: z.number().min(0).max(1).optional(),
    similarityBoost: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    useSpeakerBoost: z.boolean().optional(),
    model: z.string().optional(),
    language: z.string().optional(),
    chunkPlan: z.record(z.unknown()).optional(),
    fallbackPlan: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const transcriberSelectionSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().optional(),
    language: z.string().optional(),
    smartFormat: z.boolean().optional(),
    keywords: z.array(z.string()).optional(),
    endpointing: z.number().optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    fallbackPlan: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const agentInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    /** The agent's instructions. Becomes the system message. */
    systemPrompt: z.string().max(120_000).optional(),
    firstMessage: z.string().max(10_000).nullable().optional(),
    firstMessageMode: z
      .enum([
        'assistant-speaks-first',
        'assistant-speaks-first-with-model-generated-message',
        'assistant-waits-for-user',
      ])
      .optional(),

    model: modelSelectionSchema.optional(),
    voice: voiceSelectionSchema.optional(),
    transcriber: transcriberSelectionSchema.optional(),

    /** Shorthand for model.toolIds - the common case. */
    toolIds: z.array(z.string()).optional(),

    endCallMessage: z.string().max(5_000).optional(),
    endCallPhrases: z.array(z.string()).optional(),
    voicemailMessage: z.string().max(5_000).optional(),
    silenceTimeoutSeconds: z.number().int().min(10).max(3600).optional(),
    maxDurationSeconds: z.number().int().min(10).max(43200).optional(),
    backgroundSound: z.string().optional(),
    backgroundDenoisingEnabled: z.boolean().optional(),
    modelOutputInMessagesEnabled: z.boolean().optional(),

    /** Recording, transcript retention and PCI behaviour. */
    recordingEnabled: z.boolean().optional(),
    hipaaEnabled: z.boolean().optional(),
    artifactPlan: z.record(z.unknown()).optional(),
    analysisPlan: z.record(z.unknown()).optional(),
    startSpeakingPlan: z.record(z.unknown()).optional(),
    stopSpeakingPlan: z.record(z.unknown()).optional(),
    monitorPlan: z.record(z.unknown()).optional(),
    messagePlan: z.record(z.unknown()).optional(),
    compliancePlan: z.record(z.unknown()).optional(),
    voicemailDetection: z.record(z.unknown()).optional(),

    /**
     * Where VoiceKernel forwards this agent's events. Omit to use the platform
     * webhook pipeline, which is almost always what you want - it gives you
     * signed delivery, retries and a replay log.
     */
    server: z
      .object({
        url: z.string().url(),
        secret: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).max(120).optional(),
        headers: z.record(z.string()).optional(),
      })
      .optional(),

    metadata: z.record(z.unknown()).optional(),

    /**
     * Escape hatch: merged over the generated provider assistants. Use it for any
     * Provider field this facade does not model yet.
     */
    provider: z.record(z.unknown()).optional(),
  })
  .strict();

export type AgentInput = z.infer<typeof agentInputSchema>;

/** Rejects a provider/model combination the provider would refuse at call time. */
export function validateAgent(input: AgentInput): void {
  const problems: string[] = [];

  const modelIssue = validateSelection(
    LLM_BY_PROVIDER,
    input.model?.provider,
    input.model?.model,
    'model',
  );
  if (modelIssue) problems.push(modelIssue);

  const voiceIssue = validateSelection(
    VOICE_BY_PROVIDER,
    input.voice?.provider,
    input.voice?.voiceId,
    'voice',
  );
  if (voiceIssue) problems.push(voiceIssue);

  const transcriberIssue = validateSelection(
    TRANSCRIBER_BY_PROVIDER,
    input.transcriber?.provider,
    input.transcriber?.model,
    'transcriber',
  );
  if (transcriberIssue) problems.push(transcriberIssue);

  if (problems.length) {
    throw ApiError.unprocessable('The agent configuration was rejected.', problems);
  }
}

/**
 * Builds the server URL the provider should post this agent's events to.
 * Routing every agent through one org-scoped endpoint is what lets us attribute
 * an inbound event to a tenant even when the payload omits an ID we know.
 */
export function platformServerUrl(orgId: string): string {
  return `${config.publicBaseUrl}/webhooks/provider/${orgId}`;
}

export interface ToProviderOptions {
  orgId: string;
  /** Merge on top of an existing assistant (PATCH), rather than replace. */
  existing?: Record<string, unknown> | null;
}

export function toProviderAssistant(
  input: AgentInput,
  options: ToProviderOptions,
): Record<string, unknown> {
  const assistant: Record<string, unknown> = {};

  if (input.name !== undefined) assistant.name = input.name;
  if (input.firstMessage !== undefined) assistant.firstMessage = input.firstMessage;
  if (input.firstMessageMode !== undefined) assistant.firstMessageMode = input.firstMessageMode;

  // ---- model ------------------------------------------------------------
  // The system prompt is a facade field, but the provider stores it inside
  // model.messages. Rebuild that array whenever either half is supplied.
  const existingModel = (options.existing?.model ?? null) as Record<string, unknown> | null;

  if (input.model || input.systemPrompt !== undefined || input.toolIds) {
    const model: Record<string, unknown> = { ...(existingModel ?? {}) };

    if (input.model) {
      const { messages, knowledgeBaseId, knowledgeBase, ...rest } = input.model;
      Object.assign(model, rest);
      if (knowledgeBaseId !== undefined) model.knowledgeBaseId = knowledgeBaseId;
      if (knowledgeBase !== undefined) model.knowledgeBase = knowledgeBase;
    }

    // A provider is mandatory once a model block exists at all.
    if (!model.provider) model.provider = 'openai';

    const promptFromInput = input.systemPrompt;
    const existingMessages = Array.isArray(existingModel?.messages)
      ? (existingModel!.messages as Array<Record<string, unknown>>)
      : [];

    if (promptFromInput !== undefined || input.model?.messages) {
      const systemContent =
        promptFromInput ??
        (existingMessages.find((m) => m.role === 'system')?.content as string | undefined) ??
        '';

      const extra = input.model?.messages ?? existingMessages.filter((m) => m.role !== 'system');
      model.messages = [
        ...(systemContent ? [{ role: 'system', content: systemContent }] : []),
        ...extra.filter((m) => (m as Record<string, unknown>).role !== 'system'),
      ];
    }

    if (input.toolIds) model.toolIds = input.toolIds;

    assistant.model = model;
  }

  // ---- voice / transcriber ----------------------------------------------
  if (input.voice) assistant.voice = { ...input.voice };
  if (input.transcriber) assistant.transcriber = { ...input.transcriber };

  // ---- straight passthrough fields --------------------------------------
  const direct: Array<keyof AgentInput> = [
    'endCallMessage',
    'endCallPhrases',
    'voicemailMessage',
    'silenceTimeoutSeconds',
    'maxDurationSeconds',
    'backgroundSound',
    'backgroundDenoisingEnabled',
    'modelOutputInMessagesEnabled',
    'hipaaEnabled',
    'artifactPlan',
    'analysisPlan',
    'startSpeakingPlan',
    'stopSpeakingPlan',
    'monitorPlan',
    'messagePlan',
    'compliancePlan',
    'voicemailDetection',
    'metadata',
  ];
  for (const key of direct) {
    if (input[key] !== undefined) assistant[key] = input[key];
  }

  // `recordingEnabled` moved into artifactPlan upstream; accept the flat form
  // and translate rather than silently dropping it.
  if (input.recordingEnabled !== undefined) {
    const plan = (assistant.artifactPlan ?? {}) as Record<string, unknown>;
    assistant.artifactPlan = { ...plan, recordingEnabled: input.recordingEnabled };
  }

  // ---- event routing -----------------------------------------------------
  // Default every agent to the platform pipeline so calls are mirrored and
  // customer webhooks fire without the integrator wiring anything.
  if (input.server) {
    assistant.server = input.server;
  } else if (!options.existing) {
    assistant.server = { url: platformServerUrl(options.orgId) };
  }

  // ---- escape hatch ------------------------------------------------------
  if (input.provider) Object.assign(assistant, input.provider);

  return assistant;
}

/** Projects a provider assistants back into the VoiceKernel agent shape. */
export function fromProviderAssistant(assistant: Record<string, unknown> | null | undefined) {
  if (!assistant || typeof assistant !== 'object') return null;

  const model = (assistant.model ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(model.messages)
    ? (model.messages as Array<Record<string, unknown>>)
    : [];
  const systemMessage = messages.find((m) => m.role === 'system');
  const artifactPlan = (assistant.artifactPlan ?? {}) as Record<string, unknown>;

  return {
    id: assistant.id ?? null,
    object: 'agent',
    name: assistant.name ?? null,
    systemPrompt: (systemMessage?.content as string | undefined) ?? null,
    firstMessage: assistant.firstMessage ?? null,
    firstMessageMode: assistant.firstMessageMode ?? null,
    model: {
      provider: model.provider ?? null,
      model: model.model ?? null,
      temperature: model.temperature ?? null,
      maxTokens: model.maxTokens ?? null,
      toolIds: model.toolIds ?? [],
      knowledgeBaseId: model.knowledgeBaseId ?? null,
    },
    voice: assistant.voice ?? null,
    transcriber: assistant.transcriber ?? null,
    recordingEnabled: artifactPlan.recordingEnabled ?? null,
    hipaaEnabled: assistant.hipaaEnabled ?? null,
    server: assistant.server ?? null,
    metadata: assistant.metadata ?? {},
    createdAt: assistant.createdAt ?? null,
    updatedAt: assistant.updatedAt ?? null,
    /** The untouched upstream object, for anything the facade omits. */
    provider: assistant,
  };
}
