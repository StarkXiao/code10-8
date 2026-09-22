import { prisma } from './prisma.js';
import type { Prisma } from '@prisma/client';

type DbClient = Prisma.TransactionClient | typeof prisma;

/** 衣物编号：G-YYYY-0001（衣橱内递增，可打印贴在洗标上） */
export async function nextGarmentCode(wardrobeId: string, client: DbClient = prisma): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `G-${year}-`;
  const last = await client.garment.findFirst({
    where: { wardrobeId, code: { startsWith: prefix } },
    orderBy: { code: 'desc' },
    select: { code: true },
  });
  const seq = last ? Number(last.code.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/** 破损事件编号：{衣物编号}-D01 */
export async function nextDamageCode(
  garmentId: string,
  garmentCode: string,
  client: DbClient = prisma,
): Promise<string> {
  const count = await client.damageEvent.count({ where: { garmentId } });
  return `${garmentCode}-D${String(count + 1).padStart(2, '0')}`;
}

export function randomInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
