import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { getToken } from '../api/client';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
  { path: '/garments', name: 'garments', component: () => import('../views/GarmentListView.vue') },
  { path: '/garments/new', name: 'garment-new', component: () => import('../views/GarmentNewView.vue') },
  { path: '/garments/:id', name: 'garment-detail', component: () => import('../views/GarmentDetailView.vue') },
  { path: '/garments/:id/annotate', name: 'annotate', component: () => import('../views/AnnotateView.vue') },
  { path: '/garments/:id/damage/new', name: 'damage-new', component: () => import('../views/DamageNewView.vue') },
  { path: '/damage/:id', name: 'damage-detail', component: () => import('../views/DamageDetailView.vue') },
  { path: '/damage/:id/repair/new', name: 'repair-new', component: () => import('../views/RepairNewView.vue') },
  { path: '/repairs/:id', name: 'repair-detail', component: () => import('../views/RepairDetailView.vue') },
  { path: '/repairs/:id/review', name: 'review', component: () => import('../views/ReviewView.vue') },
  { path: '/wear', name: 'wear', component: () => import('../views/WearView.vue') },
  { path: '/fabric', name: 'fabric', component: () => import('../views/FabricView.vue') },
  { path: '/reminders', name: 'reminders', component: () => import('../views/RemindersView.vue') },
  { path: '/analytics', name: 'analytics', component: () => import('../views/AnalyticsView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
  { path: '/share/submissions/:id', name: 'submission-review', component: () => import('../views/SubmissionReviewView.vue') },
  { path: '/share/:token', name: 'share', component: () => import('../views/SharePublicView.vue'), meta: { public: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!getToken()) return { name: 'login', query: { redirect: to.fullPath } };
  return true;
});
