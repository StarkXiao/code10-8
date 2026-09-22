<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  MATERIAL_PRIMARY_LABEL,
  REMINDER_CHANNELS,
  REMINDER_TRIGGER_KIND_LABEL,
  type MaterialPrimary,
  type ReminderChannel,
  type ReminderTriggerKind,
} from '@gml/shared';
import { getToken, messageOf } from '../api/client';
import { authApi, garmentApi, reminderApi, shareApi, wardrobeApi } from '../api';
import { useSessionStore } from '../stores/session';
import type { DictionaryResponse, GarmentListItem, ReminderRuleRow, ShareLinkRow } from '../types';
import EmptyState from '../components/EmptyState.vue';

const session = useSessionStore();
const router = useRouter();
const tab = ref('account');
const dict = ref<DictionaryResponse | null>(null);
const rules = ref<ReminderRuleRow[]>([]);
const links = ref<ShareLinkRow[]>([]);
const members = ref<Array<{ userId: string; displayName: string; email: string; role: string; isMe: boolean }>>([]);
const logs = ref<Array<Record<string, unknown>>>([]);
const garments = ref<GarmentListItem[]>([]);
const busy = ref(false);

const profile = reactive({ displayName: '', timezone: '', reminderHour: 9 });
const wardrobeForm = reactive({ name: '' });
const newRule = reactive({
  name: '每年 5 月检查全部亚麻衣物',
  triggerKind: 'custom' as ReminderTriggerKind,
  months: [5],
  message: '换季前检查亚麻衣物的缝合处与前襟折痕',
  channel: 'inapp' as ReminderChannel,
});
const shareForm = reactive({ garmentIds: [] as string[], expiresInHours: 72, mode: 'readonly' });

const currentUserId = computed(() => session.user?.id ?? '');

onMounted(async () => {
  profile.displayName = session.user?.displayName ?? '';
  profile.timezone = session.user?.timezone ?? 'Asia/Shanghai';
  profile.reminderHour = session.user?.reminderHour ?? 9;
  wardrobeForm.name = session.wardrobe?.name ?? '';
  await Promise.all([loadDictionary(), loadRules(), loadLinks(), loadMembers(), loadLogs(), loadGarments()]);
});

async function loadDictionary(): Promise<void> {
  dict.value = await wardrobeApi.dictionary();
}

async function loadRules(): Promise<void> {
  rules.value = (await reminderApi.rules()).rules;
}

async function loadLinks(): Promise<void> {
  links.value = (await shareApi.list()).links;
}

async function loadMembers(): Promise<void> {
  members.value = (await wardrobeApi.members()).members;
}

async function loadLogs(): Promise<void> {
  logs.value = (await wardrobeApi.activityLogs({ limit: 50 })).logs;
}

async function loadGarments(): Promise<void> {
  garments.value = (await garmentApi.list({ pageSize: 100 })).items;
}

async function saveProfile(): Promise<void> {
  busy.value = true;
  try {
    await authApi.updateProfile({ ...profile });
    ElMessage.success('已保存');
    await session.bootstrap();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function saveWardrobe(): Promise<void> {
  try {
    await wardrobeApi.update({ name: wardrobeForm.name });
    ElMessage.success('已保存');
    await session.bootstrap();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function rotateInvite(): Promise<void> {
  try {
    const result = await wardrobeApi.rotateInvite();
    ElMessage.success(`新邀请码：${result.inviteCode}`);
    await session.bootstrap();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function toggleRule(rule: ReminderRuleRow): Promise<void> {
  try {
    await reminderApi.updateRule(rule.id, { isEnabled: !rule.isEnabled });
    await loadRules();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function removeRule(rule: ReminderRuleRow): Promise<void> {
  try {
    await reminderApi.deleteRule(rule.id);
    ElMessage.success(rule.isBuiltin ? '内置规则已停用（历史提醒保留）' : '规则已删除');
    await loadRules();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function createRule(): Promise<void> {
  try {
    await reminderApi.createRule({
      name: newRule.name,
      triggerKind: newRule.triggerKind,
      params: { mode: 'periodic', months: newRule.months, message: newRule.message },
      scopeFilter: {},
      scheduleCron: '0 * * * *',
      channel: newRule.channel,
      priority: 'normal',
      isEnabled: true,
    });
    ElMessage.success('规则已创建，下一次扫描生效');
    await loadRules();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function createShareLink(): Promise<void> {
  if (shareForm.garmentIds.length === 0) {
    ElMessage.warning('请选择要分享的衣物');
    return;
  }
  try {
    const result = await shareApi.create({
      scope: 'garment',
      garmentIds: shareForm.garmentIds,
      expiresInHours: shareForm.expiresInHours,
      mode: shareForm.mode,
    });
    try {
      await navigator.clipboard.writeText(result.url);
      ElMessage.success(shareForm.mode === 'collaborate' ? '已生成限时协作链接并复制到剪贴板' : '已生成只读链接并复制到剪贴板');
    } catch {
      ElMessage.success(`链接：${result.url}`);
    }
    await loadLinks();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function revokeLink(id: string): Promise<void> {
  try {
    await shareApi.revoke(id);
    ElMessage.success('已撤销');
    await loadLinks();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function download(url: string): void {
  window.open(`${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken())}`, '_blank');
}

async function importBackup(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    await ElMessageBox.confirm('恢复备份会覆盖当前数据库，需要重启服务才生效。继续？', '危险操作', { type: 'warning' });
  } catch {
    return;
  }
  const form = new FormData();
  form.append('file', file);
  try {
    const response = await fetch('/api/export/import?confirm=OVERWRITE', {
      method: 'POST',
      headers: { authorization: `Bearer ${getToken()}` },
      body: form,
    });
    const json = (await response.json()) as { data?: { note?: string }; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message);
    ElMessage.success(json.data?.note ?? '已恢复，请重启服务');
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    input.value = '';
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">设置</h1>
        <div class="page-subtitle">账号、衣橱、提醒规则、分享、字典与数据备份</div>
      </div>
    </div>

    <el-tabs v-model="tab">
      <el-tab-pane label="账号与衣橱" name="account">
        <el-card shadow="never" style="max-width: 560px">
          <template #header>个人资料</template>
          <el-form label-width="110px">
            <el-form-item label="称呼">
              <el-input v-model="profile.displayName" />
            </el-form-item>
            <el-form-item label="邮箱">
              <el-input :model-value="session.user?.email" disabled />
            </el-form-item>
            <el-form-item label="时区">
              <el-input v-model="profile.timezone" />
              <div class="field-hint">提醒按这个时区计算"今天"，避免跨零点漏提醒</div>
            </el-form-item>
            <el-form-item label="提醒时间">
              <el-input-number v-model="profile.reminderHour" :min="0" :max="23" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="busy" @click="saveProfile">保存</el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" style="max-width: 560px; margin-top: 12px">
          <template #header>衣橱</template>
          <el-form label-width="110px">
            <el-form-item label="名称">
              <el-input v-model="wardrobeForm.name" />
            </el-form-item>
            <el-form-item label="邀请码">
              <el-input :model-value="session.wardrobe?.inviteCode" readonly style="width: 200px" />
              <el-button style="margin-left: 8px" @click="rotateInvite">重置</el-button>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="saveWardrobe">保存</el-button>
            </el-form-item>
          </el-form>
          <el-divider />
          <div class="muted" style="margin-bottom: 6px">成员（{{ members.length }}）</div>
          <div v-for="member in members" :key="member.userId" class="muted">
            {{ member.displayName }}（{{ member.email }}）· {{ member.role === 'owner' ? '所有者' : '成员' }}
            <span v-if="member.userId === currentUserId"> · 我</span>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="提醒规则" name="rules">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <span>规则列表（{{ rules.length }}）</span>
              <el-button
                size="small"
                @click="
                  reminderApi.runNow().then((result) => {
                    ElMessage.success(`新增 ${result.created} 条，推送 ${result.notified} 条`);
                    loadRules();
                  })
                "
              >
                立刻扫描
              </el-button>
            </div>
          </template>
          <el-table :data="rules" size="small">
            <el-table-column label="规则" min-width="180">
              <template #default="{ row }">
                <div>{{ row.name }}</div>
                <div class="muted" style="font-size: 12px">
                  {{ REMINDER_TRIGGER_KIND_LABEL[row.triggerKind as ReminderTriggerKind] }}
                  <span v-if="row.isBuiltin"> · 内置</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="触发参数" min-width="200">
              <template #default="{ row }">
                <span class="mono" style="font-size: 12px">{{ JSON.stringify(row.params) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="渠道" width="120">
              <template #default="{ row }">
                {{ REMINDER_CHANNELS.includes(row.channel as ReminderChannel) ? row.channel : row.channel }}
              </template>
            </el-table-column>
            <el-table-column label="已产生" width="90">
              <template #default="{ row }">{{ row.reminderCount }}</template>
            </el-table-column>
            <el-table-column label="启用" width="80">
              <template #default="{ row }">
                <el-switch :model-value="row.isEnabled" @change="toggleRule(row)" />
              </template>
            </el-table-column>
            <el-table-column width="80">
              <template #default="{ row }">
                <el-button link type="danger" @click="removeRule(row)">{{ row.isBuiltin ? '停用' : '删除' }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px; max-width: 620px">
          <template #header>新增自定义周期规则</template>
          <el-form label-width="110px">
            <el-form-item label="规则名">
              <el-input v-model="newRule.name" />
            </el-form-item>
            <el-form-item label="触发月份">
              <el-select v-model="newRule.months" multiple style="width: 100%">
                <el-option v-for="m in 12" :key="m" :value="m" :label="`${m} 月`" />
              </el-select>
            </el-form-item>
            <el-form-item label="提醒内容">
              <el-input v-model="newRule.message" type="textarea" :rows="2" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="createRule">创建</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="分享" name="share">
        <el-card shadow="never" style="max-width: 720px">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <span>生成分享链接（给裁缝 / 干洗店 / 家人）</span>
              <el-button
                v-if="links.some((l) => l.pendingIntakes > 0)"
                type="primary"
                size="small"
                @click="router.push({ name: 'share-intakes' })"
              >
                {{ links.reduce((sum, l) => sum + l.pendingIntakes, 0) }} 条回填待确认
              </el-button>
            </div>
          </template>
          <el-form label-width="110px">
            <el-form-item label="衣物范围">
              <el-select v-model="shareForm.garmentIds" multiple filterable style="width: 100%" placeholder="选择要分享的衣物">
                <el-option v-for="item in garments" :key="item.id" :value="item.id" :label="`${item.name}（${item.code}）`" />
              </el-select>
            </el-form-item>
            <el-form-item label="权限">
              <el-radio-group v-model="shareForm.mode">
                <el-radio label="readonly">只读查看</el-radio>
                <el-radio label="collaborate">限时协作</el-radio>
              </el-radio-group>
              <div class="field-hint">
                只读：对方只能查看档案（不含成本与收纳位置）；限时协作：师傅可在有效期内回填用料与费用，需你确认后才并入档案
              </div>
            </el-form-item>
            <el-form-item label="有效期(小时)">
              <el-input-number v-model="shareForm.expiresInHours" :min="1" :max="8760" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="createShareLink">生成并复制链接</el-button>
              <el-button @click="router.push({ name: 'share-intakes' })">查看回填记录</el-button>
            </el-form-item>
          </el-form>
          <el-divider />
          <EmptyState v-if="links.length === 0" title="还没有分享链接" />
          <el-table v-else :data="links" size="small">
            <el-table-column label="权限" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="row.mode === 'collaborate' ? 'warning' : 'info'">
                  {{ row.mode === 'collaborate' ? '限时协作' : '只读' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="范围" width="110">
              <template #default="{ row }">
                {{ row.scope === 'wardrobe' ? '整个衣橱' : `${row.garmentIds.length} 件衣物` }}
              </template>
            </el-table-column>
            <el-table-column label="过期时间" width="180">
              <template #default="{ row }">{{ String(row.expiresAt).slice(0, 16).replace('T', ' ') }}</template>
            </el-table-column>
            <el-table-column label="访问" width="80" prop="accessCount" />
            <el-table-column label="待确认" width="80">
              <template #default="{ row }">
                <el-button v-if="row.pendingIntakes > 0" link type="primary" @click="router.push({ name: 'share-intakes' })">
                  {{ row.pendingIntakes }}
                </el-button>
                <span v-else class="muted">0</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.expired ? 'info' : 'success'">{{ row.expired ? '已过期' : '有效' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column>
              <template #default="{ row }">
                <el-button link type="danger" @click="revokeLink(row.id)">撤销</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="字典" name="dictionary">
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-card shadow="never">
              <template #header>针法库（{{ dict?.stitches.length ?? 0 }}）</template>
              <el-table :data="dict?.stitches ?? []" size="small" max-height="360">
                <el-table-column prop="name" label="针法" width="130" />
                <el-table-column label="适用结构" width="140">
                  <template #default="{ row }">{{ (row.suitableFabrics as string[]).join('/') }}</template>
                </el-table-column>
                <el-table-column label="难度" width="80" prop="difficulty" />
                <el-table-column label="参考耗时" width="110">
                  <template #default="{ row }">{{ row.typicalMinutes ?? '—' }} 分钟</template>
                </el-table-column>
                <el-table-column label="需机器" width="80">
                  <template #default="{ row }">{{ row.requiresMachine ? '是' : '否' }}</template>
                </el-table-column>
              </el-table>
            </el-card>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-card shadow="never">
              <template #header>材质护理库（{{ dict?.materials.length ?? 0 }}）</template>
              <el-table :data="dict?.materials ?? []" size="small" max-height="360">
                <el-table-column label="材质" width="90">
                  <template #default="{ row }">{{ MATERIAL_PRIMARY_LABEL[row.code as MaterialPrimary] ?? row.name }}</template>
                </el-table-column>
                <el-table-column label="耐久" width="70" prop="durabilityScore" />
                <el-table-column prop="washAdvice" label="清洗建议" />
                <el-table-column label="薄弱部位" width="150">
                  <template #default="{ row }">{{ (row.typicalWeakPoints as string[]).join('、') || '—' }}</template>
                </el-table-column>
              </el-table>
            </el-card>
          </el-col>
        </el-row>
        <el-card shadow="never" style="margin-top: 12px">
          <template #header>破损类型（{{ dict?.damageTypes.length ?? 0 }}）</template>
          <el-table :data="dict?.damageTypes ?? []" size="small" max-height="320">
            <el-table-column prop="name" label="类型" width="120" />
            <el-table-column prop="defaultSeverity" label="默认严重度" width="120" />
            <el-table-column label="建议针法" min-width="200">
              <template #default="{ row }">
                {{ (row.suggestedStitchCodes as string[]).join(' → ') || '不可缝补（走处置流程）' }}
              </template>
            </el-table-column>
            <el-table-column label="常见原因">
              <template #default="{ row }">{{ (row.typicalCauses as string[]).join('、') }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="数据与审计" name="data">
        <el-card shadow="never" style="max-width: 760px">
          <template #header>导出与备份</template>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <el-button @click="download('/api/export/wardrobe.csv?dataset=garments')">导出衣物 CSV</el-button>
            <el-button @click="download('/api/export/wardrobe.csv?dataset=damages')">导出破损 CSV</el-button>
            <el-button @click="download('/api/export/wardrobe.csv?dataset=repairs')">导出修补 CSV</el-button>
            <el-button @click="download('/api/export/wardrobe.csv?dataset=wears')">导出穿着 CSV</el-button>
            <el-button type="primary" @click="download('/api/export/backup')">下载全量备份 zip</el-button>
          </div>
          <div class="muted" style="margin-top: 8px">
            备份包含数据库文件、全部照片与 JSON 数据，可直接搬到另一台机器恢复。
          </div>
          <el-divider />
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <input type="file" accept=".zip" @change="importBackup" />
            <span class="muted">恢复备份会覆盖当前数据（会自动留一份 .before-restore.bak，需重启服务生效）</span>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>操作日志（最近 50 条）</template>
          <el-table :data="logs" size="small" max-height="420">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ String(row.createdAt).slice(0, 19).replace('T', ' ') }}</template>
            </el-table-column>
            <el-table-column prop="actorName" label="操作者" width="100" />
            <el-table-column prop="entityType" label="对象" width="160" />
            <el-table-column prop="action" label="动作" width="110" />
            <el-table-column label="详情">
              <template #default="{ row }">
                <span class="mono" style="font-size: 12px">{{ JSON.stringify(row.diff) }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px; max-width: 760px">
          <template #header>数据完整性</template>
          <div class="muted">
            在服务器上运行 <span class="mono">npm run verify:media</span> 可校验每张照片的 sha256 与数据库记录是否一致，输出丢失与损坏清单。<br />
            命令行恢复：<span class="mono">npm run restore -- &lt;zip路径&gt;</span>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
