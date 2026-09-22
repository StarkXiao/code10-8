-- 只读分享升级为限时协作：
--   1) share_links.mode 标记链接是只读(view)还是协作回填(collab)
--   2) repair_submissions 保存师傅凭链接回填的用料与费用，主人审批后才并入正式档案
-- 注意：SQLite 历史库由 scripts/migrate.mjs 的幂等补丁应用；本文件供 migrate deploy 与审阅。

ALTER TABLE "share_links" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'view';

CREATE TABLE "repair_submissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "share_link_id" TEXT NOT NULL,
    "wardrobe_id" TEXT NOT NULL,
    "garment_id" TEXT NOT NULL,
    "damage_event_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "collaborator" TEXT NOT NULL,
    "contact" TEXT,
    "payload" JSONB NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "submitted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" TEXT,
    "reviewed_at" DATETIME,
    "review_note" TEXT,
    "repair_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "repair_submissions_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repair_submissions_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "repair_submissions_wardrobe_id_status_idx" ON "repair_submissions"("wardrobe_id", "status");
CREATE INDEX "repair_submissions_share_link_id_idx" ON "repair_submissions"("share_link_id");
