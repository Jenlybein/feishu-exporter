// 极简响应式状态容器：状态一改就自动触发一次重渲染。
//
// 用来替代「每次状态变化都手动逐个赋值 DOM」的写法——那种写法的问题是
// 每加一个状态就要记得在 N 个地方同步对应元素，漏一处就是 bug。
//
// 为什么不用第三方响应式库：这里只需要「改属性 -> 重跑一次渲染」，
// 引入完整依赖不划算（Vue 运行时开销实测 +193 kB，见项目记忆里的评估）。
// Proxy + 微任务合起来 20 行就够。
//
// @param {object}   initial  初始状态
// @param {Function} onChange 状态变化后调用（已合并同一轮内的多次修改）
// @returns {object} 可直接读写的状态对象，赋值即触发 onChange
export function createReactiveStore(initial, onChange) {
  let scheduled = false;
  const schedule = () => {
    // 用微任务合并：同一轮同步代码里的多次赋值只会渲染一次
    if (scheduled) {
      return;
    }
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      onChange();
    });
  };

  return new Proxy({ ...initial }, {
    set(target, key, value) {
      if (Object.is(target[key], value)) {
        return true;
      }
      target[key] = value;
      schedule();
      return true;
    }
  });
}
