/**
 * 限时协作回填集成测试：
 *   只读链接不能提交 → 协作链接提交回填（用料+费用）→ 主人收到提醒 →
 *   确认并入档案（库存扣减 / 未映射用料进备注）→ 并发确认不会并出两条 →
 *   驳回留痕 → 超出分享范围/链接失效被拒绝 → 操作日志完整。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const app = createApp();
let token = '';
let wardrobeId = '';
let dictionary: Record<string, Array<Record<string, string>>> = {};
let garmentId = '';
let damageId = '';
let damage2Id = '';
let readonlyToken = '';
let collabToken = '';
let collabLinkId = '';
let fabricSourceId = '';
let inventoryId = '';

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86_400_000));

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

async function makeDamage(note: string): Promise<string> {
  const response = await auth(request(app).post('/api/damage-events'))
    .send({
      garmentId,
      damageTypeId: dictionary.damageTypes.find((d) => d.code === 'seam_open')!.id,
      severity: 'moderate',
      detectedAt: daysAgo(3),
      locationUnknown: true,
      locationNote: note,
    })
    .expect(201);
  return response.body.data.damage.id as string;
}

beforeAll(async () => {
  const unique = `intake-${Date.now()}@example.com`;
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ email: unique, password: 'mending123', displayName: '衣橱主人' })
    .expect(201);
  token = registered.body.data.token;
  wardrobeId = registered.body.data.wardrobe.id;

  const dict = await auth(request(app).get('/api/dictionary')).expect(200);
  dictionary = dict.body.data;

  const garment = await auth(request(app).post('/api/garments'))
    .send({
      name: '协作测试牛仔裤',
      category: 'jeans',
      materialPrimary: 'denim',
      knitOrWoven: 'woven',
      seasonTags: ['spring', 'autumn'],
    })
    .expect(200);
  garmentId = garment.body.data.garment.id;

  damageId = await makeDamage('左膝内侧开线');
  damage2Id = await makeDamage('后腰缝开线');

  const source = await auth(request(app).post('/api/fabric-sources'))
    .send({
      name: '协作测试余料',
      kind: 'original_scrap',
      materialPrimary: 'denim',
      inventory: { unit: 'cm', initialAmount: 50, lowStockThreshold: 5 },
    })
    .expect(201);
  fabricSourceId = source.body.data.fabricSource.id;
  inventoryId = (await prisma.fabricInventory.findUniqueOrThrow({ where: { fabricSourceId } })).id;

  const readonly = await auth(request(app).post('/api/share-links'))
    .send({ scope: 'garment', garmentIds: [garmentId], expiresInHours: 48, mode: 'readonly' })
    .expect(201);
  readonlyToken = readonly.body.data.token;

  const collab = await auth(request(app).post('/api/share-links'))
    .send({ scope: 'garment', garmentIds: [garmentId], expiresInHours: 48, mode: 'collaborate' })
    .expect(201);
  collabToken = collab.body.data.token;
  collabLinkId = collab.body.data.id;
});

describe('限时协作回填', () => {
  it('协作链接元数据带 mode 与针法字典，只读链接不给字典', async () => {
    const collab = await request(app).get(`/api/share/${collabToken}`).expect(200);
    expect(collab.body.data.mode).toBe('collaborate');
    expect(collab.body.data.stitches.length).toBeGreaterThan(0);

    const readonly = await request(app).get(`/api/share/${readonlyToken}`).expect(200);
    expect(readonly.body.data.mode).toBe('readonly');
    expect(readonly.body.data.stitches).toEqual([]);
  });

  it('只读链接提交回填被拒绝', async () => {
    const response = await request(app)
      .post(`/api/share/${readonlyToken}/intakes`)
      .send({
        damageEventId: damageId,
        tailorName: '王师傅',
        finishedAt: iso(today),
      })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('师傅凭协作链接提交用料与费用，进入待确认队列并通知主人', async () => {
    const response = await request(app)
      .post(`/api/share/${collabToken}/intakes`)
      .send({
        damageEventId: damageId,
        tailorName: '王师傅',
        shopName: '巷口裁缝铺',
        stitchId: dictionary.stitches.find((s) => s.code === 'overcast')!.id,
        threadType: '涤纶线',
        threadColor: '靛蓝',
        durationMinutes: 40,
        cost: 25,
        startedAt: daysAgo(1),
        finishedAt: iso(today),
        materials: [
          { name: '原布余料', amount: 12, unit: 'cm', note: '主人自带那块' },
          { name: '拉链', note: '铺子配的' },
        ],
        note: '补完尽量少磨左膝',
      })
      .expect(201);
    expect(response.body.data.intake.status).toBe('pending');

    const list = await auth(request(app).get('/api/share-links/intakes?status=pending')).expect(200);
    const row = list.body.data.intakes.find(
      (i: { damageEventId: string }) => i.damageEventId === damageId,
    );
    expect(row).toBeTruthy();
    expect(row.tailorName).toBe('王师傅');
    expect(row.cost).toBe('25');
    expect(row.materials).toHaveLength(2);

    // 主人侧应收到「待确认」提醒，且点击动作为回填审核
    const reminders = await auth(request(app).get('/api/reminders?scope=all&limit=50')).expect(200);
    const reminder = reminders.body.data.items.find(
      (r: { subjectType: string; actionKind: string }) =>
        r.subjectType === 'share_intake' && r.actionKind === 'open_share_intakes',
    );
    expect(reminder).toBeTruthy();

    // 链接列表有待确认计数
    const links = await auth(request(app).get('/api/share-links')).expect(200);
    const link = links.body.data.links.find((l: { id: string }) => l.id === collabLinkId);
    expect(link.pendingIntakes).toBeGreaterThanOrEqual(1);
  });

  it('师傅本人能通过链接看到自己的回填与处理状态', async () => {
    const response = await request(app).get(`/api/share/${collabToken}/intakes`).expect(200);
    const rows = response.body.data.intakes as Array<{ damageEventId: string; status: string }>;
    expect(rows.some((r) => r.damageEventId === damageId && r.status === 'pending')).toBe(true);
  });

  it('回填不属于分享范围的破损被拒绝', async () => {
    // 另建一件不在分享范围内的衣物与破损
    const otherGarment = await auth(request(app).post('/api/garments'))
      .send({
        name: '未分享的衣物',
        category: 'shirt',
        materialPrimary: 'cotton',
        knitOrWoven: 'woven',
        seasonTags: ['summer'],
      })
      .expect(200);
    const otherDamage = await auth(request(app).post('/api/damage-events'))
      .send({
        garmentId: otherGarment.body.data.garment.id,
        damageTypeId: dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
        severity: 'minor',
        detectedAt: daysAgo(1),
        locationUnknown: true,
        locationNote: '袖口',
      })
      .expect(201);
    const response = await request(app)
      .post(`/api/share/${collabToken}/intakes`)
      .send({
        damageEventId: otherDamage.body.data.damage.id,
        tailorName: '王师傅',
        finishedAt: iso(today),
      })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('主人确认后生成正式修补：映射的用料扣库存，未映射的进备注', async () => {
    const pending = await auth(request(app).get('/api/share-links/intakes?status=pending')).expect(200);
    const intake = pending.body.data.intakes.find((i: { damageEventId: string }) => i.damageEventId === damageId);

    const before = await prisma.fabricInventory.findUniqueOrThrow({ where: { id: inventoryId } });
    expect(before.remainingAmount).toBe(50);

    const response = await auth(request(app).post(`/api/share-links/intakes/${intake.id}/confirm`))
      .send({
        materialMappings: [{ index: 0, fabricSourceId }],
        observationDays: 7,
      })
      .expect(201);
    const repairId = response.body.data.repair.id as string;

    // 正式修补并入：送店费用落到 shopCost，状态 done，破损推进为 repaired
    const repair = await auth(request(app).get(`/api/repairs/${repairId}`)).expect(200);
    expect(repair.body.data.repair.status).toBe('done');
    expect(repair.body.data.repair.executedBy).toBe('shop');
    expect(repair.body.data.repair.shopCost).toBe('25');
    expect(repair.body.data.repair.note).toContain('拉链');
    expect(repair.body.data.totalCost).toBe(25);

    // 库存扣减 + 流水
    const after = await prisma.fabricInventory.findUniqueOrThrow({ where: { id: inventoryId } });
    expect(after.remainingAmount).toBe(38);
    const txns = await auth(request(app).get(`/api/fabric-sources/${fabricSourceId}/txns`)).expect(200);
    expect(txns.body.data.txns.some((t: { reason: string; amount: number }) => t.amount === 12 && t.reason.includes('协作回填'))).toBe(true);

    // 回填单标记为已并入并挂上 repairId
    const confirmed = await auth(request(app).get('/api/share-links/intakes')).expect(200);
    const row = confirmed.body.data.intakes.find((i: { id: string }) => i.id === intake.id);
    expect(row.status).toBe('confirmed');
    expect(row.repairId).toBe(repairId);
  });

  it('对同一条回填单重复确认不会并出第二条修补', async () => {
    const confirmed = await auth(request(app).get('/api/share-links/intakes')).expect(200);
    const intake = confirmed.body.data.intakes.find((i: { damageEventId: string }) => i.damageEventId === damageId);
    const response = await auth(request(app).post(`/api/share-links/intakes/${intake.id}/confirm`))
      .send({ materialMappings: [] })
      .expect(409);
    expect(response.body.error.code).toBe('CONFLICT');

    const repairCount = await prisma.repair.count({ where: { damageEventId: damageId } });
    expect(repairCount).toBe(1);
  });

  it('库存不足时确认整体回滚：不生成修补、不扣库存、单据仍待确认', async () => {
    const submitted = await request(app)
      .post(`/api/share/${collabToken}/intakes`)
      .send({
        damageEventId: damage2Id,
        tailorName: '李师傅',
        stitchId: dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
        finishedAt: iso(today),
        cost: 10,
        materials: [{ name: '余料', amount: 999, unit: 'cm' }],
      })
      .expect(201);
    const intakeId = submitted.body.data.intake.id as string;

    const response = await auth(request(app).post(`/api/share-links/intakes/${intakeId}/confirm`))
      .send({ materialMappings: [{ index: 0, fabricSourceId }] })
      .expect(409);
    expect(response.body.error.code).toBe('INVENTORY_INSUFFICIENT');

    // 事务回滚：没有修补记录、库存没动、单据还是 pending
    expect(await prisma.repair.count({ where: { damageEventId: damage2Id } })).toBe(0);
    const inventory = await prisma.fabricInventory.findUniqueOrThrow({ where: { id: inventoryId } });
    expect(inventory.remainingAmount).toBe(38);
    const intake = await prisma.shareIntake.findUniqueOrThrow({ where: { id: intakeId } });
    expect(intake.status).toBe('pending');
  });

  it('驳回回填必须写原因，师傅侧能看到驳回意见', async () => {
    // 先验证空原因被拒
    const pending = await auth(request(app).get('/api/share-links/intakes?status=pending')).expect(200);
    const intake = pending.body.data.intakes.find((i: { damageEventId: string }) => i.damageEventId === damage2Id);

    const empty = await auth(request(app).post(`/api/share-links/intakes/${intake.id}/reject`))
      .send({ note: '' })
      .expect(422);
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');

    await auth(request(app).post(`/api/share-links/intakes/${intake.id}/reject`))
      .send({ note: '费用写错了，请按实收金额重填' })
      .expect(200);

    const visitor = await request(app).get(`/api/share/${collabToken}/intakes`).expect(200);
    const rows = visitor.body.data.intakes as Array<{ id: string; status: string; reviewNote: string | null }>;
    const row = rows.find((r) => r.id === intake.id);
    expect(row?.status).toBe('rejected');
    expect(row?.reviewNote).toContain('实收金额');
  });

  it('撤销链接后，师傅无法再提交', async () => {
    await auth(request(app).delete(`/api/share-links/${collabLinkId}`)).expect(200);
    const response = await request(app)
      .post(`/api/share/${collabToken}/intakes`)
      .send({ damageEventId: damage2Id, tailorName: '王师傅', finishedAt: iso(today) })
      .expect(401);
    expect(response.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('操作日志完整保留访客提交与主人确认/驳回痕迹', async () => {
    const logs = await auth(request(app).get('/api/activity-logs?entityType=share_intake&limit=50')).expect(200);
    const actions = (logs.body.data.logs as Array<{ action: string; actorName: string }>).map((l) => ({
      action: l.action,
      actorName: l.actorName,
    }));
    expect(actions.some((a) => a.action === 'create' && a.actorName === '访客·分享链接')).toBe(true);
    expect(actions.some((a) => a.action === 'confirm')).toBe(true);
    expect(actions.some((a) => a.action === 'reject')).toBe(true);

    // 并入的修补也有一条 create 日志，并记录来源是协作回填
    const repairLogs = await auth(request(app).get('/api/activity-logs?entityType=repair&limit=50')).expect(200);
    const fromIntake = (repairLogs.body.data.logs as Array<{ diff: { source?: string } }>).some(
      (l) => l.diff?.source === 'share_intake',
    );
    expect(fromIntake).toBe(true);
  });
});
