import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  DAMAGE_TERMINAL_STATUSES,
  SHARE_INTAKE_STATUSES,
  shareIntakeConfirmSchema,
  shareIntakeCreateSchema,
  shareIntakeRejectSchema,
  shareLinkSchema,
  type DamageStatus,
} from '@gml/shared';
import type { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { addDays, parseDateOnly } from '../lib/date.js';
import { withUniqueRetry } from '../lib/prisma-errors.js';
import { assertGarmentInShare, requireAuth, requireShareToken } from '../middleware/auth.js';
import { resolvePublicOrigin } from '../lib/origin.js';
import { createReminderIfAbsent } from '../services/rules/engine.js';
import { computeAllGarmentStats, computeHealth, loadDataset, syncGarmentStatus } from '../services/stats.js';

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
        mode: body.mode,
        garmentIds: body.garmentIds,
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
      include: { _count: { select: { intakes: { where: { status: 'pending' } } } } },
      orderBy: { createdAt: 'desc' },
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
        expired: l.expiresAt.getTime() < Date.now(),
        pendingIntakes: l._count.intakes,
      })),
    });
  }),
);

// ---------------------------------------------------------------- 主人审核回填单

const intakeInclude = {
  garment: { select: { id: true, code: true, name: true } },
  damageEvent: { select: { id: true, code: true, damageType: { select: { name: true } } } },
  stitch: { select: { id: true, name: true } },
} satisfies Prisma.ShareIntakeInclude;

type IntakeWithRefs = Prisma.ShareIntakeGetPayload<{ include: typeof intakeInclude }>;

interface IntakeMaterialLine {
  name: string;
  amount?: number | null;
  unit?: string | null;
  note?: string | null;
}

function intakeLines(intake: { materials: Prisma.JsonValue }): IntakeMaterialLine[] {
  return Array.isArray(intake.materials) ? (intake.materials as unknown as IntakeMaterialLine[]) : [];
}

function formatLine(line: IntakeMaterialLine): string {
  const amount = typeof line.amount === 'number' ? ` ${line.amount}${line.unit ?? ''}` : '';
  return `${line.name}${amount}${line.note ? `（${line.note}）` : ''}`;
}

function intakeJson(i: IntakeWithRefs) {
  return {
    id: i.id,
    shareLinkId: i.shareLinkId,
    garmentId: i.garmentId,
    damageEventId: i.damageEventId,
    tailorName: i.tailorName,
    shopName: i.shopName,
    stitchId: i.stitchId,
    stitchName: i.stitch?.name ?? null,
    threadType: i.threadType,
    threadColor: i.threadColor,
    durationMinutes: i.durationMinutes,
    cost: i.cost?.toString() ?? null,
    materials: intakeLines(i),
    startedAt: i.startedAt,
    finishedAt: i.finishedAt,
    note: i.note,
    status: i.status,
    repairId: i.repairId,
    reviewNote: i.reviewNote,
    reviewedAt: i.reviewedAt,
    submittedAt: i.submittedAt,
    garmentName: i.garment.name,
    garmentCode: i.garment.code,
    damageCode: i.damageEvent.code,
    damageTypeName: i.damageEvent.damageType.name,
  };
}

shareRouter.get(
  '/intakes',
  handler(async (req, res) => {
    const query = parseQuery(z.object({ status: z.enum(SHARE_INTAKE_STATUSES).optional() }), req.query);
    const intakes = await prisma.shareIntake.findMany({
      where: { wardrobeId: req.ctx.wardrobeId, ...(query.status ? { status: query.status } : {}) },
      include: intakeInclude,
      orderBy: { submittedAt: 'desc' },
    });
    // 待确认的排最前，方便主人先处理
    const rank = (status: string) => (status === 'pending' ? 0 : status === 'confirmed' ? 1 : 2);
    intakes.sort((a, b) => rank(a.status) - rank(b.status) || b.submittedAt.getTime() - a.submittedAt.getTime());
    ok(req, res, { intakes: intakes.map(intakeJson) });
  }),
);

/**
 * 确认回填：在同一个事务里「抢占单据 → 生成正式 Repair → 推进破损状态 →
 * 映射用料扣库存 → 闭环相关提醒」，任何一步失败整体回滚，不会并出一半的档案。
 */
shareRouter.post(
  '/intakes/:id/confirm',
  handler(async (req, res) => {
    const intake = await prisma.shareIntake.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId },
      include: { damageEvent: { include: { garment: true, damageType: true } } },
    });
    if (!intake) throw new HttpError('NOT_FOUND', '回填单不存在');
    if (intake.status !== 'pending') throw new HttpError('CONFLICT', '这条回填单已经处理过了');
    const body = parseBody(shareIntakeConfirmSchema, req.body);

    const damage = intake.damageEvent;
    if (DAMAGE_TERMINAL_STATUSES.includes(damage.status as DamageStatus)) {
      throw new HttpError('DAMAGE_ALREADY_RESOLVED', '对应的破损已经闭环，无法再并入修补记录');
    }
    if (damage.garment.status === 'retired') throw new HttpError('GARMENT_RETIRED', '衣物已退役，无法登记修补');

    const stitchId = body.stitchId ?? intake.stitchId;
    if (!stitchId) {
      throw new HttpError('VALIDATION_FAILED', '师傅没有填写针法，请替他选择一种后再并入档案');
    }
    const stitch = await prisma.stitch.findUnique({ where: { id: stitchId } });
    if (!stitch) throw new HttpError('NOT_FOUND', '针法不存在');

    // 费用：未传沿用填报值；显式传 null 表示「无费用」
    const fee = body.cost === undefined ? (intake.cost === null ? null : Number(intake.cost)) : body.cost;
    const shopName = body.shopName ?? intake.shopName;

    // 用料映射：先把每一行与库存布料核对清楚，再进事务
    const lines = intakeLines(intake);
    const mappedIndexes = new Set<number>();
    const sourcesByIndex = new Map<number, { id: string; name: string; inventoryId: string; unit: string }>();
    for (const mapping of body.materialMappings) {
      const line = lines[mapping.index];
      if (!line) throw new HttpError('VALIDATION_FAILED', `用料第 ${mapping.index + 1} 行不存在`);
      if (mappedIndexes.has(mapping.index)) {
        throw new HttpError('VALIDATION_FAILED', `「${line.name}」被重复映射`);
      }
      if (typeof line.amount !== 'number' || line.amount <= 0) {
        throw new HttpError('VALIDATION_FAILED', `「${line.name}」没有填报数量，无法扣减库存，请保持「不映射」`);
      }
      const source = await prisma.fabricSource.findFirst({
        where: { id: mapping.fabricSourceId, wardrobeId: req.ctx.wardrobeId },
        include: { inventory: true },
      });
      if (!source) throw new HttpError('NOT_FOUND', '布料来源不存在');
      if (!source.inventory) {
        throw new HttpError('VALIDATION_FAILED', `「${source.name}」没有登记库存，请先在布料库存里补上数量`);
      }
      if (line.unit && line.unit !== source.inventory.unit) {
        throw new HttpError(
          'VALIDATION_FAILED',
          `「${line.name}」填报单位与「${source.name}」的库存单位不一致，无法直接扣减`,
        );
      }
      mappedIndexes.add(mapping.index);
      sourcesByIndex.set(mapping.index, {
        id: source.id,
        name: source.name,
        inventoryId: source.inventory.id,
        unit: source.inventory.unit,
      });
    }

    const careRule = await prisma.careRule.findUnique({
      where: { materialCode: damage.garment.materialPrimary },
    });
    const observationDays = body.observationDays ?? careRule?.observationDaysShop ?? 7;
    const finishedAt = intake.finishedAt;
    const observationUntil = addDays(finishedAt, observationDays);
    const executedBy = shopName ? 'shop' : 'tailor';

    const outcome = await withUniqueRetry(async () => {
      const latest = await prisma.repair.findMany({
        where: { damageEventId: damage.id },
        orderBy: { round: 'desc' },
        take: 1,
      });
      const round = (latest[0]?.round ?? 0) + 1;
      return prisma.$transaction(async (tx) => {
        // 抢占单据：只有仍是 pending 才能并入，双击/并发不会产生两条修补
        const claimed = await tx.shareIntake.updateMany({
          where: { id: intake.id, status: 'pending' },
          data: {
            status: 'confirmed',
            reviewedBy: req.ctx.userId,
            reviewedAt: new Date(),
            reviewNote: body.note ?? null,
          },
        });
        if (claimed.count === 0) throw new HttpError('CONFLICT', '这条回填单刚刚已被处理，请刷新查看');

        const unmapped = lines.filter((_, index) => !mappedIndexes.has(index));
        const noteParts = [
          intake.note ? `师傅备注：${intake.note}` : null,
          unmapped.length > 0 ? `师傅填报用料：${unmapped.map(formatLine).join('；')}` : null,
        ].filter((part): part is string => part !== null);

        const repair = await tx.repair.create({
          data: {
            damageEventId: damage.id,
            round,
            executedBy,
            shopName: shopName ?? null,
            shopCost: shopName ? fee : null,
            stitchId,
            threadType: intake.threadType,
            threadColor: intake.threadColor,
            durationMinutes: intake.durationMinutes,
            cost: shopName ? null : fee,
            startedAt: intake.startedAt ?? finishedAt,
            finishedAt,
            observationDays,
            observationUntil,
            status: 'done',
            note: noteParts.length > 0 ? noteParts.join('\n') : null,
            createdBy: req.ctx.userId,
          },
        });
        await tx.damageEvent.update({ where: { id: damage.id }, data: { status: 'repaired' } });
        // 这个破损的待办（返工提醒等）到此闭环
        await tx.reminder.updateMany({
          where: { subjectType: 'damage_event', subjectId: damage.id, status: { in: ['pending', 'notified'] } },
          data: { status: 'done', handledAt: new Date(), resultRef: { newRepairId: repair.id, round } as never },
        });
        // 映射的用料：扣库存 + 只增不改的流水
        for (const mapping of body.materialMappings) {
          const line = lines[mapping.index]!;
          const source = sourcesByIndex.get(mapping.index)!;
          const inventory = await tx.fabricInventory.findUniqueOrThrow({ where: { id: source.inventoryId } });
          if (inventory.remainingAmount < line.amount!) {
            throw new HttpError(
              'INVENTORY_INSUFFICIENT',
              `「${source.name}」余料不足：仅剩 ${inventory.remainingAmount}${inventory.unit}，本次需要 ${line.amount}${inventory.unit}`,
            );
          }
          await tx.repairMaterial.create({
            data: {
              repairId: repair.id,
              fabricSourceId: source.id,
              amount: line.amount!,
              unit: inventory.unit,
              note: line.note ?? null,
            },
          });
          await tx.fabricInventory.update({
            where: { id: inventory.id },
            data: { remainingAmount: { decrement: line.amount! } },
          });
          await tx.inventoryTxn.create({
            data: {
              inventoryId: inventory.id,
              repairId: repair.id,
              direction: 'consume',
              amount: line.amount!,
              reason: `协作回填并入（${intake.tailorName} 填报，第 ${round} 轮）`,
              createdBy: req.ctx.userId,
            },
          });
        }
        await tx.shareIntake.update({ where: { id: intake.id }, data: { repairId: repair.id } });
        // 「待确认」提醒闭环，回填结果引用
        await tx.reminder.updateMany({
          where: { subjectType: 'share_intake', subjectId: intake.id, status: { in: ['pending', 'notified'] } },
          data: {
            status: 'done',
            handledAt: new Date(),
            handledBy: req.ctx.userId,
            resultRef: { repairId: repair.id } as never,
          },
        });
        return { repair, round };
      });
    });

    await syncGarmentStatus(damage.garmentId);
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'repair',
      entityId: outcome.repair.id,
      action: 'create',
      diff: {
        damageEventId: damage.id,
        round: outcome.round,
        stitch: stitch.name,
        observationDays,
        source: 'share_intake',
        intakeId: intake.id,
      },
      requestId: req.ctx.requestId,
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'share_intake',
      entityId: intake.id,
      action: 'confirm',
      diff: {
        repairId: outcome.repair.id,
        tailorName: intake.tailorName,
        cost: fee,
        mappedMaterials: body.materialMappings.length,
      },
      requestId: req.ctx.requestId,
    });

    created(req, res, {
      repair: outcome.repair,
      intakeId: intake.id,
      nextStep: '已并入档案。接下来请补全「修补后变化」，再进入观察期。',
    });
  }),
);

shareRouter.post(
  '/intakes/:id/reject',
  handler(async (req, res) => {
    const intake = await prisma.shareIntake.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId },
    });
    if (!intake) throw new HttpError('NOT_FOUND', '回填单不存在');
    const body = parseBody(shareIntakeRejectSchema, req.body);
    const claimed = await prisma.shareIntake.updateMany({
      where: { id: intake.id, status: 'pending' },
      data: { status: 'rejected', reviewedBy: req.ctx.userId, reviewedAt: new Date(), reviewNote: body.note },
    });
    if (claimed.count === 0) throw new HttpError('CONFLICT', '这条回填单已经处理过了');
    await prisma.reminder.updateMany({
      where: { subjectType: 'share_intake', subjectId: intake.id, status: { in: ['pending', 'notified'] } },
      data: {
        status: 'done',
        handledAt: new Date(),
        handledBy: req.ctx.userId,
        resultRef: { rejected: true, note: body.note } as never,
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'share_intake',
      entityId: intake.id,
      action: 'reject',
      diff: { tailorName: intake.tailorName, note: body.note },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { rejected: true });
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
    ok(req, res, { revoked: true });
  }),
);

/** 访客入口：公开，但只能读到分享范围内的只读数据 */
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
    // 协作模式下师傅需要针法字典才能回填；字典是全局基线数据，不含任何主人隐私
    const stitches =
      link.mode === 'collaborate'
        ? await prisma.stitch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
        : [];
    ok(req, res, {
      wardrobeName: wardrobe.name,
      scope: share.scope,
      mode: link.mode,
      garments,
      expiresAt: link.expiresAt,
      stitches,
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
        include: { damageType: true, part: true, repairs: { include: { stitch: true, change: true, reviews: true } } },
        orderBy: { detectedAt: 'desc' },
      }),
    ]);
    const dataset = await loadDataset(share.wardrobeId, { includeRetired: true });
    const stats = computeAllGarmentStats(dataset).get(garment.id);

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
      damages,
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

/** 师傅凭协作链接提交「用料 + 费用」回填单，进入待确认队列 */
sharePublicRouter.post(
  '/:token/intakes',
  requireShareToken,
  handler(async (req, res) => {
    const share = req.share!;
    if (share.mode !== 'collaborate') {
      throw new HttpError('FORBIDDEN', '这个分享链接是只读的，不能提交回填');
    }
    const body = parseBody(shareIntakeCreateSchema, req.body);
    const damage = await prisma.damageEvent.findFirst({
      where: { id: body.damageEventId, garment: { wardrobeId: share.wardrobeId, deletedAt: null } },
      include: { garment: { select: { id: true, name: true } }, damageType: { select: { name: true } } },
    });
    if (!damage) throw new HttpError('NOT_FOUND', '破损记录不存在');
    assertGarmentInShare(share, damage.garmentId);
    if (DAMAGE_TERMINAL_STATUSES.includes(damage.status as DamageStatus)) {
      throw new HttpError('DAMAGE_ALREADY_RESOLVED', '这个破损已经闭环，无需回填');
    }
    if (body.stitchId) {
      const stitch = await prisma.stitch.findUnique({ where: { id: body.stitchId } });
      if (!stitch) throw new HttpError('NOT_FOUND', '针法不存在');
    }

    const intake = await prisma.shareIntake.create({
      data: {
        shareLinkId: share.shareLinkId,
        wardrobeId: share.wardrobeId,
        garmentId: damage.garmentId,
        damageEventId: damage.id,
        tailorName: body.tailorName,
        shopName: body.shopName ?? null,
        stitchId: body.stitchId ?? null,
        threadType: body.threadType ?? null,
        threadColor: body.threadColor ?? null,
        durationMinutes: body.durationMinutes ?? null,
        cost: body.cost ?? null,
        materials: body.materials as unknown as Prisma.InputJsonValue,
        startedAt: body.startedAt ? parseDateOnly(body.startedAt) : null,
        finishedAt: parseDateOnly(body.finishedAt),
        note: body.note ?? null,
      },
    });

    // 提醒主人来确认：提醒与回填单一一对应（occurrenceKey 幂等）
    const wardrobe = await prisma.wardrobe.findUniqueOrThrow({
      where: { id: share.wardrobeId },
      include: { owner: { select: { id: true, email: true } } },
    });
    await createReminderIfAbsent({
      wardrobeId: share.wardrobeId,
      userId: wardrobe.ownerId,
      subjectType: 'share_intake',
      subjectId: intake.id,
      title: `协作回填待确认：${damage.garment.name}`,
      body: `${body.tailorName} 通过协作链接回填了「${damage.damageType.name}」的用料与费用，确认后并入档案。`,
      reason: '分享链接为限时协作模式，访客在有效期内提交了回填单。',
      actionKind: 'open_share_intakes',
      actionPayload: { intakeId: intake.id },
      dueAt: new Date(),
      expireAt: addDays(new Date(), 30),
      occurrenceKey: `share-intake:${intake.id}`,
      priority: 'high',
      notifyNow: true,
      email: wardrobe.owner.email,
    });

    // 操作痕迹：访客没有账号，用 share:<linkId> 标识来源，师傅称呼留在 diff 里
    await logActivity({
      wardrobeId: share.wardrobeId,
      actorId: `share:${share.shareLinkId}`,
      entityType: 'share_intake',
      entityId: intake.id,
      action: 'create',
      diff: {
        tailorName: body.tailorName,
        garmentId: damage.garmentId,
        damageEventId: damage.id,
        cost: body.cost ?? null,
        materialCount: body.materials.length,
      },
      requestId: req.ctx.requestId,
    });

    created(req, res, {
      intake: { id: intake.id, status: intake.status, submittedAt: intake.submittedAt },
      nextStep: '已提交，等待衣橱主人确认后并入档案。',
    });
  }),
);

/** 师傅查看自己通过这条链接提交过的回填单及处理结果（痕迹对访客同样可查） */
sharePublicRouter.get(
  '/:token/intakes',
  requireShareToken,
  handler(async (req, res) => {
    const share = req.share!;
    const intakes = await prisma.shareIntake.findMany({
      where: { shareLinkId: share.shareLinkId },
      include: intakeInclude,
      orderBy: { submittedAt: 'desc' },
    });
    ok(req, res, { intakes: intakes.map(intakeJson) });
  }),
);
