/**
 * 限时协作回填端到端回归：
 *   只读链接不能提交；师傅凭协作链接提交 pending 单；
 *   主人退回留痕、确认后并入正式修补/库存/审计；全部范围与过期校验生效。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const app = createApp();
let token = '';
let dictionary: Record<string, Array<Record<string, string>>> = {};
let approveCase: { garmentId: string; damageId: string; submissionId: string } | null = null;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = iso(new Date());

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

async function makeGarment(name: string): Promise<string> {
  const res = await auth(request(app).post('/api/garments'))
    .send({
      name,
      category: 'sweater',
      materialPrimary: 'wool',
      knitOrWoven: 'knit',
      seasonTags: ['winter'],
    })
    .expect(200);
  return res.body.data.garment.id;
}

async function makeDamage(garmentId: string): Promise<{ id: string }> {
  const damageTypeId = dictionary.damageTypes.find((d) => d.code === 'seam_open')!.id;
  const res = await auth(request(app).post('/api/damage-events'))
    .send({
      garmentId,
      damageTypeId,
      severity: 'minor',
      detectedAt: today,
      annotationIds: [],
      locationUnknown: true,
      locationNote: '袖口，拍照看不清',
    })
    .expect(201);
  return res.body.data.damage;
}

async function makeLink(mode: 'view' | 'collab', garmentIds: string[]): Promise<{ id: string; token: string }> {
  const res = await auth(request(app).post('/api/share-links'))
    .send({ scope: 'garment', mode, garmentIds, expiresInHours: 48 })
    .expect(201);
  return { id: res.body.data.id, token: res.body.data.token };
}

beforeAll(async () => {
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ email: `collab-${Date.now()}@example.com`, password: 'mending123', displayName: '协作测试主' })
    .expect(201);
  token = registered.body.data.token;
  dictionary = (await auth(request(app).get('/api/dictionary')).expect(200)).body.data;
});

describe('只读与协作链接', () => {
  it('只读链接可以读档案，但不能取字典/不能提交回填', async () => {
    const garmentId = await makeGarment('协作测试开衫');
    const view = await makeLink('view', [garmentId]);

    const meta = await request(app).get(`/api/share/${view.token}`).expect(200);
    expect(meta.body.data.mode).toBe('view');

    await request(app).get(`/api/share/${view.token}/dictionary`).expect(403);
    await request(app)
      .post(`/api/share/${view.token}/submissions`)
      .send({ garmentId, collaborator: '王师傅', stitchCode: 'backstitch', laborCost: 30, finishedAt: today })
      .expect(403);
  });

  it('协作链接提交缺字段时被 Zod 拦下', async () => {
    const garmentId = await makeGarment('协作测试毛衣');
    const collab = await makeLink('collab', [garmentId]);

    const res = await request(app)
      .post(`/api/share/${collab.token}/submissions`)
      .send({ garmentId, collaborator: '', stitchCode: 'backstitch', laborCost: 30, finishedAt: today })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');

    // 范围外衣物禁止提交
    const otherId = await makeGarment('不在范围里的衣物');
    await request(app)
      .post(`/api/share/${collab.token}/submissions`)
      .send({
        garmentId: otherId,
        collaborator: '王师傅',
        stitchCode: 'backstitch',
        laborCost: 30,
        finishedAt: today,
        newDamage: { damageTypeCode: 'seam_open', severity: 'minor', description: '袖口开线' },
      })
      .expect(403);
  });
});

describe('师傅回填 → 主人审批', () => {
  it('提交后落为 pending 单并给主人发提醒，师傅可凭链接查到状态', async () => {
    const garmentId = await makeGarment('送修羊绒衫');
    const damage = await makeDamage(garmentId);
    const collab = await makeLink('collab', [garmentId]);

    const dict = await request(app).get(`/api/share/${collab.token}/dictionary`).expect(200);
    expect(dict.body.data.stitches.length).toBeGreaterThan(0);

    const created = await request(app)
      .post(`/api/share/${collab.token}/submissions`)
      .send({
        garmentId,
        damageEventId: damage.id,
        collaborator: '巷口王师傅',
        contact: '13800000000',
        stitchCode: 'backstitch',
        durationMinutes: 40,
        laborCost: 50,
        materialTotalCost: 12,
        finishedAt: today,
        materials: [
          { description: '藏青羊毛线', amount: 500, unit: 'cm', unitCost: 0.02 },
        ],
        note: '袖口内侧加了衬线',
      })
      .expect(201);
    expect(created.body.data.status).toBe('pending');

    // 主人待办列表能看到
    const pending = await auth(request(app).get('/api/share-links/submissions/pending')).expect(200);
    const row = pending.body.data.items.find((i: { id: string }) => i.id === created.body.data.id);
    expect(row).toBeTruthy();
    expect(row.collaborator).toBe('巷口王师傅');

    // 产生了站内提醒
    const reminder = await prisma.reminder.findFirst({
      where: { subjectType: 'repair_submission', subjectId: created.body.data.id },
    });
    expect(reminder).not.toBeNull();
    expect(reminder!.actionKind).toBe('review_submission');

    // 师傅侧只看得到状态，看不到别人的数据
    const mine = await request(app).get(`/api/share/${collab.token}/submissions`).expect(200);
    expect(mine.body.data.items[0].status).toBe('pending');

    // 提交动作写了审计日志，actorId 是分享链接 id（匿名可追溯）
    const submitLog = await prisma.activityLog.findFirst({
      where: { entityType: 'repair_submission', action: 'submit', entityId: created.body.data.id },
    });
    expect(submitLog).not.toBeNull();
    expect(submitLog!.actorId).toBe(collab.id);

    // 暂存到模块级变量供后续用例
    approveCase = {
      garmentId,
      damageId: damage.id,
      submissionId: created.body.data.id,
    };
  });

  it('确认并入：生成正式修补、登记师傅自带用料、破损转已修补、单据与日志留痕', async () => {
    const { damageId, submissionId } = approveCase!;
    const detail = await auth(request(app).get(`/api/share-links/submissions/${submissionId}`)).expect(200);
    const stitchId = detail.body.data.candidates.stitches.find((s: { code: string }) => s.code === 'backstitch').id;

    const approved = await auth(request(app).post(`/api/share-links/submissions/${submissionId}/approve`))
      .send({
        damageEventId: damageId,
        stitchId,
        materialDecisions: [{ index: 0, action: 'shop_supplied' }],
        note: '费用与小票一致',
      })
      .expect(200);
    expect(approved.body.data.repairId).toBeTruthy();
    expect(approved.body.data.damageEventId).toBe(damageId);

    const repairRes = await auth(request(app).get(`/api/repairs/${approved.body.data.repairId}`)).expect(200);
    const repair = repairRes.body.data.repair;
    expect(repair.executedBy).toBe('tailor');
    expect(Number(repair.cost)).toBe(50);
    expect(repair.note).toContain('巷口王师傅');
    expect(repair.note).toContain('费用与小票一致');
    expect(repair.materials).toHaveLength(1);
    expect(repair.materials[0].note).toContain('藏青羊毛线');
    // 师傅自带的布料来源登记但不建库存
    const source = await prisma.fabricSource.findUniqueOrThrow({
      where: { id: repair.materials[0].fabricSourceId },
    });
    expect(source.kind).toBe('shop_supplied');
    expect(source.isActive).toBe(false);
    const inventory = await prisma.fabricInventory.findUnique({ where: { fabricSourceId: source.id } });
    expect(inventory).toBeNull();

    // 破损状态已流转
    const damage = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damageId } });
    expect(damage.status).toBe('repaired');

    // 单据结案
    const sub = await prisma.repairSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(sub.status).toBe('approved');
    expect(sub.repairId).toBe(repair.id);
    expect(sub.reviewNote).toBe('费用与小票一致');

    // 审计：approve + 正式 repair 创建
    const approveLog = await prisma.activityLog.findFirst({
      where: { entityType: 'repair_submission', action: 'approve', entityId: submissionId },
    });
    expect(approveLog).not.toBeNull();
    const repairLog = await prisma.activityLog.findFirst({
      where: { entityType: 'repair', action: 'create', entityId: repair.id },
    });
    expect(repairLog).not.toBeNull();
    expect((repairLog!.diff as { viaSubmission?: string }).viaSubmission).toBe(submissionId);

    // 重复审批被拒
    await auth(request(app).post(`/api/share-links/submissions/${submissionId}/approve`))
      .send({ stitchId })
      .expect(409);

    // 待确认提醒已随审批关闭
    const closedReminder = await prisma.reminder.findFirstOrThrow({
      where: { subjectType: 'repair_submission', subjectId: submissionId },
    });
    expect(closedReminder.status).toBe('done');
  });

  it('退回：状态变 rejected 并保留原因，师傅凭链接可见', async () => {
    const garmentId = await makeGarment('退回测试外套');
    const collab = await makeLink('collab', [garmentId]);

    const created = await request(app)
      .post(`/api/share/${collab.token}/submissions`)
      .send({
        garmentId,
        collaborator: '李师傅',
        stitchCode: 'invisible_stitch',
        laborCost: 80,
        materialTotalCost: 0,
        finishedAt: today,
        newDamage: { damageTypeCode: 'tear', severity: 'severe', description: '腋下撕裂约 3cm' },
      })
      .expect(201);

    // 退回必须给原因
    await auth(request(app).post(`/api/share-links/submissions/${created.body.data.id}/reject`))
      .send({ reason: '' })
      .expect(422);

    await auth(request(app).post(`/api/share-links/submissions/${created.body.data.id}/reject`))
      .send({ reason: '费用与微信转账对不上，请核对后重新提交' })
      .expect(200);

    const sub = await prisma.repairSubmission.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(sub.status).toBe('rejected');
    expect(sub.reviewNote).toContain('微信转账');
    // 退回不会偷偷建破损或修补
    expect(sub.repairId).toBeNull();
    const repairCount = await prisma.repair.count({ where: { damageEvent: { garmentId } } });
    expect(repairCount).toBe(0);

    const mine = await request(app).get(`/api/share/${collab.token}/submissions`).expect(200);
    const row = mine.body.data.items[0];
    expect(row.status).toBe('rejected');
    expect(row.reviewNote).toContain('微信转账');

    // 已处理的单子不能再退
    await auth(request(app).post(`/api/share-links/submissions/${created.body.data.id}/reject`))
      .send({ reason: 'x' })
      .expect(409);

    // 退回同样关闭待确认提醒
    const rejectedReminder = await prisma.reminder.findFirstOrThrow({
      where: { subjectType: 'repair_submission', subjectId: created.body.data.id },
    });
    expect(rejectedReminder.status).toBe('done');
  });

  it('确认并入并选择库存布料时，按提交用量扣减余料并记流水', async () => {
    const garmentId = await makeGarment('库存扣减牛仔裤');
    const damage = await makeDamage(garmentId);
    const collab = await makeLink('collab', [garmentId]);

    // 主人物色一块带库存的布料
    const sourceRes = await auth(request(app).post('/api/fabric-sources'))
      .send({
        name: '测试牛仔补丁布',
        kind: 'purchased_patch',
        materialPrimary: 'denim',
        inventory: { unit: 'cm2', initialAmount: 200, lowStockThreshold: 20 },
      })
      .expect(201);
    const fabricSourceId = sourceRes.body.data.fabricSource.id;

    const created = await request(app)
      .post(`/api/share/${collab.token}/submissions`)
      .send({
        garmentId,
        damageEventId: damage.id,
        collaborator: '赵师傅',
        stitchCode: 'darning_machine',
        laborCost: 0,
        materialTotalCost: 0,
        finishedAt: today,
        materials: [{ description: '膝盖补丁', amount: 50, unit: 'cm2' }],
      })
      .expect(201);

    const detail = await auth(request(app).get(`/api/share-links/submissions/${created.body.data.id}`)).expect(200);
    const stitchId = detail.body.data.candidates.stitches.find((s: { code: string }) => s.code === 'darning_machine').id;

    // 库存决策没选来源 → 422
    await auth(request(app).post(`/api/share-links/submissions/${created.body.data.id}/approve`))
      .send({ damageEventId: damage.id, stitchId, materialDecisions: [{ index: 0, action: 'inventory' }] })
      .expect(422);

    const approved = await auth(request(app).post(`/api/share-links/submissions/${created.body.data.id}/approve`))
      .send({
        damageEventId: damage.id,
        stitchId,
        materialDecisions: [{ index: 0, action: 'inventory', fabricSourceId }],
      })
      .expect(200);

    const inventoryAfter = await prisma.fabricInventory.findUniqueOrThrow({ where: { fabricSourceId } });
    expect(inventoryAfter.remainingAmount).toBe(150);
    const txn = await prisma.inventoryTxn.findFirst({
      where: { repairId: approved.body.data.repairId, direction: 'consume' },
    });
    expect(txn).not.toBeNull();
    expect(txn!.amount).toBe(50);
    expect(txn!.reason).toContain(created.body.data.id);
  });

  it('师傅描述了新破损且主人未改挂时，审批会自动新建破损记录', async () => {
    const garmentId = await makeGarment('新破损登记T恤');
    const collab = await makeLink('collab', [garmentId]);

    const created = await request(app)
      .post(`/api/share/${collab.token}/submissions`)
      .send({
        garmentId,
        collaborator: '陈师傅',
        stitchCode: 'patch_applique',
        laborCost: 25,
        materialTotalCost: 5,
        finishedAt: today,
        newDamage: { damageTypeCode: 'hole', severity: 'moderate', description: '肘部磨出小洞' },
      })
      .expect(201);

    const before = await prisma.damageEvent.count({ where: { garmentId } });
    expect(before).toBe(0);

    const detail = await auth(request(app).get(`/api/share-links/submissions/${created.body.data.id}`)).expect(200);
    const stitchId = detail.body.data.candidates.stitches.find((s: { code: string }) => s.code === 'patch_applique').id;
    const approved = await auth(request(app).post(`/api/share-links/submissions/${created.body.data.id}/approve`))
      .send({ stitchId, materialDecisions: [] })
      .expect(200);

    expect(approved.body.data.createdDamageId).toBeTruthy();
    const damage = await prisma.damageEvent.findUniqueOrThrow({
      where: { id: approved.body.data.createdDamageId },
      include: { damageType: true },
    });
    expect(damage.damageType.code).toBe('hole');
    expect(damage.detectedSource).toBe('professional');
    expect(damage.description).toContain('肘部磨出小洞');
    expect(damage.status).toBe('repaired');
  });
});
