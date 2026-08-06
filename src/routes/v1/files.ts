import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireScope } from '../../middleware/auth';
import { ApiError } from '../../errors';
import { proxyToProvider } from '../../services/proxy';
import { listResources } from '../../services/resources';
import { listEnvelope, parsePagination, str } from '../../lib/http';

/**
 * /v1/files - knowledge documents backing grounded answers.
 *
 * Split out from the generic CRUD factory because create is multipart: the
 * upload has to be rebuilt as a FormData for the upstream rather than passed
 * through as parsed JSON.
 */
export const filesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});


filesRouter.get(
  '/',
  requireScope('files:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { limit, offset } = parsePagination(req);

    if (str(req.query.refresh) === 'true') {
      const upstream = await proxyToProvider({ org, method: 'GET', path: '/file' });
      res.json(upstream.data);
      return;
    }

    const { items, total } = await listResources({
      orgId: org.id,
      kind: 'file',
      limit,
      offset,
      search: str(req.query.search),
    });
    res.json(
      listEnvelope(
        items.map((row) => ({ id: row.provider_id, ...row.snapshot })),
        { total, limit, offset },
      ),
    );
  }),
);

filesRouter.post(
  '/',
  requireScope('files:write'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);

    if (!req.file) {
      throw ApiError.badRequest(
        'Attach the document as multipart/form-data under the field name "file".',
      );
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }),
      req.file.originalname,
    );
    // the provider accepts an optional display name alongside the upload.
    const name = str(req.body?.name);
    if (name) form.append('name', name);

    const result = await proxyToProvider({
      org,
      method: 'POST',
      path: '/file',
      formData: form,
      idempotencyKey: req.header('idempotency-key'),
    });

    res.status(201).json(result.data);
  }),
);

filesRouter.get(
  '/:id',
  requireScope('files:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'GET',
      path: `/file/${encodeURIComponent(req.params.id)}`,
    });
    res.json(result.data);
  }),
);

filesRouter.patch(
  '/:id',
  requireScope('files:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'PATCH',
      path: `/file/${encodeURIComponent(req.params.id)}`,
      body: req.body,
    });
    res.json(result.data);
  }),
);

filesRouter.delete(
  '/:id',
  requireScope('files:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'DELETE',
      path: `/file/${encodeURIComponent(req.params.id)}`,
    });
    res.json(
      result.data && typeof result.data === 'object'
        ? result.data
        : { id: req.params.id, deleted: true },
    );
  }),
);
