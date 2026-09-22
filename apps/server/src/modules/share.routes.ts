import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import {
  collabSubmissionSchema,
  shareLinkSchema,
  submissionApproveSchema,
  submissionRejectSchema,
} from '@gml/shared';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { requireAuth, requireShareToken, requireCollabShare } from '../middleware/auth.js';
import { collabRateLimit } from '../middleware/collabRateLimit.js';
import { resolvePublicOrigin } from '../lib/origin.js';
import { computeAllGarmentStats, computeHealth, loadDataset } from '../services/stats.js';
import { approveSubmission, createSubmission, rejectSubmission } from '../services/collab.js';
import { z } from 'zod';

export const shareRouter = Router();
shareRouter.use(requireAuth);

shareRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(shareLinkSchema, req.body);
    if (body.scope === 'garment' && body.garmentIds.length === 0) {
      throw new HttpError('VALIDATION_FAILED', '请至少选择一件要分享的衣物');
    }

    const garments = await prisma.garment.findMany({
      where: { id: { in: body.garmentIds }, wardrobeId: req.ctx.wardrobeId, deletedAt: null },
      select: { id: true },
    });
    if (garments.length !== body.garmentIds.length) {
      throw new HttpError('VALIDATION_FAILED', '有衣物不在你的衣橱里');
    }

    const token = randomBytes(24).toString('base64url');
    const expiresInHours = body.expiresInHours ?? env.shareLinkTtlHours;
    const link = await prisma.shareLink.create({
      data: {
        wardrobeId: req.ctx.wardrobeId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        scope: body.scope,
        garmentIds: body.garmentIds,
        mode: body.mode,
        expiresAt: new Date(Date.now() + expiresInHours * 3_600_000),
        createdBy: req.ctx.userId,
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'share_link',
      entityId: link.id,
      action: 'create',
      diff: { scope: body.scope, mode: body.mode, garmentIds: body.garmentIds, expiresInHours },
      requestId: req.ctx.requestId,
    });
    created(req, res, {
      id: link.id,
      token,
      url: `${resolvePublicOrigin(req)}/share/${token}`,
      expiresAt: link.expiresAt,
      scope: link.scope,
      mode: link.mode,
      garmentIds: link.garmentIds,
    });
  }),
);

shareRouter.get(
  '/',
  handler(async (req, res) => {
    const links = await prisma.shareLink.findMany({
      where: { wardrobeId: req.ctx.wardrobeId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { submissions: { where: { status: 'pending' } } } } },
    });
    ok(req, res, {
      links: links.map((l) => ({
        id: l.id,
        scope: l.scope,
        mode: l.mode,
        garmentIds: l.garmentIds,
        expiresAt: l.expiresAt,
        accessCount: l.accessCount,
        lastAccessAt: l.lastAccessAt,
        pendingSubmissions: l._count.submissions,
        expired: l.expiresAt.getTime() < Date.now(),
      })),
    });
  }),
);

shareRouter.delete(
  '/:id',
  handler(async (req, res) => {
    const link = await prisma.shareLink.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId },
    });
    if (!link) throw new HttpError('NOT_FOUND', '分享链接不存在');
    await prisma.shareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'share_link',
      entityId: link.id,
      action: 'delete',
      diff: { revoked: true },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { revoked: true });
  }),
);

/** 主人侧：待处理 / 全部回填单 */
shareRouter.get(
  '/submissions/pending',
  handler(async (req, res) => {
    const items = await prisma.repairSubmission.findMany({
      where: { wardrobeId: req.ctx.wardrobeId, status: 'pending' },
      orderBy: { submittedAt: 'desc' },
      include: {
        garment: { select: { id: true, code: true, name: true } },
        damageEvent: { select: { id: true, code: true } },
      },
    });
    ok(req, res, { items: items.map(serializeSubmissionSummary) });
  }),
);

shareRouter.get(
  '/submissions',
  handler(async (req, res) => {
    const query = parseQuery(
      z.object({
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const items = await prisma.repairSubmission.findMany({
      where: { wardrobeId: req.ctx.wardrobeId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { submittedAt: 'desc' },
      take: query.limit,
      include: {
        garment: { select: { id: true, code: true, name: true } },
        damageEvent: { select: { id: true, code: true } },
      },
    });
    ok(req, res, { items: items.map(serializeSubmissionSummary) });
  }),
);

shareRouter.get(
  '/submissions/:id',
  handler(async (req, res) => {
    const submission = await prisma.repairSubmission.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId },
      include: {
        garment: true,
        damageEvent: { include: { damageType: true, part: true } },
      },
    });
    if (!submission) throw new HttpError('NOT_FOUND', '回填单不存在');

    // 审批页需要候选数据：这件衣物可挂接的破损、针法库、可用布料库存
    const [openDamages, stitches, fabricSources] = await Promise.all([
      prisma.damageEvent.findMany({
        where: { garmentId: submission.garmentId, status: { notIn: ['unrepairable', 'cancelled'] } },
        orderBy: { detectedAt: 'desc' },
        include: { damageType: true, part: true },
      }),
      prisma.stitch.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.fabricSource.findMany({
        where: { wardrobeId: req.ctx.wardrobeId, isActive: true },
        include: { inventory: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    ok(req, res, {
      submission: {
        id: submission.id,
        status: submission.status,
        collaborator: submission.collaborator,
        contact: submission.contact,
        payload: submission.payload,
        submittedAt: submission.submittedAt,
        reviewedAt: submission.reviewedAt,
        reviewNote: submission.reviewNote,
        repairId: submission.repairId,
        ip: submission.ip,
        userAgent: submission.userAgent,
        garment: { id: submission.garment.id, code: submission.garment.code, name: submission.garment.name },
        damageEvent: submission.damageEvent
          ? {
              id: submission.damageEvent.id,
              code: submission.damageEvent.code,
              damageType: submission.damageEvent.damageType.name,
              part: submission.damageEvent.part?.name ?? null,
            }
          : null,
      },
      candidates: {
        damages: openDamages.map((d) => ({
          id: d.id,
          code: d.code,
          damageType: d.damageType.name,
          part: d.part?.name ?? null,
          status: d.status,
          detectedAt: d.detectedAt,
        })),
        stitches: stitches.map((s) => ({ id: s.id, code: s.code, name: s.name })),
        fabricSources: fabricSources.map((f) => ({
          id: f.id,
          name: f.name,
          kind: f.kind,
          inventory: f.inventory
            ? { unit: f.inventory.unit, remainingAmount: f.inventory.remainingAmount }
            : null,
        })),
      },
    });
  }),
);

shareRouter.post(
  '/submissions/:id/approve',
  handler(async (req, res) => {
    const body = parseBody(submissionApproveSchema, req.body);
    const result = await approveSubmission({
      submissionId: req.params.id,
      wardrobeId: req.ctx.wardrobeId,
      userId: req.ctx.userId,
      email: req.ctx.email,
      body,
      requestId: req.ctx.requestId,
    });
    ok(req, res, result);
  }),
);

shareRouter.post(
  '/submissions/:id/reject',
  handler(async (req, res) => {
    const body = parseBody(submissionRejectSchema, req.body);
    await rejectSubmission({
      submissionId: req.params.id,
      wardrobeId: req.ctx.wardrobeId,
      userId: req.ctx.userId,
      reason: body.reason,
      requestId: req.ctx.requestId,
    });
    ok(req, res, { rejected: true });
  }),
);

function serializeSubmissionSummary(s: {
  id: string;
  status: string;
  collaborator: string;
  submittedAt: Date;
  reviewedAt: Date | null;
  reviewNote: string | null;
  repairId: string | null;
  payload: unknown;
  garment: { id: string; code: string; name: string };
  damageEvent: { id: string; code: string } | null;
}) {
  const payload = s.payload as Record<string, unknown>;
  return {
    id: s.id,
    status: s.status,
    collaborator: s.collaborator,
    garment: s.garment,
    damageEvent: s.damageEvent,
    newDamage: (payload.newDamage as { damageTypeCode?: string; description?: string } | null) ?? null,
    laborCost: payload.laborCost ?? null,
    materialTotalCost: payload.materialTotalCost ?? null,
    materialCount: Array.isArray(payload.materials) ? payload.materials.length : 0,
    finishedAt: payload.finishedAt ?? null,
    submittedAt: s.submittedAt,
    reviewedAt: s.reviewedAt,
    reviewNote: s.reviewNote,
    repairId: s.repairId,
  };
}

/** 访客入口：公开，但只能读到分享范围内的数据 */
export const sharePublicRouter = Router();

sharePublicRouter.get(
  '/:token',
  requireShareToken,
  handler(async (req, res) => {
    const share = req.share!;
    const wardrobe = await prisma.wardrobe.findUniqueOrThrow({ where: { id: share.wardrobeId } });
    const garments = await prisma.garment.findMany({
      where: {
        wardrobeId: share.wardrobeId,
        deletedAt: null,
        ...(share.scope === 'wardrobe' ? {} : { id: { in: share.garmentIds } }),
      },
      select: { id: true, code: true, name: true, materialPrimary: true, status: true },
    });
    const link = await prisma.shareLink.findUniqueOrThrow({ where: { id: share.shareLinkId } });
    ok(req, res, {
      wardrobeName: wardrobe.name,
      scope: share.scope,
      mode: link.mode,
      garments,
      expiresAt: link.expiresAt,
    });
  }),
);

/** 协作页所需字典：只给 code/name，不暴露任何衣橱私有数据 */
sharePublicRouter.get(
  '/:token/dictionary',
  requireShareToken,
  requireCollabShare,
  handler(async (req, res) => {
    const [stitches, damageTypes, parts] = await Promise.all([
      prisma.stitch.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.damageType.findMany({ orderBy: { name: 'asc' } }),
      prisma.part.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    ok(req, res, {
      stitches: stitches.map((s) => ({ code: s.code, name: s.name })),
      damageTypes: damageTypes.map((d) => ({ code: d.code, name: d.name, defaultSeverity: d.defaultSeverity })),
      parts: parts.map((p) => ({ code: p.code, name: p.name })),
    });
  }),
);

/** 师傅提交修补回填 */
sharePublicRouter.post(
  '/:token/submissions',
  requireShareToken,
  requireCollabShare,
  collabRateLimit,
  handler(async (req, res) => {
    const share = req.share!;
    const body = parseBody(collabSubmissionSchema, req.body);
    if (share.scope !== 'wardrobe' && !share.garmentIds.includes(body.garmentId)) {
      throw new HttpError('FORBIDDEN', '这件衣物不在分享范围内');
    }
    const result = await createSubmission({
      shareLinkId: share.shareLinkId,
      wardrobeId: share.wardrobeId,
      body,
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
      requestId: req.ctx?.requestId,
    });
    created(req, res, result);
  }),
);

/** 师傅凭原链接查自己的回填结果（含退回原因） */
sharePublicRouter.get(
  '/:token/submissions',
  requireShareToken,
  requireCollabShare,
  handler(async (req, res) => {
    const share = req.share!;
    const items = await prisma.repairSubmission.findMany({
      where: { shareLinkId: share.shareLinkId },
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true,
        status: true,
        collaborator: true,
        garmentId: true,
        submittedAt: true,
        reviewedAt: true,
        reviewNote: true,
        repairId: true,
        payload: true,
      },
    });
    ok(req, res, {
      items: items.map((s) => ({
        id: s.id,
        status: s.status,
        collaborator: s.collaborator,
        garmentId: s.garmentId,
        submittedAt: s.submittedAt,
        reviewedAt: s.reviewedAt,
        reviewNote: s.reviewNote,
        laborCost: (s.payload as Record<string, unknown>).laborCost ?? null,
      })),
    });
  }),
);

sharePublicRouter.get(
  '/:token/garment/:garmentId',
  requireShareToken,
  handler(async (req, res) => {
    const share = req.share!;
    if (share.scope !== 'wardrobe' && !share.garmentIds.includes(req.params.garmentId)) {
      throw new HttpError('FORBIDDEN', '这件衣物不在分享范围内');
    }
    const garment = await prisma.garment.findFirst({
      where: { id: req.params.garmentId, wardrobeId: share.wardrobeId, deletedAt: null },
    });
    if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');

    const [photos, damages] = await Promise.all([
      prisma.garmentPhoto.findMany({
        where: { garmentId: garment.id, deletedAt: null },
        include: { annotations: { include: { part: true, damageEvent: { include: { damageType: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.damageEvent.findMany({
        where: { garmentId: garment.id },
        include: {
          damageType: true,
          part: true,
          repairs: { include: { stitch: true, change: true, reviews: true } },
        },
        orderBy: { detectedAt: 'desc' },
      }),
    ]);
    const dataset = await loadDataset(share.wardrobeId, { includeRetired: true });
    const stats = computeAllGarmentStats(dataset).get(garment.id);

    // 协作模式：师傅只需要知道"有哪些破损可以挂接"，费用等隐私字段不下发
    const publicDamages =
      share.mode === 'collab'
        ? damages.map((d) => ({
            id: d.id,
            code: d.code,
            damageType: d.damageType,
            part: d.part,
            severity: d.severity,
            status: d.status,
            detectedAt: d.detectedAt,
            description: d.description,
          }))
        : damages;

    ok(req, res, {
      // 只读视图：不包含成本、收纳位置等隐私字段
      garment: {
        id: garment.id,
        code: garment.code,
        name: garment.name,
        category: garment.category,
        materialPrimary: garment.materialPrimary,
        knitOrWoven: garment.knitOrWoven,
        seasonTags: garment.seasonTags,
        color: garment.color,
        status: garment.status,
        careNote: garment.careNote,
      },
      photos,
      damages: publicDamages,
      summary: stats
        ? {
            wearCount: stats.wearCount,
            repairCount: stats.repairCount,
            recurrenceRate: stats.recurrenceRate,
            health: computeHealth(stats),
          }
        : null,
    });
  }),
);
