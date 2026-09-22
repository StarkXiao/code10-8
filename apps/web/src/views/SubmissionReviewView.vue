<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  INVENTORY_UNIT_LABEL,
  SEVERITY_LABEL,
  SUBMISSION_STATUS_LABEL,
  type InventoryUnit,
  type Severity,
  type SubmissionStatus,
} from '@gml/shared';
import { shareApi } from '../api';
import { messageOf } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import type { SubmissionDetail } from '../types';

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const data = ref<SubmissionDetail | null>(null);

const decisions = reactive<Record<number, { action: 'inventory' | 'shop_supplied' | 'skip'; fabricSourceId: string }>>({});
const form = reactive({
  damageEventId: '',
  stitchId: '',
  note: '',
});

const submission = computed(() => data.value?.submission);
const payload = computed(() => submission.value?.payload);
const candidates = computed(() => data.value?.candidates);

const totalMaterialCost = computed(() =>
  payload.value ? Number(payload.value.materialTotalCost ?? 0) : 0,
);
const totalCost = computed(() => totalMaterialCost.value + Number(payload.value?.laborCost ?? 0));

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await shareApi.submissionDetail(String(route.params.id));
    form.damageEventId = data.value.submission.damageEvent?.id ?? '';
    const matchedStitch = data.value.candidates.stitches.find((s) => s.code === payload.value!.stitchCode);
    form.stitchId = matchedStitch?.id ?? data.value.candidates.stitches[0]?.id ?? '';
    payload.value?.materials.forEach((_, index) => {
      decisions[index] = { action: 'shop_supplied', fabricSourceId: '' };
    });
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    loading.value = false;
  }
}

function statusTagType(status: string): 'warning' | 'success' | 'danger' {
  if (status === 'pending') return 'warning';
  if (status === 'approved') return 'success';
  return 'danger';
}

function stitchLabel(code: string): string {
  const hit = candidates.value?.stitches.find((s) => s.code === code);
  return hit ? hit.name : code;
}

async function approve(): Promise<void> {
  if (!form.stitchId) {
    ElMessage.warning('请确认针法');
    return;
  }
  const materialDecisions = (payload.value?.materials ?? []).map((_, index) => ({
    index,
    action: decisions[index]?.action ?? ('skip' as const),
    ...(decisions[index]?.action === 'inventory' && decisions[index].fabricSourceId
      ? { fabricSourceId: decisions[index].fabricSourceId }
      : {}),
  }));
  for (const decision of materialDecisions) {
    if (decision.action === 'inventory' && !decision.fabricSourceId) {
      ElMessage.warning(`第 ${decision.index + 1} 条用料选择了库存布料，请指定具体来源`);
      return;
    }
  }
  try {
    await ElMessageBox.confirm(
      `确认后将生成第 1 条新的正式修补记录并同步破损状态，操作不可撤销。继续？`,
      '确认并入档案',
      { type: 'warning', confirmButtonText: '确认并入', cancelButtonText: '再看看' },
    );
  } catch {
    return;
  }
  saving.value = true;
  try {
    const result = await shareApi.approveSubmission(submission.value!.id, {
      damageEventId: form.damageEventId || undefined,
      stitchId: form.stitchId,
      materialDecisions,
      note: form.note || null,
    });
    ElMessage.success(`已并入档案（修补记录第 ${result.round} 轮）`);
    router.push({ name: 'repair-detail', params: { id: result.repairId } });
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    saving.value = false;
  }
}

async function reject(): Promise<void> {
  let reason = '';
  try {
    const result = await ElMessageBox.prompt('退回原因（师傅凭原链接可以看到）', '退回回填单', {
      confirmButtonText: '确认退回',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputValidator: (value: string) => (value?.trim() ? true : '必须填写退回原因'),
    });
    reason = result.value;
  } catch {
    return;
  }
  saving.value = true;
  try {
    await shareApi.rejectSubmission(submission.value!.id, reason.trim());
    ElMessage.success('已退回');
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div v-if="loading" class="page-subtitle">加载中…</div>
    <template v-else-if="submission && payload">
      <div class="page-header">
        <div>
          <h1 class="page-title">
            师傅回填确认 ·
            {{ submission.garment.name }}
            <span class="muted mono">{{ submission.garment.code }}</span>
          </h1>
          <div class="page-subtitle">
            <el-tag size="small" :type="statusTagType(submission.status)">
              {{ SUBMISSION_STATUS_LABEL[submission.status as SubmissionStatus] }}
            </el-tag>
            师傅 {{ submission.collaborator }} 提交于 {{ submission.submittedAt.slice(0, 16).replace('T', ' ') }}
          </div>
        </div>
      </div>

      <el-alert
        v-if="submission.status !== 'pending'"
        :type="submission.status === 'approved' ? 'success' : 'error'"
        :closable="false"
        style="margin-bottom: 12px"
        :title="
          submission.status === 'approved'
            ? `已于 ${submission.reviewedAt?.slice(0, 10)} 并入档案（修补记录 ${submission.repairId}）`
            : '这张回填单已退回'
        "
        :description="submission.reviewNote ?? ''"
      />

      <el-row :gutter="12">
        <el-col :xs="24" :md="14">
          <el-card shadow="never" style="margin-bottom: 12px">
            <template #header>师傅填写的内容</template>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="称呼 / 店名">{{ submission.collaborator }}</el-descriptions-item>
              <el-descriptions-item label="联系方式">{{ submission.contact || '—' }}</el-descriptions-item>
              <el-descriptions-item label="对应破损">
                <template v-if="payload.damageEventId || submission.damageEvent">
                  {{ submission.damageEvent?.code ?? '已选记录' }} ·
                  {{ submission.damageEvent?.damageType ?? '' }}
                  {{ submission.damageEvent?.part ? ` · ${submission.damageEvent.part}` : '' }}
                </template>
                <template v-else-if="payload.newDamage">
                  新破损：{{ payload.newDamage.description }}
                  （{{ SEVERITY_LABEL[payload.newDamage.severity as Severity] }}）
                </template>
              </el-descriptions-item>
              <el-descriptions-item label="针法">{{ stitchLabel(payload.stitchCode) }}</el-descriptions-item>
              <el-descriptions-item label="缝线">
                {{ [payload.threadType, payload.threadColor].filter(Boolean).join(' / ') || '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="耗时">{{ payload.durationMinutes ? `${payload.durationMinutes} 分钟` : '—' }}</el-descriptions-item>
              <el-descriptions-item label="工期">
                {{ payload.startedAt ? `${payload.startedAt} → ` : '' }}{{ payload.finishedAt }}
              </el-descriptions-item>
              <el-descriptions-item label="沿用原衣布料">{{ payload.reuseOriginalFabric ? '是' : '否' }}</el-descriptions-item>
              <el-descriptions-item label="备注">{{ payload.note || '—' }}</el-descriptions-item>
            </el-descriptions>
          </el-card>

          <el-card shadow="never" style="margin-bottom: 12px">
            <template #header>
              用料（{{ payload.materials.length }}）与费用
            </template>
            <EmptyState v-if="payload.materials.length === 0" title="师傅未登记用料" />
            <el-table v-else :data="payload.materials" size="small">
              <el-table-column label="#" type="index" width="48" />
              <el-table-column prop="description" label="用料说明" min-width="180" />
              <el-table-column label="用量" width="120">
                <template #default="{ row }">
                  {{ row.amount }} {{ INVENTORY_UNIT_LABEL[row.unit as InventoryUnit] }}
                </template>
              </el-table-column>
              <el-table-column label="单价" width="90">
                <template #default="{ row }">{{ row.unitCost ?? '—' }}</template>
              </el-table-column>
              <el-table-column v-if="submission.status === 'pending'" label="并入方式" min-width="260">
                <template #default="{ $index }">
                  <el-radio-group v-model="decisions[$index].action" size="small">
                    <el-radio-button value="shop_supplied">师傅自带</el-radio-button>
                    <el-radio-button value="inventory">扣我的库存</el-radio-button>
                    <el-radio-button value="skip">不登记</el-radio-button>
                  </el-radio-group>
                  <el-select
                    v-if="decisions[$index].action === 'inventory'"
                    v-model="decisions[$index].fabricSourceId"
                    size="small"
                    filterable
                    style="width: 100%; margin-top: 6px"
                    placeholder="选择布料来源"
                  >
                    <el-option
                      v-for="f in candidates?.fabricSources ?? []"
                      :key="f.id"
                      :value="f.id"
                      :label="
                        f.inventory
                          ? `${f.name}（余 ${f.inventory.remainingAmount}${INVENTORY_UNIT_LABEL[f.inventory.unit as InventoryUnit]}）`
                          : f.name
                      "
                    />
                  </el-select>
                </template>
              </el-table-column>
            </el-table>
            <el-divider />
            <div style="display: grid; gap: 4px; max-width: 320px; margin-left: auto">
              <div class="muted">用料合计：¥ {{ totalMaterialCost }}</div>
              <div class="muted">工时费：¥ {{ payload.laborCost }}</div>
              <div style="font-weight: 600; font-size: 16px">总计：¥ {{ totalCost }}</div>
            </div>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="10">
          <el-card shadow="never" style="margin-bottom: 12px">
            <template #header>并入设置</template>
            <el-form label-width="100px">
              <el-form-item label="挂接破损">
                <el-select v-model="form.damageEventId" filterable style="width: 100%" :disabled="submission.status !== 'pending'">
                  <el-option
                    v-for="d in candidates?.damages ?? []"
                    :key="d.id"
                    :value="d.id"
                    :label="`${d.code} · ${d.damageType}${d.part ? ` · ${d.part}` : ''}（${d.status}）`"
                  />
                </el-select>
                <div class="field-hint">留空且师傅描述了新破损时，将自动新建一条破损记录</div>
              </el-form-item>
              <el-form-item label="针法">
                <el-select v-model="form.stitchId" filterable style="width: 100%" :disabled="submission.status !== 'pending'">
                  <el-option v-for="s in candidates?.stitches ?? []" :key="s.id" :value="s.id" :label="`${s.name}（${s.code}）`" />
                </el-select>
                <div class="field-hint">师傅填写「{{ payload.stitchCode }}」，若与针法库不一致请在此修正</div>
              </el-form-item>
              <el-form-item label="确认备注">
                <el-input v-model="form.note" type="textarea" :rows="2" maxlength="1000" :disabled="submission.status !== 'pending'" />
              </el-form-item>
            </el-form>
          </el-card>

          <el-card shadow="never" v-if="submission.status === 'pending'">
            <template #header>操作</template>
            <div style="display: flex; gap: 8px">
              <el-button type="primary" :loading="saving" @click="approve">确认并入档案</el-button>
              <el-button type="danger" plain :loading="saving" @click="reject">退回</el-button>
            </div>
            <div class="muted" style="margin-top: 8px; font-size: 12px">
              通过后：生成正式修补记录（执行人=师傅补）、破损状态转为"已修补"、按选择扣减库存，并给师傅展示已并入；
              退回后：师傅凭原链接能看到退回原因，可修改重提。全部动作都会写入操作日志。
            </div>
          </el-card>

          <el-card v-else shadow="never">
            <el-button @click="router.push('/settings?tab=share')">返回分享设置</el-button>
          </el-card>
        </el-col>
      </el-row>
    </template>
  </div>
</template>
