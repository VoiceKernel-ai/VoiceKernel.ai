import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireScope } from '../../middleware/auth';
import { proxyToProvider } from '../../services/proxy';
import { ApiError } from '../../errors';
import {
  PROVIDER_OPERATIONS,
  PROVIDER_OPERATION_COUNT,
  matchProviderOperation,
} from '../../provider/operations.generated';
import { POLICY_BY_OPERATION } from '../../provider/resources';
import { config } from '../../config';

/**
 * /v1/provider/* - complete provider API coverage.
 *
 * The VoiceKernel-native routes are the ergonomic surface, but a customer must
 * never be blocked because we have not wrapped an endpoint yet. Everything the provider
 * exposes is reachable here with the same auth, tenant isolation, rate limits,
 * idempotency and audit trail as a native route.
 *
 * This is a mediated passthrough, not a dumb tunnel:
 *   - the path must match a known provider operation, so a typo 404s here rather
 *     than reaching the upstream with the tenant's credential attached;
 *   - the operation's ownership policy is enforced exactly as elsewhere;
 *   - account-wide operations are refused on the shared platform key.
 */
export const passthroughRouter = Router();

// 25 MB matches the voice provider's own knowledge-base upload ceiling; held in memory since
// the file is immediately forwarded rather than stored.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

passthroughRouter.use(requireScope('provider:passthrough'));

/**
 * Introspection: the exact operation surface this deployment forwards.
 * Documented so integrators can verify coverage rather than take our word.
 */
passthroughRouter.get(
  '/_operations',
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);

    const operations = PROVIDER_OPERATIONS.map((endpoint) => {
      const policy = POLICY_BY_OPERATION.get(endpoint.operationId);
      const blocked = org.provider_mode === 'platform' && policy?.scope === 'tenant';
      return {
        operationId: endpoint.operationId,
        method: endpoint.method,
        providerPath: endpoint.path,
        voicekernelPath: `/v1/provider${endpoint.path}`,
        tag: endpoint.tag,
        summary: endpoint.summary,
        resourceKind: policy?.kind ?? null,
        scope: policy?.scope ?? 'tenant',
        available: !blocked,
        ...(blocked
          ? {
              unavailableReason:
                'Aggregates the whole provider account; unavailable on the shared platform key. Use the VoiceKernel-native equivalent or add your own provider key.',
            }
          : {}),
      };
    });

    res.json({
      object: 'list',
      upstream: config.provider.baseUrl,
      mode: org.provider_mode,
      totalOperations: PROVIDER_OPERATION_COUNT,
      availableOperations: operations.filter((o) => o.available).length,
      data: operations,
    });
  }),
);

/**
 * The forwarder. Matched last so /_operations is not swallowed by it.
 *
 * Express 4 needs the `*` wildcard; the captured suffix is re-prefixed with "/"
 * to rebuild the provider path.
 */
passthroughRouter.all(
  '*',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);

    const suffix = req.params[0] ?? '';
    const providerPath = `/${suffix}`.replace(/\/{2,}/g, '/');

    const match = matchProviderOperation(req.method, providerPath);
    if (!match) {
      throw ApiError.notFound(
        `No provider operation matches ${req.method} ${providerPath}. GET /v1/provider/_operations lists the ${PROVIDER_OPERATION_COUNT} supported operations.`,
      );
    }

    // Rebuild multipart uploads (files, knowledge-base documents) rather than
    // forwarding the parsed body, which would drop the binary.
    let formData: FormData | undefined;
    if (req.file) {
      formData = new FormData();
      formData.append(
        'file',
        new Blob([req.file.buffer], { type: req.file.mimetype }),
        req.file.originalname,
      );
      for (const [key, value] of Object.entries(req.body ?? {})) {
        if (typeof value === 'string') formData.append(key, value);
      }
    }

    const result = await proxyToProvider({
      org,
      method: req.method,
      path: providerPath,
      query: req.query as Record<string, unknown>,
      body: formData ? undefined : req.body,
      formData,
      idempotencyKey: req.header('idempotency-key'),
    });

    // Surface upstream pagination/rate headers the caller may depend on.
    for (const header of ['x-request-id', 'retry-after']) {
      const value = result.headers[header];
      if (value) res.setHeader(`X-Provider-${header}`, value);
    }

    res.status(result.status).json(result.data);
  }),
);
