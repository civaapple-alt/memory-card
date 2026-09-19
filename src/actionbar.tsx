import { createContext, useContext, useEffect, type DependencyList, type ReactNode } from "react";

/**
 * 底部"常驻动作栏"：App 负责渲染，各页把自己当前的主操作注册进来。
 *
 * 契约（PRD/计划 D4）：主操作永不进入滚动区，永远固定在窗口底部同一条栏里。
 */
export const ActionBarContext = createContext<(node: ReactNode) => void>(() => {});

/**
 * 注册当前页的主操作。deps 控制何时重挂（把 node 依赖的状态都列进去）；
 * 卸载时清空，免得上一个页面的按钮残留在栏里。
 */
export function useActionBar(node: ReactNode, deps: DependencyList) {
  const set = useContext(ActionBarContext);
  useEffect(() => {
    set(node);
    return () => set(null);
    // node 由 deps 决定何时刷新，故意不放进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
