/**
 * Vue SFC 类型声明垫片。
 *
 * `@wxt-dev/module-vue` 只负责 Vite 侧的编译，不提供 `*.vue` 的
 * TypeScript 类型，所以直接跑 `tsc --noEmit` 时
 * `import App from './App.vue'` 会报 TS2307。
 *
 * 这里补一个最小声明，让 `tsc --noEmit` 可以作为 CI 门禁使用
 * （真正的模板类型检查请用 `vue-tsc`）。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
