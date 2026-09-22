/**
 * 协作回填单的领域服务。
 *
 * 权限模型：
 *   - 师傅（匿名，持 collab 分享链接）只能创建 pending 单据，看不到任何成本/库存隐私字段；
 *   - 衣橱主人审批后，数据才在事务中并入 Repair / DamageEvent / FabricSource 等正式表；
 *   - 退回与通过都写审计日志，单据本体永久保留（含师傅原文 payload、IP/UA、审批意见）。
 */
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  collabSubmissionSchema,
  submissionApproveSchema,
} from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { addDays, parseDateOnly } from '../lib/date.js';
import { nextDamageCode } from '../lib/ids.js';
import { syncGarmentStatus } from './stats.js';
import { createReminderIfAbsent } from './rules/engine.js';
import { withUniqueRetry } from '../lib/prisma-errors.js';

export type CollabSubmissionInput = z.infer<typeof collabSubmissionSchema>;
export type SubmissionApproveInput = z.infer<typeof submissionApproveSchema>;

type MaterialRow = {
  description: string;
  amount: number;
  unit: string;
  unitCost?: number;
};

/** 师傅提交：只落 pending 单据，不动正式档案 */
export async function createSubmission(input: {
  shareLinkId: string;
  wardrobeId: string;
  body: CollabSubmissionInput;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}): Promise<{ id: string; status: string }> {
  const { body } = input;
  const garment = await prisma.garment.findFirst({
    where: { id: body.garmentId, wardrobeId: input.wardrobeId, deletedAt: null },
    select: { id: true, name: true, code: true },
  });
  if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在或不在分享范围内');

  if (body.damageEventId) {
    const damage = await prisma.damageEvent.findFirst({
      where: { id: body.damageEventId, garmentId: garment.id },
      select: { id: true, status: true },
    });
    if (!damage) throw new HttpError('NOT_FOUND', '破损记录不存在或不属于这件衣物');
  }

  if (body.newDamage) {
    const damageType = await prisma.damageType.findUnique({
      where: { code: body.newDamage.damageTypeCode },
      select: { id: true },
    });
    if (!damageType) throw new HttpError('VALIDATION_FAILED', '破损类型不在字典中，请重新选择');
  }

  const submission = await prisma.repairSubmission.create({
    data: {
      shareLinkId: input.shareLinkId,
      wardrobeId: input.wardrobeId,
      garmentId: garment.id,
      damageEventId: body.damageEventId ?? null,
      status: 'pending',
      collaborator: body.collaborator,
      contact: body.contact ?? null,
      payload: body as unknown as Prisma.InputJsonValue,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  await logActivity({
    wardrobeId: input.wardrobeId,
    actorId: input.shareLinkId,
    entityType: 'repair_submission',
    entityId: submission.id,
    action: 'submit',
    diff: {
      collaborator: body.collaborator,
      garment: garment.code,
      damageEventId: body.damageEventId ?? null,
      newDamage: body.newDamage?.damageTypeCode ?? null,
      laborCost: body.laborCost,
      materialCount: body.materials.length,
      ip: input.ip ?? null,
    },
    requestId: input.requestId,
  });

  await notifyOwner({
    wardrobeId: input.wardrobeId,
    submissionId: submission.id,
    title: `师傅回填待确认：${garment.name}`,
    body: `${body.collaborator} 提交了 ${garment.code} 的修补回填（工时费 ${body.laborCost} 元，用料 ${body.materials.length} 项），请核对后并入档案。`,
  });

  return { id: submission.id, status: submission.status };
}

/** 主人审批通过：在事务内生成正式破损（如需）与修补记录，并按决策处理用料/库存 */
export async function approveSubmission(input: {
  submissionId: string;
  wardrobeId: string;
  userId: string;
  email: string;
  body: SubmissionApproveInput;
  requestId?: string;
}) {
  const submission = await prisma.repairSubmission.findFirst({
    where: { id: input.submissionId, wardrobeId: input.wardrobeId },
  });
  if (!submission) throw new HttpError('NOT_FOUND', '回填单不存在');
  if (submission.status !== 'pending') {
    throw new HttpError('CONFLICT', `这张回填单已经${submission.status === 'approved' ? '确认并入' : '退回'}，不能重复处理`);
  }

  const payload = submission.payload as unknown as CollabSubmissionInput;

  // 1) 确定破损事件：师傅已选 → 以主人确认为准；师傅描述新破损且主人没改选 → 审批事务内新建
  let damageEventId = input.body.damageEventId ?? submission.damageEventId ?? undefined;
  let createdDamageId: string | null = null;
  let newDamageInfo: CollabSubmissionInput['newDamage'] = null;
  if (!damageEventId) {
    if (!payload.newDamage) throw new HttpError('VALIDATION_FAILED', '请确认这条修补对应哪条破损记录');
    // 校验字典项存在；真正的写库放进下面的事务，避免失败时留下孤儿破损
    const [damageType, part] = await Promise.all([
      prisma.damageType.findUniqueOrThrow({ where: { code: payload.newDamage.damageTypeCode } }),
      payload.newDamage.partCode ? prisma.part.findUnique({ where: { code: payload.newDamage.partCode } }) : null,
    ]);
    newDamageInfo = { ...payload.newDamage, damageTypeCode: damageType.code, partCode: part?.code ?? null };
  } else {
    const damage = await prisma.damageEvent.findFirst({
      where: { id: damageEventId, garmentId: submission.garmentId },
      include: { garment: true },
    });
    if (!damage) throw new HttpError('NOT_FOUND', '破损记录不存在或不属于这件衣物');
    if (damage.garment.status === 'retired') throw new HttpError('GARMENT_RETIRED', '衣物已退役，无法登记修补');
  }

  // 2) 针法必须映射到针法库
  const stitch = await prisma.stitch.findFirst({
    where: { id: input.body.stitchId },
    select: { id: true, name: true },
  });
  if (!stitch) throw new HttpError('NOT_FOUND', '针法不存在，请在针法库中选择');
  const secondaryStitches = input.body.stitchSecondaryIds.length
    ? await prisma.stitch.findMany({ where: { id: { in: input.body.stitchSecondaryIds } }, select: { id: true } })
    : [];
  if (secondaryStitches.length !== input.body.stitchSecondaryIds.length) {
    throw new HttpError('VALIDATION_FAILED', '辅针法中有不存在的记录');
  }

  // 3) 用料决策与 payload 下标对齐校验
  const materials = (payload.materials ?? []) as MaterialRow[];
  const decisions = input.body.materialDecisions ?? [];
  const seenIndexes = new Set<number>();
  for (const decision of decisions) {
    if (decision.index < 0 || decision.index >= materials.length) {
      throw new HttpError('VALIDATION_FAILED', `第 ${decision.index + 1} 条用料决策超出了师傅提交的用料范围`);
    }
    if (seenIndexes.has(decision.index)) throw new HttpError('VALIDATION_FAILED', '同一条用料不能重复处理');
    seenIndexes.add(decision.index);
    if (decision.action === 'inventory' && !decision.fabricSourceId) {
      throw new HttpError('VALIDATION_FAILED', `第 ${decision.index + 1} 条用料选择了库存布料，请指定布料来源`);
    }
  }

  const garment = await prisma.garment.findUniqueOrThrow({
    where: { id: submission.garmentId },
    select: { id: true, code: true, materialPrimary: true },
  });
  const careRuleForGarment = await prisma.careRule.findUnique({
    where: { materialCode: garment.materialPrimary },
  });

  const finishedAt = parseDateOnly(payload.finishedAt);
  const startedAt = payload.startedAt ? parseDateOnly(payload.startedAt) : finishedAt;
  const observationDays = careRuleForGarment?.observationDaysShop ?? 7;
  const observationUntil = addDays(finishedAt, observationDays);

  const result = await withUniqueRetry(() =>
    prisma.$transaction(async (tx) => {
      // 师傅描述的新破损在同一事务内创建：任一后续步骤失败都会一起回滚
      if (!damageEventId) {
        const info = newDamageInfo!;
        const damageType = await tx.damageType.findUniqueOrThrow({ where: { code: info.damageTypeCode } });
        const part = info.partCode ? await tx.part.findUnique({ where: { code: info.partCode } }) : null;
        const code = await nextDamageCode(submission.garmentId, garment.code, tx);
        const newDamage = await tx.damageEvent.create({
          data: {
            garmentId: submission.garmentId,
            code,
            damageTypeId: damageType.id,
            severity: info.severity,
            partId: part?.id ?? null,
            detectedAt: finishedAt,
            detectedSource: 'professional',
            description: `【师傅回填】${info.description}`,
            locationUnknown: !part,
            locationNote: !part ? `师傅 ${submission.collaborator} 回填，未在照片上定位` : null,
            status: 'pending',
            createdBy: input.userId,
          },
        });
        damageEventId = newDamage.id;
        createdDamageId = newDamage.id;
      }

      const existing = await tx.repair.findMany({
        where: { damageEventId: damageEventId! },
        orderBy: { round: 'desc' },
        take: 1,
      });
      const round = (existing[0]?.round ?? 0) + 1;

      const repair = await tx.repair.create({
        data: {
          damageEventId: damageEventId!,
          round,
          executedBy: 'tailor',
          shopName: payload.shopName ?? submission.collaborator,
          shopCost: payload.materialTotalCost || null,
          stitchId: stitch.id,
          stitchSecondaryIds: input.body.stitchSecondaryIds as Prisma.InputJsonValue,
          threadType: payload.threadType ?? null,
          threadColor: payload.threadColor ?? null,
          durationMinutes: payload.durationMinutes ?? null,
          cost: payload.laborCost,
          startedAt,
          finishedAt,
          observationDays,
          observationUntil,
          status: 'done',
          reuseOriginalFabric: payload.reuseOriginalFabric ?? false,
          note: buildRepairNote(payload, submission.collaborator, input.body.note),
          createdBy: input.userId,
        },
      });

      await tx.damageEvent.update({ where: { id: damageEventId! }, data: { status: 'repaired' } });
      await tx.reminder.updateMany({
        where: {
          subjectType: 'damage_event',
          subjectId: damageEventId!,
          status: { in: ['pending', 'notified'] },
        },
        data: { status: 'done', handledAt: new Date(), resultRef: { newRepairId: repair.id, round, viaSubmission: submission.id } },
      });
      // 回填待确认提醒随审批一并关闭，不残留待办
      await tx.reminder.updateMany({
        where: {
          subjectType: 'repair_submission',
          subjectId: submission.id,
          status: { in: ['pending', 'notified'] },
        },
        data: { status: 'done', handledAt: new Date(), resultRef: { repairId: repair.id, action: 'approved' } },
      });

      // 用料并入：inventory=扣既有库存；shop_supplied=师傅自带，登记一条布料来源但不动库存
      for (const decision of decisions) {
        const material = materials[decision.index];
        if (decision.action === 'skip') continue;
        if (decision.action === 'inventory') {
          const fabricSource = await tx.fabricSource.findFirst({
            where: { id: decision.fabricSourceId!, wardrobeId: input.wardrobeId },
            include: { inventory: true },
          });
          if (!fabricSource) throw new HttpError('NOT_FOUND', `第 ${decision.index + 1} 条用料对应的布料来源不存在`);
          if (!fabricSource.inventory) {
            throw new HttpError('VALIDATION_FAILED', `布料「${fabricSource.name}」没有登记库存，无法扣减`);
          }
          if (fabricSource.inventory.remainingAmount < material.amount) {
            throw new HttpError(
              'INVENTORY_INSUFFICIENT',
              `布料「${fabricSource.name}」余料不足：仅剩 ${fabricSource.inventory.remainingAmount}，本次需要 ${material.amount}`,
            );
          }
          await tx.repairMaterial.create({
            data: {
              repairId: repair.id,
              fabricSourceId: fabricSource.id,
              amount: material.amount,
              unit: fabricSource.inventory.unit,
              note: material.description,
            },
          });
          await tx.fabricInventory.update({
            where: { id: fabricSource.inventory.id },
            data: { remainingAmount: { decrement: material.amount } },
          });
          await tx.inventoryTxn.create({
            data: {
              inventoryId: fabricSource.inventory.id,
              repairId: repair.id,
              direction: 'consume',
              amount: material.amount,
              reason: `师傅回填单 ${submission.id} 审批并入：${material.description}`,
              createdBy: input.userId,
            },
          });
        } else {
          // shop_supplied：师傅自带面料，登记来源留痕，不建库存、不出账
          const fabricSource = await tx.fabricSource.create({
            data: {
              wardrobeId: input.wardrobeId,
              name: `${material.description}（${submission.collaborator}自带）`,
              kind: 'shop_supplied',
              materialPrimary: garment.materialPrimary,
              color: payload.threadColor ?? null,
              compositionNote: material.description,
              price: material.unitCost ? material.unitCost * material.amount : null,
              isActive: false,
            },
          });
          await tx.repairMaterial.create({
            data: {
              repairId: repair.id,
              fabricSourceId: fabricSource.id,
              amount: material.amount,
              unit: material.unit,
              note: `${material.description}（师傅自带，未占用衣橱库存）`,
            },
          });
        }
      }

      const updated = await tx.repairSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'approved',
          reviewedBy: input.userId,
          reviewedAt: new Date(),
          reviewNote: input.body.note ?? null,
          repairId: repair.id,
          damageEventId: damageEventId!,
        },
      });

      return { repair, round, updated, damageEventId: damageEventId!, createdDamageId };
    }),
  );

  await syncGarmentStatus(submission.garmentId);

  await logActivity({
    wardrobeId: input.wardrobeId,
    actorId: input.userId,
    entityType: 'repair_submission',
    entityId: submission.id,
    action: 'approve',
    diff: {
      repairId: result.repair.id,
      damageEventId: result.damageEventId,
      createdDamageId: result.createdDamageId,
      round: result.round,
      stitch: stitch.name,
      materialDecisions: decisions.map((d) => ({ index: d.index, action: d.action, fabricSourceId: d.fabricSourceId ?? null })),
    },
    requestId: input.requestId,
  });
  await logActivity({
    wardrobeId: input.wardrobeId,
    actorId: input.userId,
    entityType: 'repair',
    entityId: result.repair.id,
    action: 'create',
    diff: { viaSubmission: submission.id, collaborator: submission.collaborator, round: result.round, stitch: stitch.name },
    requestId: input.requestId,
  });

  return {
    repairId: result.repair.id,
    damageEventId: result.damageEventId,
    createdDamageId: result.createdDamageId,
    round: result.round,
  };
}

/** 主人退回：单据保留为 rejected，附退回原因，供师傅凭原链接查看 */
export async function rejectSubmission(input: {
  submissionId: string;
  wardrobeId: string;
  userId: string;
  reason: string;
  requestId?: string;
}) {
  const submission = await prisma.repairSubmission.findFirst({
    where: { id: input.submissionId, wardrobeId: input.wardrobeId },
  });
  if (!submission) throw new HttpError('NOT_FOUND', '回填单不存在');
  if (submission.status !== 'pending') {
    throw new HttpError('CONFLICT', '这张回填单已经处理过了');
  }
  const updated = await prisma.repairSubmission.update({
    where: { id: submission.id },
    data: { status: 'rejected', reviewedBy: input.userId, reviewedAt: new Date(), reviewNote: input.reason },
  });
  await prisma.reminder.updateMany({
    where: {
      subjectType: 'repair_submission',
      subjectId: submission.id,
      status: { in: ['pending', 'notified'] },
    },
    data: { status: 'done', handledAt: new Date(), resultRef: { action: 'rejected', reason: input.reason } },
  });
  await logActivity({
    wardrobeId: input.wardrobeId,
    actorId: input.userId,
    entityType: 'repair_submission',
    entityId: submission.id,
    action: 'reject',
    diff: { reason: input.reason, collaborator: submission.collaborator },
    requestId: input.requestId,
  });
  return updated;
}

function buildRepairNote(payload: CollabSubmissionInput, collaborator: string, ownerNote?: string | null): string {
  const lines = [`协作回填：师傅 ${collaborator}${payload.contact ? `（联系方式 ${payload.contact}）` : ''}`];
  if (payload.note) lines.push(`师傅备注：${payload.note}`);
  if (payload.stitchNameFallback && payload.stitchNameFallback !== payload.stitchCode) {
    lines.push(`师傅填写的针法：${payload.stitchCode}（${payload.stitchNameFallback}）`);
  }
  if (ownerNote) lines.push(`主人确认备注：${ownerNote}`);
  return lines.join('\n');
}

async function notifyOwner(params: { wardrobeId: string; submissionId: string; title: string; body: string }) {
  const wardrobe = await prisma.wardrobe.findUniqueOrThrow({
    where: { id: params.wardrobeId },
    select: { ownerId: true, owner: { select: { email: true } } },
  });
  await createReminderIfAbsent({
    wardrobeId: params.wardrobeId,
    userId: wardrobe.ownerId,
    subjectType: 'repair_submission',
    subjectId: params.submissionId,
    title: params.title,
    body: params.body,
    reason: '师傅通过限时协作链接提交了修补回填，需要衣橱主人核对后并入档案。',
    actionKind: 'review_submission',
    actionPayload: { submissionId: params.submissionId },
    dueAt: new Date(),
    expireAt: addDays(new Date(), 60),
    occurrenceKey: `collabsubmission:${params.submissionId}`,
    priority: 'high',
    notifyNow: true,
    email: wardrobe.owner.email,
  });
}
