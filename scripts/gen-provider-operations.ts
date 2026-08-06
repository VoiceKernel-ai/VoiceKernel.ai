/**
 * Generates src/provider/operations.generated.ts from the vendored provider OpenAPI
 * document.
 *
 * VoiceKernel guarantees that every provider operation is reachable through our
 * API. Deriving that surface from the voice provider's own spec - rather than a hand-written
 * list - is what makes the guarantee checkable: `npm run gen:provider` after a spec
 * refresh will surface any new operation as a diff.
 *
 *   npx tsx scripts/gen-provider-operations.ts [path-to-spec]
 */
import fs from 'node:fs';
import path from 'node:path';

const SPEC_PATH = process.argv[2] ?? path.resolve(__dirname, '../vendor/provider-openapi.json');
const OUT_PATH = path.resolve(__dirname, '../src/provider/operations.generated.ts');

/**
 * Operations the provider serves but does not publish in its OpenAPI document.
 *
 * The spec ships a CreateWebCallDTO schema that no path references, so the
 * generator has nothing to emit for browser calls even though the endpoint is
 * live. Declaring it here keeps the proxy's rule intact - every outbound
 * request still resolves to a known operation before it is sent, and still
 * gets a policy - instead of carving out a bypass for one route.
 *
 * Confirmed by observation, not by the document: POST /call with a `daily`
 * transport is treated as telephony and rejected with "Couldn't Get Phone
 * Number", while POST /call/web returns a room. Re-check when the vendored
 * spec is next updated; if the path appears there, delete it from here.
 */
const SUPPLEMENTAL_OPERATIONS = [
  {
    operationId: 'CallController_createWebCall',
    method: 'POST' as const,
    path: '/call/web',
    tag: 'Calls',
    summary: 'Create Web Call',
  },
];

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

interface SpecParameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: { type?: string; items?: { type?: string }; enum?: string[] };
  description?: string;
}

interface SpecOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: SpecParameter[];
  requestBody?: { required?: boolean; content?: Record<string, unknown> };
  responses?: Record<string, { description?: string; content?: Record<string, unknown> }>;
}

function main(): void {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as {
    paths: Record<string, Record<string, SpecOperation>>;
    info?: { version?: string };
  };

  const endpoints: string[] = [];
  let count = 0;

  for (const [routePath, item] of Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b))) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      count++;

      const pathParams = [...routePath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const queryParams = (op.parameters ?? [])
        .filter((p) => p.in === 'query')
        .map((p) => ({
          name: p.name,
          required: Boolean(p.required),
          type: p.schema?.type ?? 'string',
        }));

      const hasBody = Boolean(op.requestBody);
      const isMultipart = Boolean(
        op.requestBody?.content && 'multipart/form-data' in op.requestBody.content,
      );
      // A 302 with no JSON body means the provider hands back a presigned artifact URL.
      const isRedirect = Boolean(op.responses && '302' in op.responses);

      endpoints.push(
        `  {\n` +
          `    operationId: ${JSON.stringify(op.operationId ?? `${method}:${routePath}`)},\n` +
          `    method: ${JSON.stringify(method.toUpperCase())},\n` +
          `    path: ${JSON.stringify(routePath)},\n` +
          `    tag: ${JSON.stringify(op.tags?.[0] ?? 'Other')},\n` +
          `    summary: ${JSON.stringify(op.summary ?? '')},\n` +
          `    pathParams: ${JSON.stringify(pathParams)},\n` +
          `    queryParams: ${JSON.stringify(queryParams)},\n` +
          `    hasBody: ${hasBody},\n` +
          `    isMultipart: ${isMultipart},\n` +
          `    isRedirect: ${isRedirect},\n` +
          `  },`,
      );
    }
  }

  for (const op of SUPPLEMENTAL_OPERATIONS) {
    endpoints.push(
      `  {\n` +
        `    operationId: ${JSON.stringify(op.operationId)},\n` +
        `    method: ${JSON.stringify(op.method)},\n` +
        `    path: ${JSON.stringify(op.path)},\n` +
        `    tag: ${JSON.stringify(op.tag)},\n` +
        `    summary: ${JSON.stringify(op.summary)},\n` +
        `    pathParams: [],\n` +
        `    queryParams: [],\n` +
        `    hasBody: true,\n` +
        `    isMultipart: false,\n` +
        `    isRedirect: false,\n` +
      `  },`,
    );
    count++;
  }

  const header = `// ---------------------------------------------------------------------------
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: vendor/provider-openapi.json (provider OpenAPI ${spec.info?.version ?? 'unknown'})
// Regenerate: npm run gen:provider
//
// ${count} operations across ${Object.keys(spec.paths).length} paths.
// ---------------------------------------------------------------------------

export interface ProviderQueryParam {
  name: string;
  required: boolean;
  type: string;
}

export interface ProviderOperation {
  operationId: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  tag: string;
  summary: string;
  pathParams: string[];
  queryParams: ProviderQueryParam[];
  hasBody: boolean;
  isMultipart: boolean;
  /** Responds 302 to a short-lived presigned URL instead of a JSON body. */
  isRedirect: boolean;
}

export const PROVIDER_OPERATION_COUNT = ${count};

export const PROVIDER_OPERATIONS: readonly ProviderOperation[] = [
${endpoints.join('\n')}
] as const;

/** Compiled matchers, longest path first so /call/{id}/pcap beats /call/{id}. */
export const PROVIDER_OPERATION_MATCHERS: ReadonlyArray<{
  endpoint: ProviderOperation;
  regex: RegExp;
}> = PROVIDER_OPERATIONS.map((endpoint) => ({
  endpoint,
  regex: new RegExp(
    '^' + endpoint.path.replace(/\\{[^}]+\\}/g, '([^/]+)') + '$',
  ),
})).sort((a, b) => b.endpoint.path.length - a.endpoint.path.length);

/**
 * Resolves an inbound passthrough request to the provider operation it targets.
 * Returns null when no operation matches - the passthrough refuses unknown
 * paths rather than blindly forwarding them.
 */
export function matchProviderOperation(
  method: string,
  pathname: string,
): { endpoint: ProviderOperation; params: Record<string, string> } | null {
  const upper = method.toUpperCase();
  for (const { endpoint, regex } of PROVIDER_OPERATION_MATCHERS) {
    if (endpoint.method !== upper) continue;
    const match = regex.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    endpoint.pathParams.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });
    return { endpoint, params };
  }
  return null;
}
`;

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, header);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  ${count} operations, ${Object.keys(spec.paths).length} paths`);
}

main();
