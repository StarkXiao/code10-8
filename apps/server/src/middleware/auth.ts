import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { HttpError } from '../lib/errors.js';
import { verifyToken } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';

function extractToken(req: Request): string | null {
  const header = req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // 打印视图与 <img> 标签无法设置请求头，允许通过 query 传 token
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return null;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) throw new HttpError('AUTH_REQUIRED', '请先登录');
  const payload = verifyToken(token);
  req.ctx = {
    ...req.ctx,
    userId: payload.sub,
    wardrobeId: payload.wardrobeId,
    email: payload.email,
  };
  next();
}

/** 打印视图：允许匿名访问（只读），但必须带 token query */
export function allowTokenQuery(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    const payload = verifyToken(token);
    req.ctx = { ...req.ctx, userId: payload.sub, wardrobeId: payload.wardrobeId, email: payload.email };
  }
  next();
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 分享链接鉴权：token 只在 URL 出现一次，库里只存 sha256。
 * 支持范围限定（scope=garment 时只能看指定衣物）。
 */
export function requireShareToken(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    const raw = typeof req.params.token === 'string' ? req.params.token : '';
    if (!raw) throw new HttpError('AUTH_REQUIRED', '分享链接无效');
    const link = await prisma.shareLink.findUnique({ where: { tokenHash: hashShareToken(raw) } });
    if (!link || link.revokedAt) throw new HttpError('AUTH_REQUIRED', '分享链接已失效');
    if (link.expiresAt.getTime() < Date.now()) throw new HttpError('SHARE_LINK_EXPIRED', '分享链接已过期');
    await prisma.shareLink.update({
      where: { id: link.id },
      data: { accessCount: { increment: 1 }, lastAccessAt: new Date() },
    });
    req.share = {
      shareLinkId: link.id,
      wardrobeId: link.wardrobeId,
      scope: link.scope,
      mode: link.mode,
      garmentIds: Array.isArray(link.garmentIds) ? (link.garmentIds as string[]) : [],
    };
    next();
  })().catch(next);
}

export function assertGarmentInShare(share: NonNullable<Request['share']>, garmentId: string): void {
  if (share.scope === 'wardrobe') return;
  if (!share.garmentIds.includes(garmentId)) {
    throw new HttpError('FORBIDDEN', '该衣物不在分享范围内');
  }
}
