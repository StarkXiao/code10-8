import { Router } from 'express';
import { z } from 'zod';
import {
  damageTypeCreateSchema,
  partCreateSchema,
  stitchCreateSchema,
  wardrobeUpdateSchema,
} from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import { handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { randomInviteCode } from '../lib/ids.js';
import { requireAuth } from '../middleware/auth.js';
import { computeOverview, loadDataset } from '../services/stats.js';
import { runReminderScan } from '../services/rules/engine.js';
import { logger } from '../lib/logger.js';

export const wardrobeRouter = Router();
wardrobeRouter.use(requireAuth);

wardrobeRouter.get(
  '/',
  handler(async (req, res) => {
    const wardrobe = await prisma.wardrobe.findUniqueOrThrow({ where: { id: req.ctx.wardrobeId } });
    const dataset = await loadDataset(req.ctx.wardrobeId, { includeRetired: true });
    const overview = computeOverview(dataset);

    const now = new Date();
    const [dueReminders, upcoming, orphanAnnotations] = await Promise.all([
      prisma.reminder.count({
        where: { wardrobeId: req.ctx.wardrobeId, status: { in: ['pending', 'notified'] }, dueAt: { lte: now } },
      }),
      prisma.reminder.count({
        where: {
          wardrobeId: req.ctx.wardrobeId,
          status: { in: ['pending', 'notified'] },
          dueAt: { gt: now },
        },
      }),
      prisma.photoAnnotation.count({
        where: { garment: { wardrobeId: req.ctx.wardrobeId, deletedAt: null }, status: 'draft' },
      }),
    ]);

    // SQLite 不支持字段间比较过滤，这里在应用层判断低库存
    const inventories = await prisma.fabricInventory.findMany({
      where: { fabricSource: { wardrobeId: req.ctx.wardrobeId, isActive: true } },
    });
    const inventoryAlerts = inventories.filter((i) => i.remainingAmount <= i.lowStockThreshold).length;

    ok(req, res, {
      wardrobe: {
        id: wardrobe.id,
        name: wardrobe.name,
        inviteCode: wardrobe.inviteCode,
        defaultReminderHour: wardrobe.defaultReminderHour,
      },
      overview,
      todos: { dueReminders, upcoming, inventoryAlerts, orphanAnnotations },
      needingAttention: dataset.garments
        .filter((g) => ['needs_repair', 'in_repair', 'observing'].includes(g.status))
        .slice(0, 8)
        .map((g) => ({ id: g.id, code: g.code, name: g.name, status: g.status, healthScore: g.healthScore })),
    });
  }),
);

wardrobeRouter.patch(
  '/',
  handler(async (req, res) => {
    const body = parseBody(wardrobeUpdateSchema, req.body);
    const wardrobe = await prisma.wardrobe.findUniqueOrThrow({ where: { id: req.ctx.wardrobeId } });
    if (wardrobe.ownerId !== req.ctx.userId) throw new HttpError('FORBIDDEN', '只有衣橱所有者可以修改设置');
    const updated = await prisma.wardrobe.update({ where: { id: wardrobe.id }, data: body });
    ok(req, res, { wardrobe: { id: updated.id, name: updated.name, defaultReminderHour: updated.defaultReminderHour } });
  }),
);

wardrobeRouter.post(
  '/invite-code/rotate',
  handler(async (req, res) => {
    const wardrobe = await prisma.wardrobe.findUniqueOrThrow({ where: { id: req.ctx.wardrobeId } });
    if (wardrobe.ownerId !== req.ctx.userId) throw new HttpError('FORBIDDEN', '只有衣橱所有者可以重置邀请码');
    const updated = await prisma.wardrobe.update({
      where: { id: wardrobe.id },
      data: { inviteCode: randomInviteCode() },
    });
    ok(req, res, { inviteCode: updated.inviteCode });
  }),
);

wardrobeRouter.post(
  '/join',
  handler(async (req, res) => {
    const body = parseBody(z.object({ inviteCode: z.string().min(4).max(16) }), req.body);
    const wardrobe = await prisma.wardrobe.findUnique({ where: { inviteCode: body.inviteCode.toUpperCase() } });
    if (!wardrobe) throw new HttpError('NOT_FOUND', '邀请码无效');
    await prisma.wardrobeMember.upsert({
      where: { wardrobeId_userId: { wardrobeId: wardrobe.id, userId: req.ctx.userId } },
      create: { wardrobeId: wardrobe.id, userId: req.ctx.userId, role: 'member' },
      update: {},
    });
    ok(req, res, { wardrobeId: wardrobe.id, name: wardrobe.name });
  }),
);

wardrobeRouter.get(
  '/members',
  handler(async (req, res) => {
    const members = await prisma.wardrobeMember.findMany({
      where: { wardrobeId: req.ctx.wardrobeId },
      include: { user: { select: { id: true, displayName: true, email: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    ok(req, res, {
      members: members.map((m) => ({
        userId: m.userId,
        displayName: m.user.displayName,
        email: m.user.email,
        role: m.role,
        joinedAt: m.joinedAt,
        isMe: m.userId === req.ctx.userId,
      })),
    });
  }),
);

wardrobeRouter.post(
  '/scan-reminders',
  handler(async (req, res) => {
    const result = await runReminderScan();
    logger.info(result, 'manual reminder scan');
    ok(req, res, result);
  }),
);

export const dictionaryRouter = Router();
dictionaryRouter.use(requireAuth);

dictionaryRouter.get(
  '/',
  handler(async (req, res) => {
    const [stitches, damageTypes, materials, careRules, parts] = await Promise.all([
      prisma.stitch.findMany({ orderBy: { name: 'asc' } }),
      prisma.damageType.findMany({ orderBy: { name: 'asc' } }),
      prisma.material.findMany({ orderBy: { durabilityScore: 'desc' } }),
      prisma.careRule.findMany(),
      prisma.part.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    ok(req, res, {
      stitches: stitches.map((s) => ({ ...s, isBuiltin: s.isBuiltin })),
      damageTypes,
      materials,
      careRules,
      parts: buildPartTree(parts),
      partsFlat: parts,
    });
  }),
);

dictionaryRouter.post(
  '/stitches',
  handler(async (req, res) => {
    const body = parseBody(stitchCreateSchema, req.body);
    const stitch = await prisma.stitch.create({
      data: {
        code: body.code,
        name: body.name,
        suitableFabrics: body.suitableFabrics,
        suitableDamageTypes: body.suitableDamageTypes,
        difficulty: body.difficulty,
        typicalMinutes: body.typicalMinutes ?? null,
        requiresMachine: body.requiresMachine,
        description: body.description,
        isBuiltin: false,
      },
    });
    ok(req, res, { stitch });
  }),
);

dictionaryRouter.post(
  '/damage-types',
  handler(async (req, res) => {
    const body = parseBody(damageTypeCreateSchema, req.body);
    const damageType = await prisma.damageType.create({
      data: {
        code: body.code,
        name: body.name,
        defaultSeverity: body.defaultSeverity,
        suggestedStitchCodes: body.suggestedStitchCodes,
        typicalCauses: body.typicalCauses,
        isBuiltin: false,
      },
    });
    ok(req, res, { damageType });
  }),
);

dictionaryRouter.post(
  '/parts',
  handler(async (req, res) => {
    const body = parseBody(partCreateSchema, req.body);
    const part = await prisma.part.create({
      data: {
        code: body.code,
        name: body.name,
        parentId: body.parentId ?? null,
        category: body.category ?? null,
        sortOrder: body.sortOrder,
        isBuiltin: false,
      },
    });
    ok(req, res, { part });
  }),
);

export const activityRouter = Router();
activityRouter.use(requireAuth);

activityRouter.get(
  '/',
  handler(async (req, res) => {
    const query = parseQuery(
      z.object({
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        action: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const logs = await prisma.activityLog.findMany({
      where: {
        wardrobeId: req.ctx.wardrobeId,
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.action ? { action: query.action } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    const actorIds = [...new Set(logs.map((l) => l.actorId))];
    const [actors, links] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, displayName: true },
      }),
      prisma.shareLink.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, mode: true },
      }),
    ]);
    const actorMap = new Map(actors.map((a) => [a.id, a.displayName]));
    const linkMap = new Map(links.map((l) => [l.id, l.mode === 'collab' ? '协作师傅（链接）' : '访客（分享链接）']));
    ok(req, res, {
      logs: logs.map((l) => ({
        ...l,
        actorName: actorMap.get(l.actorId) ?? linkMap.get(l.actorId) ?? '未知成员',
      })),
    });
  }),
);

interface PartRow {
  id: string;
  name: string;
  code: string;
  parentId: string | null;
  category: string | null;
  sortOrder: number;
  isBuiltin: boolean;
}

function buildPartTree(parts: PartRow[]) {
  const byId = new Map(parts.map((p) => [p.id, { ...p, children: [] as unknown[] }]));
  const roots: unknown[] = [];
  for (const part of parts) {
    const node = byId.get(part.id)!;
    if (part.parentId && byId.has(part.parentId)) {
      (byId.get(part.parentId)!.children as unknown[]).push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
