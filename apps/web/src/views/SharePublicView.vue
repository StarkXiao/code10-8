<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  DAMAGE_STATUS_LABEL,
  DAMAGE_TERMINAL_STATUSES,
  GARMENT_CATEGORY_LABEL,
  INVENTORY_UNIT_LABEL,
  INVENTORY_UNITS,
  KNIT_OR_WOVEN_LABEL,
  MATERIAL_PRIMARY_LABEL,
  REPAIR_STATUS_LABEL,
  SEASON_LABEL,
  SEVERITY_LABEL,
  SHARE_INTAKE_STATUS_LABEL,
  VERDICT_LABEL,
  type DamageStatus,
  type GarmentCategory,
  type InventoryUnit,
  type KnitOrWoven,
  type MaterialPrimary,
  type RepairStatus,
  type Season,
  type Severity,
  type Verdict,
} from '@gml/shared';
import { shareApi } from '../api';
import { messageOf } from '../api/client';
import { sharePhotoFileUrl } from '../api/client';
import type { ShareIntakeRow } from '../types';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const token = String(route.params.token);
const meta = ref<{
  wardrobeName: string;
  scope: string;
  mode: string;
  garments: Array<{ id: string; code: string; name: string }>;
  expiresAt: string;
  stitches: Array<{ id: string; name: string }>;
} | null>(null);
const garmentId = ref('');
const detail = ref<Record<string, unknown> | null>(null);
const error = ref('');
const intakes = ref<ShareIntakeRow[]>([]);
const submitting = ref(false);
const formVisible = ref(false);

const isCollaborate = computed(() => meta.value?.mode === 'collaborate');

const todayIso = () => new Date().toISOString().slice(0, 10);

const form = reactive({
  damageEventId: '',
  tailorName: '',
  shopName: '' as string | null,
  stitchId: '' as string | null,
  threadType: '' as string | null,
  threadColor: '' as string | null,
  durationMinutes: undefined as number | undefined,
  cost: undefined as number | undefined,
  startedAt: '' as string | null,
  finishedAt: todayIso(),
  note: '' as string | null,
  materials: [] as Array<{ name: string; amount: number | undefined; unit: string | null; note: string | null }>,
});

const garment = computed(() => detail.value?.garment as Record<string, string> | undefined);
const photos = computed(
  () =>
    (detail.value?.photos as Array<{
      id: string;
      view: string;
      annotations: Array<{ id: string; part?: { name: string } | null }>;
    }>) ?? [],
);
const damages = computed(() => (detail.value?.damages as Array<Record<string, unknown>>) ?? []);

/** 师傅只能给「未终结」的破损回填；已闭环的破损列出来但不可选 */
const openDamages = computed(() =>
  damages.value.filter((d) => !DAMAGE_TERMINAL_STATUSES.includes(d.status as DamageStatus)),
);

const seasons = computed(() => {
  const tags = garment.value?.seasonTags;
  return Array.isArray(tags) ? tags.map((s) => SEASON_LABEL[s as Season]).join('/') : '';
});

/* 分享接口返回的是宽泛结构，这里统一收口成模板可用的纯字符串，避免在模板里写类型断言 */
function damageTypeName(row: Record<string, unknown>): string {
  return (row.damageType as { name?: string } | undefined)?.name ?? '—';
}

function partName(row: Record<string, unknown>): string {
  return (row.part as { name?: string } | null)?.name ?? '未标部位';
}

function repairsOf(row: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(row.repairs) ? (row.repairs as Array<Record<string, unknown>>) : [];
}

function stitchName(row: Record<string, unknown>): string {
  return (row.stitch as { name?: string } | undefined)?.name ?? '—';
}

function verdictOf(row: Record<string, unknown>): string {
  const reviews = Array.isArray(row.reviews) ? (row.reviews as Array<{ verdict?: string }>) : [];
  if (reviews.length === 0) return '未复检';
  return VERDICT_LABEL[reviews[0].verdict as Verdict] ?? '—';
}

onMounted(async () => {
  try {
    meta.value = await shareApi.publicData(token);
    if (meta.value.garments.length > 0) {
      garmentId.value = meta.value.garments[0].id;
      await loadGarment();
    }
    if (isCollaborate.value) await loadIntakes();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '分享链接不可用';
  }
});

async function loadGarment(): Promise<void> {
  detail.value = await shareApi.publicGarment(token, garmentId.value);
  const first = openDamages.value[0];
  form.damageEventId = first ? String(first.id) : '';
}

async function loadIntakes(): Promise<void> {
  intakes.value = (await shareApi.publicIntakes(token)).intakes;
}

function photoUrl(id: string): string {
  return sharePhotoFileUrl(id, token);
}

function openForm(): void {
  if (openDamages.value.length === 0) {
    ElMessage.info('这件衣物没有待处理的破损，无需回填');
    return;
  }
  formVisible.value = true;
}

function addMaterial(): void {
  form.materials.push({ name: '', amount: undefined, unit: null, note: null });
}

function removeMaterial(index: number): void {
  form.materials.splice(index, 1);
}

async function submitIntake(): Promise<void> {
  if (!form.damageEventId) {
    ElMessage.warning('请选择要回填的破损');
    return;
  }
  if (!form.tailorName.trim()) {
    ElMessage.warning('请填写师傅称呼');
    return;
  }
  for (const [i, line] of form.materials.entries()) {
    if (!line.name.trim()) {
      ElMessage.warning(`第 ${i + 1} 行用料名称没填`);
      return;
    }
  }
  submitting.value = true;
  try {
    await shareApi.submitIntake(token, {
      damageEventId: form.damageEventId,
      tailorName: form.tailorName.trim(),
      shopName: form.shopName?.trim() || null,
      stitchId: form.stitchId || null,
      threadType: form.threadType?.trim() || null,
      threadColor: form.threadColor?.trim() || null,
      durationMinutes: form.durationMinutes ?? null,
      cost: form.cost ?? null,
      materials: form.materials
        .filter((line) => line.name.trim())
        .map((line) => ({
          name: line.name.trim(),
          amount: line.amount ?? null,
          unit: line.unit,
          note: line.note?.trim() || null,
        })),
      startedAt: form.startedAt || null,
      finishedAt: form.finishedAt,
      note: form.note?.trim() || null,
    });
    ElMessage.success('已提交，等待衣橱主人确认后并入档案');
    formVisible.value = false;
    form.materials = [];
    await Promise.all([loadIntakes(), loadGarment()]);
  } catch (caught) {
    ElMessage.error(messageOf(caught));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 920px; margin: 0 auto; padding: 20px 16px">
    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      :title="error"
      description="链接可能已过期或被撤销，请向衣橱主人重新索取。"
    />

    <template v-else-if="meta">
      <div class="page-header" style="margin-bottom: 16px">
        <div>
          <h1 style="font-size: 22px; margin: 0">
            {{ meta.wardrobeName }} · {{ isCollaborate ? '限时协作档案' : '只读档案' }}
          </h1>
          <div class="muted" style="margin-top: 4px">
            <el-tag v-if="isCollaborate" type="warning" size="small" style="margin-right: 6px">可回填</el-tag>
            {{ isCollaborate ? '可查看档案并回填用料与费用，需主人确认后并入' : '只读视图，不含成本与收纳位置等隐私字段' }}
            · 有效期至 {{ meta.expiresAt.slice(0, 16).replace('T', ' ') }}
          </div>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap">
        <el-select v-model="garmentId" style="width: 320px" @change="loadGarment">
          <el-option v-for="item in meta.garments" :key="item.id" :value="item.id" :label="`${item.name}（${item.code}）`" />
        </el-select>
        <el-button v-if="isCollaborate" type="primary" @click="openForm">回填本次修补的用料与费用</el-button>
      </div>

      <!-- 回填表单 -->
      <el-card v-if="isCollaborate && formVisible" shadow="never" style="margin-bottom: 12px; border: 1px solid #e6a23c">
        <template #header>
          <span style="color: #b88230">回填单 · 提交后由衣橱主人确认，确认前不改动档案</span>
        </template>
        <el-form label-width="96px">
          <el-form-item label="对应破损" required>
            <el-select v-model="form.damageEventId" style="width: 100%">
              <el-option
                v-for="d in openDamages"
                :key="String(d.id)"
                :value="String(d.id)"
                :label="`${damageTypeName(d)}（${SEVERITY_LABEL[d.severity as Severity] ?? d.severity}）· ${partName(d)}`"
              />
            </el-select>
            <div v-if="openDamages.length === 0" class="muted" style="font-size: 12px">
              这件衣物的破损都已闭环，无需回填。
            </div>
          </el-form-item>
          <el-form-item label="师傅称呼" required>
            <el-input v-model="form.tailorName" maxlength="40" placeholder="例如：王师傅" style="width: 240px" />
          </el-form-item>
          <el-form-item label="店铺名称">
            <el-input v-model="form.shopName" maxlength="60" placeholder="送店时填写，个人修补可留空" style="width: 240px" />
          </el-form-item>
          <el-form-item label="针法">
            <el-select v-model="form.stitchId" clearable filterable style="width: 240px" placeholder="不确定可留空">
              <el-option v-for="stitch in meta.stitches" :key="stitch.id" :value="stitch.id" :label="stitch.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="用线">
            <el-input v-model="form.threadType" maxlength="40" placeholder="如：涤纶线 / 羊毛线" style="width: 180px; margin-right: 8px" />
            <el-input v-model="form.threadColor" maxlength="30" placeholder="颜色" style="width: 140px" />
          </el-form-item>
          <el-form-item label="耗时(分钟)">
            <el-input-number v-model="form.durationMinutes" :min="0" :max="10000" :controls="false" style="width: 180px" />
          </el-form-item>
          <el-form-item label="费用(元)">
            <el-input-number v-model="form.cost" :min="0" :precision="2" :controls="false" style="width: 180px" placeholder="没有费用留空" />
          </el-form-item>
          <el-form-item label="修补日期">
            <el-date-picker v-model="form.startedAt" type="date" value-format="YYYY-MM-DD" placeholder="开始日（可选）" style="width: 170px; margin-right: 8px" />
            <el-date-picker v-model="form.finishedAt" type="date" value-format="YYYY-MM-DD" placeholder="完成日" style="width: 170px" />
          </el-form-item>

          <el-form-item label="用料明细">
            <div style="width: 100%">
              <div v-for="(line, index) in form.materials" :key="index" style="display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center">
                <el-input v-model="line.name" maxlength="60" placeholder="用料名称（布/线/配件）" style="width: 220px" />
                <el-input-number v-model="line.amount" :min="0" :precision="2" :controls="false" placeholder="数量" style="width: 120px" />
                <el-select v-model="line.unit" clearable placeholder="单位" style="width: 110px">
                  <el-option v-for="u in INVENTORY_UNITS" :key="u" :value="u" :label="INVENTORY_UNIT_LABEL[u as InventoryUnit]" />
                </el-select>
                <el-input v-model="line.note" maxlength="120" placeholder="备注（颜色/来源，可选）" style="width: 200px" />
                <el-button link type="danger" @click="removeMaterial(index)">删除</el-button>
              </div>
              <el-button size="small" @click="addMaterial">+ 添加一行用料</el-button>
            </div>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="需要交代给主人的其他信息" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="submitting" @click="submitIntake">提交回填</el-button>
            <el-button @click="formVisible = false">取消</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 本链接提交过的回填记录（师傅也能看到处理结果） -->
      <el-card v-if="isCollaborate && intakes.length > 0" shadow="never" style="margin-bottom: 12px">
        <template #header>我提交过的回填（{{ intakes.length }}）</template>
        <el-timeline>
          <el-timeline-item
            v-for="item in intakes"
            :key="item.id"
            :timestamp="item.submittedAt.slice(0, 16).replace('T', ' ')"
            :type="item.status === 'pending' ? 'warning' : item.status === 'confirmed' ? 'success' : 'danger'"
          >
            <div>
              <el-tag size="small" :type="item.status === 'pending' ? 'warning' : item.status === 'confirmed' ? 'success' : 'info'">
                {{ SHARE_INTAKE_STATUS_LABEL[item.status as keyof typeof SHARE_INTAKE_STATUS_LABEL] }}
              </el-tag>
              <span style="margin-left: 8px">{{ item.garmentName }} · {{ item.damageTypeName }}</span>
            </div>
            <div class="muted" style="font-size: 13px; margin-top: 4px">
              {{ item.tailorName }}
              <template v-if="item.stitchName"> · {{ item.stitchName }}</template>
              <template v-if="item.cost !== null"> · ¥{{ item.cost }}</template>
            </div>
            <div v-if="item.reviewNote" class="muted" style="font-size: 12px; margin-top: 2px">主人意见：{{ item.reviewNote }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>

      <template v-if="garment">
        <el-card shadow="never" style="margin-bottom: 12px">
          <div style="font-weight: 600; font-size: 18px">
            {{ garment.name }} <span class="muted mono">{{ garment.code }}</span>
          </div>
          <div class="muted" style="margin-top: 4px">
            {{ GARMENT_CATEGORY_LABEL[garment.category as GarmentCategory] }} ·
            {{ MATERIAL_PRIMARY_LABEL[garment.materialPrimary as MaterialPrimary] }}（{{ KNIT_OR_WOVEN_LABEL[garment.knitOrWoven as KnitOrWoven] }}）·
            {{ seasons }}
          </div>
          <div v-if="garment.careNote" class="muted">洗护：{{ garment.careNote }}</div>
        </el-card>

        <el-card shadow="never" style="margin-bottom: 12px">
          <template #header>照片与标记位置</template>
          <EmptyState v-if="photos.length === 0" title="没有照片" />
          <div v-else style="display: flex; gap: 12px; flex-wrap: wrap">
            <div v-for="photo in photos" :key="photo.id" style="width: 240px">
              <img :src="photoUrl(photo.id)" style="width: 100%; border-radius: 6px" alt="衣物照片" />
              <div class="muted">
                {{ photo.view }} · {{ photo.annotations.length }} 个标记
                <span v-for="annotation in photo.annotations" :key="annotation.id">
                  <span v-if="annotation.part"> · {{ annotation.part.name }}</span>
                </span>
              </div>
            </div>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>破损与修补史</template>
          <EmptyState v-if="damages.length === 0" title="没有破损记录" />
          <div v-else style="display: grid; gap: 12px">
            <el-card v-for="damage in damages" :key="String(damage.id)" shadow="never" body-style="padding: 12px">
              <div style="font-weight: 600">
                {{ damageTypeName(damage) }} ·
                {{ SEVERITY_LABEL[damage.severity as Severity] }} ·
                {{ DAMAGE_STATUS_LABEL[damage.status as DamageStatus] }}
              </div>
              <div class="muted">
                {{ String(damage.detectedAt).slice(0, 10) }} ·
                {{ partName(damage) }}
                <span v-if="damage.recurrenceOf"> · 复发第 {{ damage.recurrenceIndex }} 次</span>
              </div>
              <el-table :data="repairsOf(damage)" size="small" style="margin-top: 8px">
                <el-table-column label="轮次" width="70">
                  <template #default="{ row }">第 {{ row.round }} 轮</template>
                </el-table-column>
                <el-table-column label="针法" width="130">
                  <template #default="{ row }">{{ stitchName(row) }}</template>
                </el-table-column>
                <el-table-column label="完成" width="110">
                  <template #default="{ row }">{{ String(row.finishedAt).slice(0, 10) }}</template>
                </el-table-column>
                <el-table-column label="状态" width="110">
                  <template #default="{ row }">{{ REPAIR_STATUS_LABEL[row.status as RepairStatus] }}</template>
                </el-table-column>
                <el-table-column label="复检">
                  <template #default="{ row }">
                    {{ verdictOf(row) }}
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </div>
        </el-card>
      </template>
    </template>
  </div>
</template>
