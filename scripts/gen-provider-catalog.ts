/**
 * Generates src/provider/catalog.generated.ts - the provider/model catalog that
 * powers model switching in the console and the GET /v1/catalog endpoints.
 *
 * Derived from the voice provider's OpenAPI document so the options we offer are exactly the
 * options the upstream accepts. Hand-maintaining this list guarantees drift:
 * a model the provider adds would be invisible, and one it removes would 400 at call
 * time instead of being rejected at save time.
 *
 *   npx tsx scripts/gen-provider-catalog.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const SPEC_PATH = process.argv[2] ?? path.resolve(__dirname, '../vendor/provider-openapi.json');
const OUT_PATH = path.resolve(__dirname, '../src/provider/catalog.generated.ts');

interface Schema {
  type?: string;
  enum?: string[];
  oneOf?: Schema[];
  title?: string;
  description?: string;
  properties?: Record<string, Schema>;
}

/** Pulls the enum out of a bare enum schema or a oneOf that contains one. */
function enumValues(schema: Schema | undefined): string[] {
  if (!schema) return [];
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.oneOf)) {
    for (const branch of schema.oneOf) {
      if (Array.isArray(branch.enum)) return branch.enum;
    }
  }
  return [];
}

/** True when the field also accepts an arbitrary string (a custom/BYO id). */
function acceptsFreeform(schema: Schema | undefined): boolean {
  if (!schema?.oneOf) return false;
  return schema.oneOf.some((branch) => branch.type === 'string' && !branch.enum);
}

interface Entry {
  provider: string;
  schema: string;
  label: string;
  options: string[];
  freeform: boolean;
}

function collect(
  schemas: Record<string, Schema>,
  suffix: string,
  optionField: string,
  skip: (name: string) => boolean,
): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();

  for (const [name, schema] of Object.entries(schemas)) {
    if (!name.endsWith(suffix)) continue;
    if (skip(name)) continue;

    const providerEnum = enumValues(schema.properties?.provider);
    if (providerEnum.length !== 1) continue;
    const provider = providerEnum[0];
    if (seen.has(provider)) continue;
    seen.add(provider);

    const field = schema.properties?.[optionField];
    out.push({
      provider: PUBLIC_PROVIDER_IDS[provider] ?? provider,
      schema: name,
      label: DISPLAY_LABELS[provider] ?? humanise(name.replace(new RegExp(`${suffix}$`), '')),
      options: enumValues(field),
      freeform: acceptsFreeform(field),
    });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}

interface ToolEntry {
  type: string;
  schema: string;
  label: string;
  group: string;
  description: string;
  /** True when the integrator supplies the behaviour (server URL / code). */
  custom: boolean;
}

/**
 * The tool types an agent can call. Grouped for the console's Actions library:
 * what the platform does natively, what reaches into the customer's systems,
 * and what connects a third party.
 */
function collectTools(schemas: Record<string, Schema>): ToolEntry[] {
  const GROUPS: Array<[RegExp, string]> = [
    [/^(TransferCall|Handoff|EndCall|Dtmf|Sms|Voicemail|SipRequest)Tool$/, 'Telephony'],
    [/^(Function|ApiRequest|Code|Bash|Computer|TextEditor|Query|Output)Tool$/, 'Enterprise systems'],
    [/^Mcp Tool$|^McpTool$/, 'Integrations'],
  ];
  const CUSTOM = /^(Function|ApiRequest|Code|Bash|Computer|TextEditor|Mcp)Tool$/;

  const out: ToolEntry[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    if (!name.endsWith('Tool')) continue;
    if (/^(Create|Update|Fallback)/.test(name)) continue;

    const typeEnum = enumValues(schema.properties?.type);
    if (typeEnum.length !== 1) continue;

    const group = GROUPS.find(([re]) => re.test(name))?.[1] ?? 'Integrations';

    out.push({
      type: typeEnum[0],
      schema: name,
      label: DISPLAY_LABELS[typeEnum[0]] ?? humanise(name.replace(/Tool$/, '')),
      group,
      description: (schema.description ?? schema.properties?.type?.description ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 220),
      custom: CUSTOM.test(name),
    });
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

/**
 * Display labels that differ from the derived schema name.
 *
 * The upstream exposes its own in-house models and voices under the provider id
 * "vapi". Customers never see it: the id is republished under our own name
 * and the proxy translates it back on the wire, so the catalog, the docs and
 * every request body speak one vocabulary.
 */
const PUBLIC_PROVIDER_IDS: Record<string, string> = {
  vapi: 'voicekernel',
};

const DISPLAY_LABELS: Record<string, string> = {
  vapi: 'VoiceKernel',
};

function humanise(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\bAI\b/g, 'AI')
    .trim();
}

function main(): void {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as {
    components: { schemas: Record<string, Schema> };
  };
  const schemas = spec.components.schemas;

  // "Fallback*" duplicates the primary provider; "Workflow*"/"Eval*" are
  // narrowed copies for other surfaces. Both would only add ambiguity here.
  const isVariant = (n: string) =>
    n.startsWith('Fallback') || n.startsWith('Workflow') || n.startsWith('Eval') || n.startsWith('Transfer');

  const models = collect(schemas, 'Model', 'model', isVariant);
  const voices = collect(schemas, 'Voice', 'voiceId', isVariant);
  const transcribers = collect(schemas, 'Transcriber', 'model', isVariant);
  const tools = collectTools(schemas);

  const body = `// ---------------------------------------------------------------------------
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: vendor/provider-openapi.json
// Regenerate: npm run gen:provider
//
// The provider matrix VoiceKernel exposes for model switching.
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  /** Value sent to the voice provider as \`provider\`. */
  provider: string;
  /** Human label for the console. */
  label: string;
  /** Known values; empty means the provider accepts any string. */
  options: readonly string[];
  /** Whether a custom value outside \`options\` is also accepted. */
  freeform: boolean;
}

export const LLM_PROVIDERS: readonly CatalogEntry[] = ${serialise(models)};

export const VOICE_PROVIDERS: readonly CatalogEntry[] = ${serialise(voices)};

export const TRANSCRIBER_PROVIDERS: readonly CatalogEntry[] = ${serialise(transcribers)};

export interface ToolTypeEntry {
  /** Value sent to the voice provider as \`type\` when creating the tool. */
  type: string;
  label: string;
  /** Console grouping: Telephony | Enterprise systems | Integrations. */
  group: string;
  description: string;
  /** Whether the integrator supplies the behaviour (server URL, code, schema). */
  custom: boolean;
}

export const TOOL_TYPES: readonly ToolTypeEntry[] = [
${tools
  .map(
    (t) =>
      `  {\n` +
      `    type: ${JSON.stringify(t.type)},\n` +
      `    label: ${JSON.stringify(t.label)},\n` +
      `    group: ${JSON.stringify(t.group)},\n` +
      `    description: ${JSON.stringify(t.description)},\n` +
      `    custom: ${t.custom},\n` +
      `  },`,
  )
  .join('\n')}
];

function index(entries: readonly CatalogEntry[]): ReadonlyMap<string, CatalogEntry> {
  return new Map(entries.map((e) => [e.provider, e]));
}

export const LLM_BY_PROVIDER = index(LLM_PROVIDERS);
export const VOICE_BY_PROVIDER = index(VOICE_PROVIDERS);
export const TRANSCRIBER_BY_PROVIDER = index(TRANSCRIBER_PROVIDERS);

/**
 * Validates a {provider, value} pair against the catalog. Returns null when
 * acceptable, or a human-readable reason when not - so a bad model is rejected
 * at save time with a useful message instead of failing mid-call.
 */
export function validateSelection(
  index: ReadonlyMap<string, CatalogEntry>,
  provider: string | undefined,
  value: string | undefined,
  what: string,
): string | null {
  if (!provider) return null;
  const entry = index.get(provider);
  if (!entry) {
    return \`Unknown \${what} provider "\${provider}". Supported: \${[...index.keys()].join(', ')}.\`;
  }
  if (!value) return null;
  if (entry.freeform || entry.options.length === 0) return null;
  if (entry.options.includes(value)) return null;
  return \`"\${value}" is not a known \${what} for provider "\${provider}". Supported: \${entry.options.join(', ')}.\`;
}
`;

  fs.writeFileSync(OUT_PATH, body);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(
    `  ${models.length} LLM providers, ${voices.length} voice providers, ${transcribers.length} transcriber providers`,
  );
}

function serialise(entries: Entry[]): string {
  const lines = entries.map(
    (e) =>
      `  {\n` +
      `    provider: ${JSON.stringify(e.provider)},\n` +
      `    label: ${JSON.stringify(e.label)},\n` +
      `    options: ${JSON.stringify(e.options)},\n` +
      `    freeform: ${e.freeform},\n` +
      `  },`,
  );
  return `[\n${lines.join('\n')}\n]`;
}

main();
