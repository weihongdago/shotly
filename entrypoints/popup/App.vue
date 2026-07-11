<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { theme, detectTheme, watchTheme, type ThemeMode } from '../../utils/theme';

const mode = ref<ThemeMode>('light');
let unwatch: (() => void) | null = null;

onMounted(() => {
  mode.value = detectTheme();
  unwatch = watchTheme((m) => (mode.value = m));
});

onUnmounted(() => {
  unwatch?.();
});

const t = () => theme[mode.value];

function captureFull() {
  // D+2 will dispatch via screenshot-port
  console.info('[shotly:popup] full-page capture requested');
}

function captureRegion() {
  console.info('[shotly:popup] region capture requested');
}
</script>

<template>
  <div
    :style="{
      background: t().bg,
      color: t().text,
      borderColor: t().border,
      boxShadow: t().shadow,
    }"
    class="popup"
  >
    <header class="header">
      <div class="brand">
        <span class="logo" :style="{ background: t().brand }">📸</span>
        <span class="name">Shotly</span>
      </div>
      <div class="actions">
        <button
          class="icon-btn"
          :style="{ color: t().textMuted }"
          title="Settings"
        >
          ⚙️
        </button>
        <button
          class="icon-btn"
          :style="{ color: t().textMuted }"
          title="Help"
        >
          ❓
        </button>
      </div>
    </header>

    <main class="grid">
      <button
        class="card card-primary"
        :style="{
          background: t().brand,
          color: t().brandFg,
        }"
        @click="captureFull"
      >
        <span class="card-icon">📷</span>
        <span class="card-label">整页截图</span>
      </button>
      <button
        class="card"
        :style="{
          background: t().surface,
          color: t().text,
          borderColor: t().border,
        }"
        @click="captureRegion"
      >
        <span class="card-icon">▭</span>
        <span class="card-label">区域截图</span>
      </button>
      <button
        class="card"
        :style="{
          background: t().surface,
          color: t().text,
          borderColor: t().border,
        }"
      >
        <span class="card-icon">⏱</span>
        <span class="card-label">历史库</span>
      </button>
      <button
        class="card"
        :style="{
          background: t().surface,
          color: t().text,
          borderColor: t().border,
        }"
      >
        <span class="card-icon">⌨</span>
        <span class="card-label">快捷键</span>
      </button>
    </main>

    <footer
      class="footer"
      :style="{
        background: t().surfaceAlt,
        color: t().textMuted,
        borderColor: t().border,
      }"
    >
      ✨ 升级 Pro 解锁编辑器 + 水印
    </footer>
  </div>
</template>

<style scoped>
.popup {
  width: 320px;
  min-height: 360px;
  border-radius: 12px;
  border: 1px solid;
  font-family: Inter, system-ui, -apple-system, sans-serif;
  overflow: hidden;
  transition: background 200ms ease, color 200ms ease;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 8px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 16px;
}
.name {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
}
.actions {
  display: flex;
  gap: 6px;
}
.icon-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 4px 6px;
  border-radius: 6px;
  transition: background 150ms ease;
}
.icon-btn:hover {
  background: rgba(0, 0, 0, 0.05);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 12px 16px;
}
.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 92px;
  border-radius: 12px;
  border: 1px solid;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: transform 100ms ease, filter 150ms ease;
}
.card:hover {
  filter: brightness(1.05);
}
.card:active {
  transform: scale(0.97);
}
.card-primary {
  border: none;
}
.card-icon {
  font-size: 22px;
}
.card-label {
  font-size: 13px;
}

.footer {
  text-align: center;
  font-size: 12px;
  padding: 12px 16px;
  border-top: 1px solid;
  margin-top: 8px;
}
</style>