<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  DAMAGE_STATUS_LABEL,
  GARMENT_CATEGORY_LABEL,
  INVENTORY_UNIT_LABEL,
  KNIT_OR_WOVEN_LABEL,
  MATERIAL_PRIMARY_LABEL,
  REPAIR_STATUS_LABEL,
  SEASON_LABEL,
  SEVERITY_LABEL,
  SUBMISSION_STATUS_LABEL,
  VERDICT_LABEL,
  type DamageStatus,
  type GarmentCategory,
  type InventoryUnit,
  type KnitOrWoven,
  type MaterialPrimary,
  type RepairStatus,
  type Season,
  type Severity,
  type SubmissionStatus,
  type Verdict,
} from '@gml/shared';
import { ElMessage } from 'element-plus';
import { shareApi } from '../api';
import { sharePhotoFileUrl } from '../api/client';
import { messageOf } from '../api/client';
import EmptyState from '../components/EmptyState.vue';

interface CollabDict {
  stitches: Array<{ code: string; name: string }>;
  damageTypes: Array<{ code: string; name: string; defaultSeverity: string }>;
  parts: Array<{ code: string; name: string }>;
}

interface MySubmission {
  id: string;
  status: string;
  collaborator: string;
  garmentId: string;
  submittedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  laborCost: number | null;
}

const route = useRoute();
const token = String(route.params.token);
const meta = ref<{
  wardrobeName: string;
  scope: string;
  mode: string;
  garments: Array<{ id: string; code: string; name: string }>;
  expiresAt: string;
} | null>(null);
const garmentId = ref('');
const detail = ref<Record<string, unknown> | null>(null);
const error = ref('');
const dict = ref<CollabDict | null>(null);
const mySubmissions = ref<MySubmission[]>([]);
const activeTab = ref('archive');
const submitting = ref(false);
const submitted = ref(false);

const isCollab = computed(() => meta.value?.mode === 'collab');

const today = new Date().toISOString().slice(0, 10);

const form = reactive({
  damageChoice: 'existing' as 'existing' | 'new',
  damageEventId: '' as string,
  newDamageTypeCode: '',
  newDamageSeverity: 'moderate',
  newDamagePartCode: '',
  newDamageDescription: '',
  collaborator: '',
  contact: '',
  stitchCode: '',
  threadType: '',
  threadColor: '',
  durationMinutes: null as number | null,
  laborCost: 0,
  shopName: '',
  startedAt: '' as string,
  finishedAt: today,
  materialTotalCost: 0,
  reuseOriginalFabric: false,
  note: '',
});

const materialRows = ref<Array<{ description: string; amount: number; unit: InventoryUnit; unitCost: number | undefined }>>([]);

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
const seasons = computed(() => {
  const tags = garment.value?.seasonTags;
  return Array.isArray(tags) ? tags.map((s) => SEASON_LABEL[s as Season]).join('/') : '';
});

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

function statusTagType(status: string): 'warning' | 'success' | 'danger' {
  if (status === 'pending') return 'warning';
  if (status === 'approved') return 'success';
  return 'danger';
}

function addMaterial(): void {
  materialRows.value.push({ description: '', amount: 1, unit: 'cm2', unitCost: undefined });
}

function removeMaterial(index: number): void {
  materialRows.value.splice(index, 1);
}

onMounted(async () => {
  try {
    meta.value = await shareApi.publicData(token);
    if (meta.value.mode === 'collab') {
      dict.value = await shareApi.collabDictionary(token);
      const mine = await shareApi.myCollabSubmissions(token);
      mySubmissions.value = mine.items;
      activeTab.value = mine.items.length > 0 ? 'submissions' : 'archive';
    }
    if (meta.value.garments.length > 0) {
      garmentId.value = meta.value.garments[0].id;
      await loadGarment();
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '分享链接不可用';
  }
});

async function loadGarment(): Promise<void> {
  detail.value = await shareApi.publicGarment(token, garmentId.value);
  form.damageEventId = '';
}

function photoUrl(id: string): string {
  return sharePhotoFileUrl(id, token);
}

async function submitForm(): Promise<void> {
  if (!form.collaborator.trim()) {
    ElMessage.warning('请填写您的称呼或店名');
    return;
  }
  if (!form.stitchCode) {
    ElMessage.warning('请选择使用的针法');
    return;
  }
  if (form.damageChoice === 'existing' && !form.damageEventId) {
    ElMessage.warning('请选择本次修补对应哪条破损记录');
    return;
  }
  if (form.damageChoice === 'new') {
    if (!form.newDamageTypeCode) {
      ElMessage.warning('请选择破损类型');
      return;
    }
    if (!form.newDamageDescription.trim()) {
      ElMessage.warning('请描述一下破损情况');
      return;
    }
  }
  for (const [i, row] of materialRows.value.entries()) {
    if (!row.description.trim()) {
      ElMessage.warning(`第 ${i + 1} 行用料还没填写说明`);
      return;
    }
    if (!(row.amount > 0)) {
      ElMessage.warning(`第 ${i + 1} 行用料的用量必须大于 0`);
      return;
    }
  }

  const body = {
    garmentId: garmentId.value,
    damageEventId: form.damageChoice === 'existing' ? form.damageEventId : null,
    newDamage:
      form.damageChoice === 'new'
        ? {
            damageTypeCode: form.newDamageTypeCode,
            severity: form.newDamageSeverity,
            partCode: form.newDamagePartCode || null,
            description: form.newDamageDescription,
          }
        : null,
    collaborator: form.collaborator.trim(),
    contact: form.contact.trim() || null,
    stitchCode: form.stitchCode,
    stitchNameFallback: dict.value?.stitches.find((s) => s.code === form.stitchCode)?.name ?? null,
    stitchSecondaryCodes: [],
    threadType: form.threadType.trim() || null,
    threadColor: form.threadColor.trim() || null,
    durationMinutes: form.durationMinutes,
    laborCost: form.laborCost,
    shopName: form.shopName.trim() || null,
    startedAt: form.startedAt || null,
    finishedAt: form.finishedAt,
    materials: materialRows.value.map((r) => ({
      description: r.description.trim(),
      amount: r.amount,
      unit: r.unit,
      ...(r.unitCost !== undefined && r.unitCost !== null ? { unitCost: r.unitCost } : {}),
    })),
    materialTotalCost: form.materialTotalCost,
    reuseOriginalFabric: form.reuseOriginalFabric,
    note: form.note.trim() || null,
  };

  submitting.value = true;
  try {
    await shareApi.submitCollab(token, body);
    ElMessage.success('已提交，衣橱主人确认后会并入修补档案');
    submitted.value = true;
    const mine = await shareApi.myCollabSubmissions(token);
    mySubmissions.value = mine.items;
    activeTab.value = 'submissions';
    materialRows.value = [];
    form.note = '';
  } catch (caught) {
    ElMessage.error(messageOf(caught));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page">
    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      :title="error"
      description="链接可能已过期或被撤销，请向衣橱主人重新索取。"
    />

    <template v-else-if="meta">
      <div class="page-header">
        <div>
          <h1 class="page-title">
            {{ meta.wardrobeName }} · {{ isCollab ? '协作档案' : '只读档案' }}
          </h1>
          <div class="page-subtitle">
            <el-tag v-if="isCollab" type="warning" size="small" style="margin-right: 8px">限时协作</el-tag>
            <el-tag v-else size="small" style="margin-right: 8px">只读</el-tag>
            {{ isCollab ? '可回填用料与费用，主人确认后并入档案' : '不含成本与收纳位置等隐私字段' }}
            · 有效期至 {{ meta.expiresAt.slice(0, 16).replace('T', ' ') }}
          </div>
        </div>
      </div>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="衣物档案" name="archive">
          <el-select v-model="garmentId" style="width: 320px; margin-bottom: 12px" @change="loadGarment">
            <el-option v-for="item in meta.garments" :key="item.id" :value="item.id" :label="`${item.name}（${item.code}）`" />
          </el-select>

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
                      <template #default="{ row }">{{ verdictOf(row) }}</template>
                    </el-table-column>
                  </el-table>
                </el-card>
              </div>
            </el-card>

            <div v-if="isCollab" style="margin-top: 16px; text-align: center">
              <el-button type="primary" size="large" @click="activeTab = 'fill'">回填本次修补的用料与费用</el-button>
            </div>
          </template>
        </el-tab-pane>

        <el-tab-pane v-if="isCollab" label="回填修补单" name="fill">
          <el-card shadow="never" style="max-width: 760px">
            <template #header>
              师傅回填：{{ garment?.name }} <span class="muted mono">{{ garment?.code }}</span>
            </template>
            <el-alert
              type="info"
              :closable="false"
              title="提交后不会直接改动档案，衣橱主人核对确认后才会并入；你的称呼、填写时间与提交内容都会留痕。"
              style="margin-bottom: 16px"
            />
            <el-form label-width="120px">
              <el-divider content-position="left">对应破损</el-divider>
              <el-form-item label="选择方式">
                <el-radio-group v-model="form.damageChoice">
                  <el-radio value="existing">挂到已有破损记录</el-radio>
                  <el-radio value="new">这是新发现/新修补的破损</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item v-if="form.damageChoice === 'existing'" label="破损记录">
                <el-select v-model="form.damageEventId" style="width: 100%" placeholder="选择对应的破损">
                  <el-option
                    v-for="d in damages"
                    :key="String(d.id)"
                    :value="String(d.id)"
                    :label="`${d.code} · ${damageTypeName(d)} · ${partName(d)} · ${DAMAGE_STATUS_LABEL[d.status as DamageStatus]}`"
                  />
                </el-select>
              </el-form-item>
              <template v-else>
                <el-form-item label="破损类型">
                  <el-select v-model="form.newDamageTypeCode" style="width: 100%">
                    <el-option v-for="d in dict?.damageTypes ?? []" :key="d.code" :value="d.code" :label="d.name" />
                  </el-select>
                </el-form-item>
                <el-form-item label="严重程度">
                  <el-select v-model="form.newDamageSeverity" style="width: 200px">
                    <el-option v-for="(label, key) in SEVERITY_LABEL" :key="key" :value="key" :label="label" />
                  </el-select>
                </el-form-item>
                <el-form-item label="部位">
                  <el-select v-model="form.newDamagePartCode" clearable style="width: 100%" placeholder="不确定可留空">
                    <el-option v-for="p in dict?.parts ?? []" :key="p.code" :value="p.code" :label="p.name" />
                  </el-select>
                </el-form-item>
                <el-form-item label="破损描述">
                  <el-input v-model="form.newDamageDescription" type="textarea" :rows="2" maxlength="1000" show-word-limit />
                </el-form-item>
              </template>

              <el-divider content-position="left">修补信息</el-divider>
              <el-form-item label="称呼 / 店名" required>
                <el-input v-model="form.collaborator" maxlength="40" placeholder="主人将据此识别是谁提交的" />
              </el-form-item>
              <el-form-item label="联系方式">
                <el-input v-model="form.contact" maxlength="60" placeholder="选填，方便主人核对费用" />
              </el-form-item>
              <el-form-item label="针法" required>
                <el-select v-model="form.stitchCode" filterable style="width: 100%">
                  <el-option v-for="s in dict?.stitches ?? []" :key="s.code" :value="s.code" :label="`${s.name}（${s.code}）`" />
                </el-select>
              </el-form-item>
              <el-form-item label="缝线">
                <el-input v-model="form.threadType" maxlength="60" placeholder="如 涤纶线/丝线，选填" style="width: 220px; margin-right: 8px" />
                <el-input v-model="form.threadColor" maxlength="30" placeholder="颜色" style="width: 180px" />
              </el-form-item>
              <el-form-item label="耗时（分钟）">
                <el-input-number v-model="form.durationMinutes" :min="0" :max="10000" />
              </el-form-item>
              <el-form-item label="开工 / 完成">
                <el-date-picker
                  v-model="form.startedAt"
                  type="date"
                  value-format="YYYY-MM-DD"
                  placeholder="开工日期（选填）"
                  style="width: 180px; margin-right: 8px"
                />
                <el-date-picker v-model="form.finishedAt" type="date" value-format="YYYY-MM-DD" placeholder="完成日期" style="width: 180px" />
              </el-form-item>
              <el-form-item label="是否沿用原衣布料">
                <el-switch v-model="form.reuseOriginalFabric" />
              </el-form-item>

              <el-divider content-position="left">用料与费用</el-divider>
              <el-form-item v-for="(row, index) in materialRows" :key="index" :label="index === 0 ? '用料明细' : ''">
                <div style="display: flex; gap: 8px; flex-wrap: wrap; width: 100%">
                  <el-input v-model="row.description" maxlength="120" placeholder="用料说明（如 藏青纯棉补丁布）" style="width: 260px" />
                  <el-input-number v-model="row.amount" :min="0.01" :precision="2" placeholder="用量" style="width: 130px" />
                  <el-select v-model="row.unit" style="width: 110px">
                    <el-option v-for="(label, key) in INVENTORY_UNIT_LABEL" :key="key" :value="key" :label="label" />
                  </el-select>
                  <el-input-number v-model="row.unitCost" :min="0" :precision="2" placeholder="单价（选填）" style="width: 140px" />
                  <el-button link type="danger" @click="removeMaterial(index)">删除</el-button>
                </div>
              </el-form-item>
              <el-form-item label=" ">
                <el-button @click="addMaterial">+ 添加用料</el-button>
              </el-form-item>
              <el-form-item label="用料合计费用">
                <el-input-number v-model="form.materialTotalCost" :min="0" :precision="2" />
                <span class="muted" style="margin-left: 8px">材料/辅料总金额（元）</span>
              </el-form-item>
              <el-form-item label="工时费" required>
                <el-input-number v-model="form.laborCost" :min="0" :precision="2" />
                <span class="muted" style="margin-left: 8px">手工费用（元），没有可填 0</span>
              </el-form-item>
              <el-form-item label="店铺名称">
                <el-input v-model="form.shopName" maxlength="60" placeholder="选填" />
              </el-form-item>
              <el-form-item label="备注">
                <el-input v-model="form.note" type="textarea" :rows="2" maxlength="1000" show-word-limit placeholder="想对主人说明的其他情况" />
              </el-form-item>
              <el-form-item>
                <el-button type="primary" size="large" :loading="submitting" @click="submitForm">提交给衣橱主人确认</el-button>
              </el-form-item>
            </el-form>
          </el-card>
        </el-tab-pane>

        <el-tab-pane v-if="isCollab" :label="`我的回填（${mySubmissions.length}）`" name="submissions">
          <el-card shadow="never" style="max-width: 760px">
            <EmptyState v-if="mySubmissions.length === 0" title="还没有提交过回填单" />
            <el-timeline v-else>
              <el-timeline-item
                v-for="item in mySubmissions"
                :key="item.id"
                :type="statusTagType(item.status)"
                :timestamp="item.submittedAt.slice(0, 16).replace('T', ' ')"
              >
                <div style="font-weight: 600">
                  <el-tag size="small" :type="statusTagType(item.status)">
                    {{ SUBMISSION_STATUS_LABEL[item.status as SubmissionStatus] ?? item.status }}
                  </el-tag>
                  <span style="margin-left: 8px">工时费 {{ item.laborCost ?? '—' }} 元</span>
                </div>
                <div v-if="item.status === 'pending'" class="muted">已提交，等待衣橱主人核对确认。</div>
                <div v-else-if="item.status === 'approved'" class="muted">
                  已于 {{ item.reviewedAt?.slice(0, 10) }} 确认并入修补档案。
                  <div v-if="item.reviewNote">主人备注：{{ item.reviewNote }}</div>
                </div>
                <div v-else class="muted">
                  衣橱主人退回了这张单子。
                  <div v-if="item.reviewNote" style="color: var(--el-color-danger)">退回原因：{{ item.reviewNote }}</div>
                  <el-button size="small" style="margin-top: 6px" @click="activeTab = 'fill'">修改后重新提交</el-button>
                </div>
              </el-timeline-item>
            </el-timeline>
          </el-card>
        </el-tab-pane>
      </el-tabs>
    </template>
  </div>
</template>
