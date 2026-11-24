'use strict';
/*
 * 这是干什么的：同一份页面给两个客户端用，这里决定跑哪一套。
 *   main     = 命令方块：把提词器的入口和整块视图从页面上摘掉，界面里不再显示。
 *   prompter = 提词器独立客户端：只跑需求库 / 体检 / 关联文件，不跑文件树。
 *
 * 必须是同源外部脚本，不能写成 index.html 里的内联 <script>：
 * 本地服务的 CSP 是 script-src 'self'，内联脚本会被浏览器拦掉。
 * 放在 app.js（type=module，延后执行）之前，保证摘 DOM 时事件还没绑定。
 */
(function () {
  var isPrompter = new URLSearchParams(location.search).get('app') === 'prompter';
  document.documentElement.dataset.app = isPrompter ? 'prompter' : 'main';

  // 白天 / 夜晚：打开时按「当下的钟点」定，不再沿用上次关闭时的选择（她 2026-11-09 定）。
  // 06:00–17:59 算白天，其余算夜晚；首帧之前就设好，避免先白一下再变黑。
  // 其余状态（当前页 / 滚动 / 皮肤 / 功能位…）照旧沿用上次关闭时的。
  // 打开后手动切换只在本会话生效 —— 所以这里既不读也不写 localStorage。
  var DAY_START = 6;
  var DAY_END = 18;
  var hour = new Date().getHours();
  document.documentElement.dataset.theme = (hour >= DAY_START && hour < DAY_END) ? 'day' : 'night';

  if (isPrompter) {
    document.title = '提词器 · 需求库';
    // 提词器不跑文件树，文件名显示开关留着没用。
    // 只在这里摘：主客户端要用它切 中文 / 双语 / 原文。
    var nameLangBtn = document.getElementById('nameLangBtn');
    if (nameLangBtn) nameLangBtn.remove();
    return;
  }
  var tab = document.getElementById('tabPrompt');
  if (tab) tab.remove();
  var view = document.getElementById('promptView');
  if (view) view.remove();
})();
