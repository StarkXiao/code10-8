<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { SHARE_INTAKE_STATUS_LABEL, SHARE_INTAKE_STATUSES } from '@gml/shared';
import { fabricApi, shareApi, wardrobeApi } from '../api';
import { messageOf } from '../api/client';
import type { DictionaryResponse, FabricSourceItem, ShareIntakeRow } from '../types';
import EmptyState from '../components/EmptyState.vue';

const router = useRouter();
const intakes = ref<ShareIntakeRow[]>([]);
const dict = ref<DictionaryResponse | null>(null);
const fabrics = ref<FabricSourceItem[]>([]);
const loading = ref(false);
const statusFilter = ref<string>('');

// 确认对话框
const dialogVisible = ref(false);
const busy = ref(false);
const current = ref<ShareIntakeRow | null>(null);
const confirmForm = ref({
  stitchId: '' as string | null,
  shopName: '' as string | null,
  cost: undefined as number | undefined,
  observationDays: 7,
  note: '' as string | null,
});
/** 每一行用料映射到哪个库存布料；空字符串 = 不映射（原样写进补缀备注） */
const mappingByIndex = ref<Record<number, string>>({});

const filtered = computed(() =>
  statusFilter.value ? intakes.value.filter((item) => item.status === statusFilter.value) : intakes.value,
);

const pendingCount = computed(() => intakes.value.filter((item) => item.status === 'pending').length);

const mappableFabrics = computed(() =>
  fabrics.value.filter((item) => item.isActive && item.inventory),
);

onMounted(async () => {
  await load();
  const [dictionary, fabricList] = await Promise.all([wardrobeApi.dictionary(), fabricApi.list()]);
  dict.value = dictionary;
  fabrics.value = fabricList.items;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    intakes.value = (await shareApi.intakes()).intakes;
  } finally {
    loading.value = false;
  }
}

function materialsText(item: ShareIntakeRow): string {
  if (item.materials.length === 0) return '—';
  return item.materials
    .map((line) => `${line.name}${typeof line.amount === 'number' ? ` ${line.amount}${line.unit ?? ''}` : ''}`)
    .join('；');
}

function openConfirm(item: ShareIntakeRow): void {
  current.value = item;
  confirmForm.value = {
    stitchId: item.stitchId ?? '',
    shopName: item.shopName ?? '',
    cost: item.cost === null ? undefined : Number(item.cost),
    observationDays: 7,
    note: '',
  };
  mappingByIndex.value = {};
  dialogVisible.value = true;
}

async function submitConfirm(): Promise<void> {
  if (!current.value) return;
  if (!confirmForm.value.stitchId) {
    ElMessage.warning('请选择针法（师傅没有填写时由你补选）');
    return;
  }
  const mappings = Object.entries(mappingByIndex.value)
    .filter(([, fabricSourceId]) => fabricSourceId)
    .map(([index, fabricSourceId]) => ({ index: Number(index), fabricSourceId }));
  busy.value = true;
  try {
    const result = await shareApi.confirmIntake(current.value.id, {
      stitchId: confirmForm.value.stitchId,
      shopName: confirmForm.value.shopName || null,
      cost: confirmForm.value.cost ?? null,
      observationDays: confirmForm.value.observationDays,
      materialMappings: mappings,
      note: confirmForm.value.note || null,
    });
    ElMessage.success('已并入档案');
    dialogVisible.value = false;
    await load();
    await ElMessageBox.confirm(result.nextStep, '下一步：填写修补后变化', {
      confirmButtonText: '去填写',
      cancelButtonText: '稍后',
      type: 'success',
    })
      .then(() => router.push({ name: 'repair-detail', params: { id: result.repair.id } }))
      .catch(() => undefined);
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function reject(item: ShareIntakeRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('驳回原因会展示给师傅，他修正后可重新提交', '驳回回填单', {
      confirmButtonText: '驳回',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '例如：费用与实际不符 / 用料请写清颜色与数量',
      inputValidator: (value: string) => (value && value.trim() ? true : '请填写驳回原因'),
    });
    await shareApi.rejectIntake(item.id, { note: value.trim() });
    ElMessage.success('已驳回，师傅可在链接有效期内重新提交');
    await load();
  } catch (error) {
    if (error === 'cancel' || (error as { message?: string })?.message === 'cancel') return;
    ElMessage.error(messageOf(error));
  }
}

function statusTagType(status: string): 'warning' | 'success' | 'info' {
  if (status === 'pending') return 'warning';
  if (status === 'confirmed') return 'success';
  return 'info';
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">协作回填</h1>
        <div class="page-subtitle">
          师傅通过限时协作链接回填的用料与费用，确认后才会并入修补档案；驳回可让师傅修正重提
        </div>
      </div>
    </div>

    <el-radio-group v-model="statusFilter" style="margin-bottom: 12px">
      <el-radio-button label="">全部</el-radio-button>
      <el-radio-button
        v-for="status in SHARE_INTAKE_STATUSES"
        :key="status"
        :label="status"
      >{{ SHARE_INTAKE_STATUS_LABEL[status] }}<span v-if="status === 'pending' && pendingCount > 0">（{{ pendingCount }}）</span></el-radio-button>
    </el-radio-group>

    <el-card shadow="never" v-loading="loading">
      <EmptyState v-if="filtered.length === 0" title="没有回填单" description="在「设置 → 分享」生成限时协作链接发给师傅" />
      <el-table v-else :data="filtered" size="small">
        <el-table-column label="提交时间" width="170">
          <template #default="{ row }">{{ String(row.submittedAt).slice(0, 16).replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="衣物 / 破损" min-width="200">
          <template #default="{ row }">
            <div>{{ row.garmentName }} <span class="mono muted">{{ row.garmentCode }}</span></div>
            <div class="muted" style="font-size: 12px">{{ row.damageTypeName }} · {{ row.damageCode }}</div>
          </template>
        </el-table-column>
        <el-table-column label="师傅" min-width="120">
          <template #default="{ row }">
            <div>{{ row.tailorName }}</div>
            <div v-if="row.shopName" class="muted" style="font-size: 12px">{{ row.shopName }}</div>
          </template>
        </el-table-column>
        <el-table-column label="用料" min-width="180">
          <template #default="{ row }">{{ materialsText(row) }}</template>
        </el-table-column>
        <el-table-column label="费用" width="100">
          <template #default="{ row }">{{ row.cost === null ? '—' : `¥${row.cost}` }}</template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ SHARE_INTAKE_STATUS_LABEL[row.status as keyof typeof SHARE_INTAKE_STATUS_LABEL] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button link type="primary" @click="openConfirm(row)">确认并入</el-button>
              <el-button link type="danger" @click="reject(row)">驳回</el-button>
            </template>
            <el-button
              v-else-if="row.status === 'confirmed' && row.repairId"
              link
              type="primary"
              @click="router.push({ name: 'repair-detail', params: { id: row.repairId } })"
            >查看修补记录</el-button>
            <span v-else class="muted" style="font-size: 12px">
              {{ row.reviewNote }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="确认回填并并入档案" width="640px">
      <template v-if="current">
        <el-descriptions :column="2" border size="small" style="margin-bottom: 12px">
          <el-descriptions-item label="衣物">{{ current.garmentName }}（{{ current.garmentCode }}）</el-descriptions-item>
          <el-descriptions-item label="破损">{{ current.damageTypeName }} · {{ current.damageCode }}</el-descriptions-item>
          <el-descriptions-item label="师傅">{{ current.tailorName }}</el-descriptions-item>
          <el-descriptions-item label="完成日期">{{ String(current.finishedAt).slice(0, 10) }}</el-descriptions-item>
          <el-descriptions-item label="线料">
            {{ [current.threadType, current.threadColor].filter(Boolean).join(' / ') || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="耗时">
            {{ current.durationMinutes === null ? '—' : `${current.durationMinutes} 分钟` }}
          </el-descriptions-item>
          <el-descriptions-item v-if="current.note" label="师傅备注" :span="2">{{ current.note }}</el-descriptions-item>
        </el-descriptions>

        <el-form label-width="100px">
          <el-form-item label="针法" required>
            <el-select v-model="confirmForm.stitchId" filterable style="width: 100%" placeholder="选择针法">
              <el-option
                v-for="stitch in dict?.stitches ?? []"
                :key="stitch.id"
                :value="stitch.id"
                :label="stitch.name"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="店铺名称">
            <el-input v-model="confirmForm.shopName" placeholder="送店时填写；师傅个人补可留空" />
          </el-form-item>
          <el-form-item label="费用(元)">
            <el-input-number v-model="confirmForm.cost" :min="0" :precision="2" :controls="false" style="width: 200px" placeholder="师傅填报值可改" />
          </el-form-item>
          <el-form-item label="观察期(天)">
            <el-input-number v-model="confirmForm.observationDays" :min="1" :max="90" />
            <span class="muted" style="margin-left: 8px">送修默认 7 天</span>
          </el-form-item>

          <el-divider content-position="left">用料与库存映射</el-divider>
          <div v-if="current.materials.length === 0" class="muted" style="margin-bottom: 8px">师傅没有填报用料。</div>
          <div v-for="(line, index) in current.materials" :key="index" style="margin-bottom: 10px">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
              <span style="min-width: 150px">
                {{ line.name }}
                <span v-if="typeof line.amount === 'number'" class="muted">
                  {{ line.amount }}{{ line.unit ?? '' }}
                </span>
              </span>
              <el-select
                v-model="mappingByIndex[index]"
                placeholder="不映射（写入备注）"
                clearable
                style="width: 260px"
                size="small"
              >
                <el-option
                  v-for="fabric in mappableFabrics"
                  :key="fabric.id"
                  :value="fabric.id"
                  :label="`${fabric.name}（余 ${fabric.inventory?.remainingAmount}${fabric.inventory?.unit}）`"
                />
              </el-select>
            </div>
            <div v-if="line.note" class="muted" style="font-size: 12px; margin-left: 4px">备注：{{ line.note }}</div>
          </div>
          <div class="muted" style="font-size: 12px; margin: 4px 0 12px">
            映射到库存的用料会在并入时扣减数量并记录流水；未映射的行会原样写进修补备注。
          </div>

          <el-form-item label="并入备注">
            <el-input v-model="confirmForm.note" type="textarea" :rows="2" placeholder="可选，写进这条回填单的审核痕迹" />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitConfirm">确认并入档案</el-button>
      </template>
    </el-dialog>
  </div>
</template>
