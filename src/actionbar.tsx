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
 *
 * active=false 表示这个页此刻在后台（常驻挂载、被 display:none 藏起来的页面，见 App.tsx）：
 * 后台页必须让出动作栏，否则栏里显示的是谁的按钮取决于挂载顺序，不是当前页。
 */
export function useActionBar(node: ReactNode, deps: DependencyList, active = true) {
  const set = useContext(ActionBarContext);
  useEffect(() => {
    if (!active) return;
    set(node);
    return () => set(null);
    // node 由 deps 决定何时刷新，故意不放进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
}
