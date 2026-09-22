import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors.js';

/**
 * 协作链接是匿名入口，提交接口要防刷：
 * 单进程内存计数器（按 IP + 分享链接维度），窗口内超限直接拒绝。
 * 多实例部署时应换 Redis；当前单节点部署已足够。
 */
const WINDOW_MS = 10 * 60_000;
const MAX_HITS = 20;

type Hit = { count: number; resetAt: number };
const buckets = new Map<string, Hit>();

export function collabRateLimit(req: Request, _res: Response, next: NextFunction): void {
  const now = Date.now();
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const key = `${ip}:${req.share?.shareLinkId ?? req.params.token ?? 'noshare'}`;
  const hit = buckets.get(key);
  if (!hit || hit.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }
  hit.count += 1;
  if (hit.count > MAX_HITS) {
    next(new HttpError('RATE_LIMITED', '操作过于频繁，请稍后再试'));
    return;
  }
  next();
}

// 定时清理过期桶，避免 Map 无限增长
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of buckets) {
    if (hit.resetAt <= now) buckets.delete(key);
  }
}, WINDOW_MS);
cleaner.unref?.();
