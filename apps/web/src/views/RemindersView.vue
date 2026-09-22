<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import {
  DISMISS_REASONS,
  DISMISS_REASON_LABEL,
  REMINDER_ACTION_KIND_LABEL,
  REMINDER_STATUS_LABEL,
} from '@gml/shared';
import { reminderApi } from '../api';
import { messageOf } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import type { DismissReason, ReminderActionKind, ReminderStatus } from '@gml/shared';
import type { ReminderItem, ReminderSummary } from '../types';

const router = useRouter();
const queryClient = useQueryClient();
const scope = ref<'today' | 'overdue' | 'upcoming' | 'done' | 'expired' | 'all'>('today');
const items = ref<ReminderItem[]>([]);
const summary = ref<ReminderSummary | null>(null);
const busy = ref(false);
const loading = ref(false);

const grouped = computed(() => ({
  overdue: items.value.filter((r) => r.isOverdue && ['pending', 'notified'].includes(r.status)),
  due: items.value.filter((r) => !r.isOverdue && ['pending', 'notified'].includes(r.status)),
  handled: items.value.filter((r) => !['pending', 'notified'].includes(r.status)),
}));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [list, sum] = await Promise.all([reminderApi.list({ scope: scope.value, limit: 100 }), reminderApi.summary()]);
    items.value = list.items;
    summary.value = sum;
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(scope, load);

async function complete(reminder: ReminderItem): Promise<void> {
  busy.value = true;
  try {
    await reminderApi.complete(reminder.id, { note: '在提醒中心标记完成' });
    ElMessage.success('已标记完成');
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function snooze(reminder: ReminderItem, days: number): Promise<void> {
  const until = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  busy.value = true;
  try {
    await reminderApi.snooze(reminder.id, until);
    ElMessage.success(`已顺延到 ${until}（会生成新的一条提醒，历史保留）`);
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function dismiss(reminder: ReminderItem, reason: DismissReason): Promise<void> {
  busy.value = true;
  try {
    await reminderApi.dismiss(reminder.id, reason);
    ElMessage.success('已忽略（原因已记录，用于优化默认规则）');
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function act(reminder: ReminderItem): Promise<void> {
  const payload = reminder.actionPayload ?? {};
  if (reminder.actionKind === 'open_review_form' && payload.repairId) {
    await router.push({ name: 'review', params: { id: String(payload.repairId) } });
    return;
  }
  if (reminder.actionKind === 'open_repair_rework' && payload.damageEventId) {
    await router.push({ name: 'repair-new', params: { id: String(payload.damageEventId) } });
    return;
  }
  if (reminder.actionKind === 'open_inventory') {
    await router.push({ name: 'fabric' });
    return;
  }
  if (reminder.actionKind === 'open_report') {
    await router.push({ name: 'analytics' });
    return;
  }
  if (reminder.actionKind === 'review_submission' && payload.submissionId) {
    await router.push({ name: 'submission-review', params: { id: String(payload.submissionId) } });
    return;
  }
  if (payload.garmentId) {
    await router.push({ name: 'garment-detail', params: { id: String(payload.garmentId) } });
    return;
  }
  await complete(reminder);
}

async function runScan(): Promise<void> {
  busy.value = true;
  try {
    const result = await reminderApi.runNow();
    ElMessage.success(`扫描完成：新增 ${result.created}，推送 ${result.notified}，失效 ${result.expired}`);
    await load();
    await queryClient.invalidateQueries();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

function statusType(status: string): 'success' | 'warning' | 'info' | 'danger' {
  if (status === 'done') return 'success';
  if (status === 'dismissed' || status === 'expired' || status === 'snoozed') return 'info';
  return 'warning';
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">提醒中心</h1>
        <div class="page-subtitle">
          待处理 {{ (summary?.overdue ?? 0) + (summary?.today ?? 0) }} 条 ·
          逾期 {{ summary?.overdue ?? 0 }} ·
          未来 {{ summary?.upcoming ?? 0 }} ·
          已完成 {{ summary?.done ?? 0 }}
        </div>
      </div>
      <el-button :loading="busy" @click="runScan">立刻检查</el-button>
    </div>

    <el-radio-group v-model="scope" style="margin-bottom: 12px">
      <el-radio-button label="today">今天</el-radio-button>
      <el-radio-button label="overdue">逾期</el-radio-button>
      <el-radio-button label="upcoming">未来 7 天</el-radio-button>
      <el-radio-button label="done">已处理</el-radio-button>
      <el-radio-button label="expired">已失效</el-radio-button>
      <el-radio-button label="all">全部</el-radio-button>
    </el-radio-group>

    <el-skeleton v-if="loading" :rows="4" animated />
    <EmptyState v-else-if="items.length === 0" title="这里没有提醒" description="提醒是系统主动回访的唯一方式；如果一直没有提醒，说明确实没什么要处理的。">
      <el-button size="small" @click="scope = 'all'">看看全部提醒</el-button>
    </EmptyState>

    <template v-else>
      <div v-if="grouped.overdue.length" style="margin-bottom: 12px">
        <el-divider content-position="left">已逾期（{{ grouped.overdue.length }}）</el-divider>
        <el-card v-for="reminder in grouped.overdue" :key="reminder.id" shadow="hover" style="margin-bottom: 8px" body-style="padding: 12px">
          <div style="display: flex; justify-content: space-between; gap: 8px">
            <div>
              <div style="font-weight: 600">{{ reminder.title }}</div>
              <div class="muted">{{ reminder.body }}</div>
              <div class="muted" style="font-size: 12px; margin-top: 4px">
                为什么提醒你：{{ reminder.reason }}
              </div>
              <div class="muted" style="font-size: 12px">
                应处理时间 {{ reminder.dueAt.slice(0, 10) }} · 超时 {{ reminder.expireAt.slice(0, 10) }} 自动失效 ·
                {{ REMINDER_ACTION_KIND_LABEL[reminder.actionKind as ReminderActionKind] }}
              </div>
            </div>
            <el-tag type="danger" size="small">逾期</el-tag>
          </div>
          <div class="card-actions">
            <el-button size="small" type="primary" @click="act(reminder)">去处理</el-button>
            <el-button size="small" @click="complete(reminder)">标记完成</el-button>
            <el-button size="small" @click="snooze(reminder, 3)">顺延 3 天</el-button>
            <el-dropdown>
              <el-button size="small">忽略</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="reason in DISMISS_REASONS" :key="reason" @click="dismiss(reminder, reason)">
                    {{ DISMISS_REASON_LABEL[reason] }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </el-card>
      </div>

      <div v-if="grouped.due.length">
        <el-divider content-position="left">待处理（{{ grouped.due.length }}）</el-divider>
        <el-card v-for="reminder in grouped.due" :key="reminder.id" shadow="never" style="margin-bottom: 8px" body-style="padding: 12px">
          <div style="display: flex; justify-content: space-between; gap: 8px">
            <div>
              <div style="font-weight: 600">
                {{ reminder.title }}
                <el-tag v-if="reminder.priority === 'high'" size="small" type="danger" style="margin-left: 6px">高优先</el-tag>
              </div>
              <div class="muted">{{ reminder.body }}</div>
              <div class="muted" style="font-size: 12px; margin-top: 4px">为什么提醒你：{{ reminder.reason }}</div>
              <div class="muted" style="font-size: 12px">
                到期 {{ reminder.dueAt.slice(0, 10) }} ·
                {{ REMINDER_ACTION_KIND_LABEL[reminder.actionKind as ReminderActionKind] }}
              </div>
            </div>
            <el-tag size="small" type="warning">{{ REMINDER_STATUS_LABEL[reminder.status as ReminderStatus] }}</el-tag>
          </div>
          <div class="card-actions">
            <el-button size="small" type="primary" @click="act(reminder)">去处理</el-button>
            <el-button size="small" @click="complete(reminder)">标记完成</el-button>
            <el-button size="small" @click="snooze(reminder, 1)">顺延 1 天</el-button>
            <el-button size="small" @click="snooze(reminder, 7)">顺延 7 天</el-button>
            <el-dropdown>
              <el-button size="small">忽略</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="reason in DISMISS_REASONS" :key="reason" @click="dismiss(reminder, reason)">
                    {{ DISMISS_REASON_LABEL[reason] }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </el-card>
      </div>

      <div v-if="grouped.handled.length">
        <el-divider content-position="left">已处理 / 已失效（{{ grouped.handled.length }}）</el-divider>
        <el-card v-for="reminder in grouped.handled" :key="reminder.id" shadow="never" style="margin-bottom: 8px" body-style="padding: 10px">
          <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center">
            <div>
              <span style="font-weight: 500">{{ reminder.title }}</span>
              <div class="muted" style="font-size: 12px">
                {{ reminder.handledAt?.slice(0, 10) ?? reminder.dueAt.slice(0, 10) }}
                <span v-if="reminder.dismissReason"> · 忽略原因：{{ DISMISS_REASON_LABEL[reminder.dismissReason as DismissReason] }}</span>
                <span v-if="reminder.resultRef && Object.keys(reminder.resultRef).length">
                  · 处理结果：{{ Object.keys(reminder.resultRef).join('、') }}
                </span>
              </div>
            </div>
            <el-tag size="small" :type="statusType(reminder.status)">{{ REMINDER_STATUS_LABEL[reminder.status as ReminderStatus] }}</el-tag>
          </div>
        </el-card>
      </div>
    </template>

    <div class="muted" style="margin-top: 16px">
      提醒规则共 9 条内置规则（复检 / 观察期预告 / 高频加检 / 洗护周期 / 换季检查 / 长期未处理 / 低库存 / 服役评估 / 复发预警），
      可在「设置 → 提醒规则」里逐条关闭或改参数。
    </div>
  </div>
</template>
