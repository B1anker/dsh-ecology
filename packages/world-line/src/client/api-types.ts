/**
 * 面板与宿主通信的 api 函数签名：POST /api/world-line，signal 用于中断过期请求。
 * 与 index.tsx 中 api 的实现及各面板重复声明的内联 prop 类型一致。
 */
export type ApiFn = (body: unknown, signal?: AbortSignal) => Promise<any>
