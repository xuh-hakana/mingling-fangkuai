/* ===========================================================================
   文件名中文名 · 本地词库（v2.4.0）
   ---------------------------------------------------------------------------
   这是干什么的：把英文文件名按词拆开，逐词换成中文，供文件树显示。
   零网络、零 token、零延迟——只查本地词表，不发请求、不调模型。

   怎么加词：WORDS 里一条一行，'英文小写': '中文'。改完关窗口重开即可。
   查不到的词原样保留英文，不会出现乱码或半截翻译。

   三种显示：zh（中文）/ both（中文 + 原名小字）/ en（原名）。
   只影响「显示名」，真实路径、复制、收藏、跳转一律用原名，不受影响。
   =========================================================================== */

// 一条一行，按用途分组。键用小写，值是要显示的中文。
const WORDS = {
  // —— 文件与目录 ——
  file: '文件', files: '文件', folder: '文件夹', folders: '文件夹',
  dir: '目录', dirs: '目录', directory: '目录', directories: '目录',
  path: '路径', paths: '路径', name: '名称', names: '名称',
  src: '源码', source: '源码', sources: '源码', lib: '库', libs: '库',
  js: '脚本', ts: 'TypeScript',
  vendor: '第三方', deps: '依赖', dependency: '依赖', dependencies: '依赖',
  node: '节点', modules: '模块', module: '模块',
  temp: '临时', tmp: '临时', cache: '缓存', caches: '缓存',
  backup: '备份', backups: '备份', archive: '归档', archives: '归档',
  snapshot: '快照', dump: '转储', export: '导出', import: '导入',
  upload: '上传', download: '下载', downloads: '下载',
  input: '输入', output: '输出', in: '输入', out: '输出',
  static: '静态', public: '公开', private: '私有', assets: '资源',
  resources: '资源', resource: '资源', media: '媒体',
  bin: '可执行文件', dist: '构建产物', build: '构建', builds: '构建',
  outdir: '输出目录', root: '根目录', base: '基础', common: '公共',
  shared: '共用', global: '全局', local: '本地', remote: '远程',
  main: '主', entry: '入口', index: '入口', home: '首页',
  app: '应用', apps: '应用', application: '应用', desktop: '桌面',
  launcher: '启动器', boot: '启动', startup: '启动', start: '启动',
  setup: '安装配置', install: '安装', installer: '安装器', uninstall: '卸载',
  update: '更新', updates: '更新', upgrade: '升级', patch: '补丁',
  release: '发布', releases: '发布', version: '版本', versions: '版本',
  latest: '最新', stable: '稳定版', beta: '测试版', alpha: '内部版',
  next: '下一个', old: '旧', legacy: '旧版', deprecated: '已弃用',
  new: '新', draft: '草稿', final: '最终', full: '完整', short: '简短',
  mini: '迷你', max: '最大', min: '最小', huge: '超大', tiny: '极小',

  // —— 程序与工程 ——
  code: '代码', codes: '代码', script: '脚本', scripts: '脚本',
  program: '程序', programs: '程序', process: '进程', processes: '进程',
  thread: '线程', threads: '线程', worker: '工作线程', workers: '工作线程',
  task: '任务', tasks: '任务', job: '作业', jobs: '作业', cron: '定时任务',
  queue: '队列', pool: '池', batch: '批量', bulk: '批量', flow: '流程',
  pipeline: '流水线', step: '步骤', steps: '步骤', stage: '阶段',
  runtime: '运行时', engine: '引擎', core: '核心', kernel: '内核',
  framework: '框架', frameworks: '框架', library: '库', libraries: '库',
  package: '包', packages: '包', bundle: '打包', bundles: '打包',
  manifest: '清单', lock: '锁定', dependencylock: '依赖锁定',
  compiler: '编译器', compile: '编译', buildtool: '构建工具',
  transpile: '转换编译', lint: '代码检查', linter: '检查器', format: '格式',
  formatter: '格式化器', minify: '压缩', uglify: '压缩混淆',
  polyfill: '兼容补丁', shim: '兼容层', wrapper: '封装层', adapter: '适配器',
  adapters: '适配器', bridge: '桥接', loader: '加载器', plugin: '插件',
  plugins: '插件', extension: '扩展', extensions: '扩展', addon: '附加组件',
  widget: '小组件', component: '组件', components: '组件',
  container: '容器', service: '服务', services: '服务', provider: '提供方',
  gateway: '网关', proxy: '代理', middleware: '中间件', controller: '控制器',
  controllers: '控制器', route: '路由', routes: '路由', router: '路由器',
  routing: '路由', endpoint: '接口地址', handler: '处理器', handlers: '处理器',
  listener: '监听器', emitter: '事件派发', dispatcher: '调度器',
  scheduler: '调度器', monitor: '监控', watchdog: '看门狗', daemon: '守护进程',
  driver: '驱动', drivers: '驱动', sdk: '开发包', cli: '命令行', gui: '图形界面',
  shell: '命令行外壳', console: '控制台', terminal: '终端', command: '命令',
  commands: '命令', cmd: '命令', cmds: '命令', arg: '参数', args: '参数',
  param: '参数', params: '参数', parameter: '参数', parameters: '参数',
  option: '选项', options: '选项', flag: '开关', flags: '开关',
  config: '配置', configs: '配置', configuration: '配置', conf: '配置',
  cfg: '配置', settings: '设置', setting: '设置', preference: '偏好',
  preferences: '偏好', env: '环境', environment: '环境',
  preset: '预设', presets: '预设', default: '默认', defaults: '默认',
  custom: '自定义', auto: '自动', dynamic: '动态',
  live: '实时', real: '真实', fake: '假', mock: '模拟', stub: '桩',
  demo: '演示', example: '示例', examples: '示例', sample: '样本',
  samples: '样本', template: '模板', templates: '模板', boilerplate: '脚手架',
  scaffold: '脚手架', playground: '试验场', sandbox: '沙箱', benchmark: '基准测试',
  bench: '基准测试', perf: '性能', performance: '性能', optimize: '优化',
  optimization: '优化', refactor: '重构', chore: '杂务', revert: '回滚',
  merge: '合并', branch: '分支', branches: '分支', commit: '提交',
  commits: '提交', diff: '差异', tag: '标签', tags: '标签',
  init: '初始化', bootloader: '引导程序', restart: '重启', reload: '重载',
  refresh: '刷新', reset: '重置', clear: '清空', clean: '清理', purge: '清除',
  delete: '删除', remove: '移除', add: '添加', create: '创建', make: '生成',
  generate: '生成', edit: '编辑', save: '保存', load: '加载', read: '读取',
  write: '写入', writer: '写入器', reader: '读取器', open: '打开', close: '关闭',
  run: '运行', runner: '运行器', execute: '执行', exec: '执行', stop: '停止',
  pause: '暂停', resume: '继续', cancel: '取消', retry: '重试', wait: '等待',
  sync: '同步', async: '异步', await: '等待', queueing: '排队',
  connect: '连接', connection: '连接', disconnect: '断开', reconnect: '重连',
  request: '请求', requests: '请求', response: '响应', responses: '响应',
  reply: '回复', replies: '回复', send: '发送', receive: '接收',
  push: '推送', pull: '拉取', fetch: '获取', callback: '回调',
  promise: '异步结果', resolve: '完成', reject: '拒绝', timeout: '超时',
  delay: '延迟', interval: '间隔', schedule: '定时', timer: '定时器',
  retryable: '可重试', limit: '限制', rate: '速率', quota: '配额', usage: '用量',
  helper: '辅助', helpers: '辅助', tool: '工具', tools: '工具',
  renderer: '渲染器', preload: '预加载', extract: '提取', scan: '扫描',
  scanner: '扫描器', protocol: '协议', metadata: '元数据', bak: '备份',
  event: '事件', events: '事件', contest: '比赛', memshare: '内存分享',
  dict: '词典', dictionary: '词典', seen: '已见', pkg: '安装包',
  localizable: '本地化', appicon: '应用图标', privacyinfo: '隐私信息',
  infoplist: '信息属性列表', appdelegate: '应用代理', swizzler: '方法替换',
  macos: 'macOS', gpu: 'GPU', cpu: 'CPU', swift: 'Swift', bilibot: 'B站机器人',
  workbuddy: 'WorkBuddy', prelogin: '预登录', google: 'Google', github: 'GitHub',
  git: 'Git', npm: 'npm', nodejs: 'Node.js', chrome: 'Chrome', chromium: 'Chromium',

  // —— 数据与存储 ——
  data: '数据', dataset: '数据集', datasets: '数据集', db: '数据库',
  database: '数据库', sql: 'SQL', sqlite: 'SQLite', table: '表格',
  tables: '表格', row: '行', rows: '行', column: '列', columns: '列',
  field: '字段', fields: '字段', record: '记录', records: '记录',
  store: '存储', storage: '存储', persist: '持久化',
  state: '状态', states: '状态', status: '状态', session: '会话',
  sessions: '会话', memory: '记忆', mem: '内存', buffer: '缓冲区',
  stream: '流', streams: '流', socket: '套接字', channel: '频道',
  channels: '频道', pipe: '管道', pooler: '连接池',
  schema: '数据结构', schemas: '数据结构', model: '模型', models: '模型',
  migration: '迁移', migrations: '迁移', migrate: '迁移', seed: '种子数据',
  seeds: '种子数据', fixture: '测试数据', fixtures: '测试数据',
  indexdb: 'IndexedDB', mmkv: 'MMKV 存储', jsonl: 'JSONL 数据',
  csv: 'CSV 表格', tsv: 'TSV 表格', xls: 'Excel 表', xlsx: 'Excel 表',
  yaml: 'YAML 配置', yml: 'YAML 配置', toml: 'TOML 配置', ini: 'INI 配置',
  xml: 'XML 数据', json: 'JSON 数据', plist: '属性列表', properties: '属性文件',
  keyedobjects: '键值对象', keyedarchive: '键值归档',

  // —— 用户、权限、社群 ——
  user: '用户', users: '用户', account: '账号', accounts: '账号',
  member: '成员', members: '成员', group: '群组', groups: '群组',
  room: '房间', rooms: '房间', friend: '好友', friends: '好友',
  contact: '联系人', contacts: '联系人', profile: '资料', avatar: '头像',
  nickname: '昵称', nick: '昵称', alias: '代称', identity: '身份',
  permission: '权限', permissions: '权限', role: '角色', roles: '角色',
  admin: '管理员', owner: '所有者', guest: '访客', auth: '鉴权',
  login: '登录', logout: '退出登录', signin: '登录', signup: '注册',
  register: '注册', verify: '验证', validation: '校验', validate: '校验',
  token: '令牌', tokens: '令牌', secret: '密钥', secrets: '密钥',
  key: '密钥', keys: '密钥', password: '密码', passwd: '密码',
  encrypt: '加密', encrypted: '加密的', decrypt: '解密', crypto: '加密',
  hash: '哈希', sign: '签名', signature: '签名', privacy: '隐私',
  security: '安全', policy: '策略', policies: '策略', rule: '规则',
  rules: '规则', guard: '守卫', block: '屏蔽', allow: '允许', deny: '拒绝',
  black: '黑色', white: '白色', blacklist: '黑名单', whitelist: '白名单', ban: '封禁', mute: '禁言', kick: '移出',

  // —— 聊天与消息 ——
  chat: '聊天', chats: '聊天', message: '消息', messages: '消息',
  msg: '消息', msgs: '消息', notice: '通知', notices: '通知',
  notify: '通知', notification: '通知', alert: '提醒', toast: '轻提示',
  dialog: '对话框', modal: '弹层', popup: '浮层', tooltip: '悬浮提示',
  mention: '提及', mentions: '提及', quote: '引用',
  forward: '转发', share: '分享', like: '点赞', star: '星标',
  stars: '星标', comment: '评论', comments: '评论', post: '帖子',
  posts: '帖子', topic: '话题', topics: '话题', tagging: '打标签',

  // —— 测试与质量 ——
  test: '测试', tests: '测试', testing: '测试', spec: '规格', specs: '规格',
  suite: '测试套件', suites: '测试套件', case: '用例', cases: '用例',
  unit: '单元', integration: '集成', e2e: '端到端', coverage: '覆盖率',
  assert: '断言', assertion: '断言', expect: '预期', pass: '通过',
  passed: '已通过', fail: '失败', failed: '已失败', error: '错误',
  errors: '错误', bug: '缺陷', bugs: '缺陷', issue: '问题', issues: '问题',
  fix: '修复', fixes: '修复', hotfix: '紧急修复', regression: '回归',
  regressions: '回归', audit: '审计', check: '检查', checks: '检查',
  checker: '检查器', selfcheck: '自检', selfwatch: '自看', inspect: '查看',
  diagnostics: '诊断', health: '健康', heartbeat: '心跳', ping: '连通测试',
  metric: '指标', metrics: '指标', trace: '追踪', log: '日志', logs: '日志',
  logger: '日志记录', debug: '调试', warn: '警告', warning: '警告',
  info: '信息', fatal: '致命错误', crash: '崩溃', report: '报告',
  reports: '报告', summary: '摘要', stat: '统计', stats: '统计',
  statistics: '统计', count: '计数', counts: '计数', total: '总计',
  percent: '百分比', ratio: '比例', score: '得分', result: '结果',
  results: '结果', analysis: '分析', evaluate: '评估', evaluation: '评估',
  acceptance: '验收', criteria: '标准', quality: '质量', review: '复查',

  // —— 文档与版本 ——
  doc: '文档', docs: '文档', document: '文档', documents: '文档',
  readme: '说明', guide: '指南', guides: '指南', manual: '手册',
  tutorial: '教程', tutorials: '教程', faq: '常见问题', help: '帮助',
  support: '支持', about: '关于', license: '许可', licence: '许可',
  changelog: '更新日志', changes: '改动', history: '历史',
  note: '笔记', notes: '笔记', memo: '备忘', todo: '待办', plan: '计划',
  plans: '计划', roadmap: '路线图', design: '设计',
  requirement: '需求', requirements: '需求清单', brief: '简述', outline: '大纲',
  chapter: '章节', section: '小节', appendix: '附录', glossary: '术语表',
  catalog: '目录', content: '内容', contents: '目录',
  translation: '翻译', translate: '翻译', lang: '语言', language: '语言',
  languages: '语言', locale: '本地化', locales: '本地化', l10n: '本地化',
  i18n: '国际化', zh: '中文', en: '英文', ja: '日文', ko: '韩文',
  hans: '简体中文', hant: '繁体中文', cn: '中国', tw: '中国台湾',
  temporary: '临时',

  // —— 界面与视觉 ——
  ui: '界面', ux: '体验', view: '视图', views: '视图', page: '页面',
  pages: '页面', screen: '屏幕', screens: '屏幕', layout: '布局',
  layouts: '布局', header: '顶栏', footer: '底栏', sidebar: '侧栏',
  nav: '导航', menu: '菜单', menus: '菜单', tab: '标签页', tabs: '标签页',
  button: '按钮', buttons: '按钮', btn: '按钮', form: '表单', forms: '表单',
  card: '卡片', cards: '卡片', list: '列表', lists: '列表', item: '条目',
  items: '条目', grid: '网格', panel: '面板', panels: '面板', pane: '窗格',
  window: '窗口', windows: '窗口', frame: '帧', frames: '帧',
  drawer: '抽屉', accordion: '折叠面板', carousel: '轮播',
  banner: '横幅', cover: '封面', thumb: '缩略图', thumbnail: '缩略图',
  preview: '预览', detail: '详情', details: '详情', search: '搜索',
  filter: '筛选', filters: '筛选', sort: '排序', sorter: '排序器',
  select: '选择', selector: '选择器', scroll: '滚动', pagination: '分页',
  loading: '加载中', skeleton: '骨架屏', empty: '空状态', placeholder: '占位',
  badge: '角标', pill: '标签块', chip: '标签块',
  theme: '主题', themes: '主题', style: '样式', styles: '样式',
  stylesheet: '样式表', css: 'CSS 样式', scss: 'SCSS 样式', less: 'LESS 样式',
  font: '字体', fonts: '字体', color: '颜色', colors: '颜色', palette: '配色',
  red: '红色', blue: '蓝色', green: '绿色', yellow: '黄色',
  orange: '橙色', purple: '紫色', gray: '灰色', grey: '灰色', pink: '粉色',
  cyan: '青色', brown: '棕色', gold: '金色', silver: '银色',
  dark: '深色', light: '浅色', day: '白天', night: '夜晚', mode: '模式',
  modes: '模式', skin: '皮肤', effect: '特效', effects: '特效',
  animation: '动画', animations: '动画', transition: '过渡', motion: '动效',
  highlight: '高亮', highlighter: '高亮器', syntax: '语法', icon: '图标',
  icons: '图标', logo: '标志', image: '图片', images: '图片', img: '图片',
  photo: '照片', picture: '图片', svg: 'SVG 图', png: 'PNG 图',
  audio: '音频', video: '视频', videos: '视频', music: '音乐', sound: '声音',
  voice: '语音', speech: '语音', tts: '语音合成', asr: '语音识别',
  ocr: '文字识别', camera: '摄像头', screenrec: '录屏',

  // —— 网络与通信 ——
  net: '网络', network: '网络', http: 'HTTP', https: 'HTTPS',
  url: '地址', uri: '地址', host: '主机', hosts: '主机', port: '端口',
  ports: '端口', domain: '域名', dns: '域名解析', ip: 'IP 地址',
  websocket: 'WebSocket', ws: 'WebSocket', wss: 'WebSocket 加密',
  api: '接口', apis: '接口', rest: 'REST 接口', graphql: 'GraphQL',
  rpc: '远程调用', cors: '跨域', cookie: 'Cookie', cookies: 'Cookie',
  payload: '载荷', body: '请求体', query: '查询',
  redirect: '重定向', uploader: '上传器',
  downloader: '下载器', webhook: '回调地址', webui: '网页界面',
  web: '网页', website: '网站', site: '站点', sites: '站点', www: '网站',
  frontend: '前端', backend: '后端', fullstack: '全栈', server: '服务器',
  servers: '服务器', client: '客户端', clients: '客户端', peer: '对端',
  nodejs: 'Node.js', electron: 'Electron', chrome: 'Chrome', chromium: 'Chromium',
  firefox: 'Firefox', safari: 'Safari', webkit: 'WebKit', browser: '浏览器',

  // —— AI 与机器人 ——
  ai: 'AI', llm: '大模型', gpt: 'GPT', prompt: '提示词',
  prompts: '提示词', prompter: '提词器', promptbook: '提词册',
  ticiqi: '提词器', embedding: '向量', embeddings: '向量', vector: '向量',
  agent: '智能体', agents: '智能体', bot: '机器人', bots: '机器人',
  chatbot: '聊天机器人', inference: '推理', train: '训练', training: '训练',
  tokenizer: '分词器', context: '上下文', persona: '人设',
  soul: '人设核心', personality: '性格', behavior: '行为', behaviour: '行为',
  mood: '心情', emotion: '情绪', tone: '语气', replystyle: '说话风格',
  recall: '回忆', reminder: '提醒', reminders: '提醒',
  proactive: '主动', greet: '问候', greeting: '问候', farewell: '道别',
  affection: '好感度', favor: '好感度', favorability: '好感度',
  taste: '喜恶', tastes: '喜恶', people: '人物', person: '人物', persons: '人物',
  companion: '陪伴', astrbot: 'AstrBot',
  napcat: 'NapCat', bili: 'B站', bilibili: 'B站', qq: 'QQ', qzone: 'QQ空间',
  wechat: '微信', wecom: '企业微信', telegram: 'Telegram', discord: 'Discord',
  sticker: '表情包', stickers: '表情包', emoji: '表情', emoticon: '颜文字',
  poke: '戳一戳', groupchat: '群聊', privatechat: '私聊',

  // —— 补齐：项目里高频出现的零碎词 ——
  feature: '功能', features: '功能', feedback: '反馈', accept: '接受',
  connector: '连接器', connectors: '连接器', diary: '日记', engage: '互动',
  err: '错误', newbie: '新手', dice: '骰子', region: '地区', hold: '暂存',
  said: '说过', thinking: '思考', master: '主人', pact: '约定', pacts: '约定',
  regress: '回归', stroll: '闲逛', to: '到', pokemon: '宝可梦',
  collection: '集合', win: 'Windows', tab: '标签页', envs: '环境',

  // —— 时间 ——
  date: '日期', dates: '日期', time: '时间', times: '时间',
  timestamp: '时间戳', datetime: '日期时间', duration: '时长',
  year: '年', month: '月', months: '月', week: '周', weeks: '周',
  dayofweek: '星期', today: '今天', yesterday: '昨天', tomorrow: '明天',
  daily: '每日', weekly: '每周', monthly: '每月', yearly: '每年',
  hour: '小时', minute: '分钟', second: '秒', period: '周期',
  versioned: '带版本', expire: '过期', expiry: '过期', deadline: '截止',

  // —— 数值与逻辑 ——
  value: '值', values: '值', id: 'ID', type: '类型', types: '类型', kind: '种类',
  class: '类', classes: '类', function: '函数', functions: '函数',
  method: '方法', methods: '方法', property: '属性',
  object: '对象', objects: '对象', array: '数组', arrays: '数组',
  string: '字符串', number: '数字', boolean: '布尔', bool: '布尔',
  null: '空', undefined: '未定义', map: '映射', maps: '映射', set: '设置',
  tree: '树', leaf: '叶子', parent: '父级',
  child: '子级', children: '子级', sibling: '同级', depth: '深度',
  level: '层级', levels: '层级', size: '大小', sizes: '大小',
  length: '长度', width: '宽度', height: '高度', top: '顶部',
  bottom: '底部', left: '左', right: '右', center: '居中',
  offset: '偏移', scale: '缩放', sum: '合计', avg: '平均', mean: '平均',
  median: '中位数', order: '顺序', encode: '编码', decode: '解码',
  compress: '压缩', decompress: '解压', serialize: '序列化',
  parse: '解析', parser: '解析器', tokenize: '分词', split: '切分',
  join: '拼接', clone: '克隆', copy: '复制', paste: '粘贴',
  move: '移动', rename: '重命名', replace: '替换', find: '查找',
  contains: '包含', match: '匹配', pattern: '模式', regex: '正则',
  random: '随机', shuffle: '打乱', except: '除了',
  ignore: '忽略', include: '包含', exclude: '排除', optional: '可选',
  required: '必填', fallback: '兜底', override: '覆盖',
};

// 整名优先：上面拆词会拆坏的固定写法，在这里整条指定。
const EXACT = {
  'node_modules': '依赖包',
  'package-lock': '依赖锁定',
  'package': '包',
  'requirements': '依赖清单',
  'requirements.txt': '依赖清单.txt',
  'readme': '说明',
  'gitignore': '.gitignore',
  'ds_store': '.DS_Store',
  'lproj': '语言资源',
  'xcprivacy': '隐私清单',
  'icns': '图标文件',
  'nib': '界面文件',
  'pak': '资源包',
  'startup': '启动',
  'selfcheck': '自检',
  'selfwatch': '自看',
  'promptbook': '提词册',
  'persona': '人设',
  'people': '人物',
  'astrbot': 'AstrBot',
  'napcat': 'NapCat',
  'xuhbot': '虚幻机器人',
  'xuhchatrule': '虚幻聊天规则',
  'ticiqi': '提词器',
  'main': '主程序',
  'package.json': '包配置.json',
  '_index': '索引',
  'info.plist': '信息属性列表.plist',
  'package.resolved': '依赖锁定.resolved',
};

const TOKEN_RE = /[A-Za-z]+|[0-9]+|[^A-Za-z0-9]+/g;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

// 拆驼峰：aBc → a Bc；ABc → A Bc。
function splitCamel(word) {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

// 只查词表（含复数 / 时态的粗略还原），不递归。返回 '' 表示不认识。
function lookup(low) {
  if (WORDS[low]) return WORDS[low];
  if (low.length > 4) {
    if (low.endsWith('ies') && WORDS[low.slice(0, -3) + 'y']) return WORDS[low.slice(0, -3) + 'y'];
    if (low.endsWith('es') && WORDS[low.slice(0, -2)]) return WORDS[low.slice(0, -2)];
    if (low.endsWith('s') && WORDS[low.slice(0, -1)]) return WORDS[low.slice(0, -1)];
    if (low.endsWith('ing') && WORDS[low.slice(0, -3)]) return WORDS[low.slice(0, -3)];
    if (low.endsWith('ed') && WORDS[low.slice(0, -2)]) return WORDS[low.slice(0, -2)];
  }
  return '';
}

// 连写词二分：promptbook → prompt + book；selfcheck → self + check。
function splitCompound(low) {
  if (low.length < 6) return '';
  for (let i = 2; i <= low.length - 2; i += 1) {
    const a = lookup(low.slice(0, i));
    const b = lookup(low.slice(i));
    if (a && b) return a + b;
  }
  return '';
}

// 一个英文单词 → 中文。认不出来原样返回，绝不臆造。
function wordZh(word) {
  const low = word.toLowerCase();
  if (EXACT[low]) return EXACT[low];
  const direct = lookup(low);
  if (direct) return direct;
  const parts = splitCamel(word);
  if (parts.length > 1) {
    const mapped = parts.map((part) => lookup(part.toLowerCase()));
    // 有一截不认识就整词保留：宁可留英文库名，也不要「JL路由」「加密Swift」这种半翻。
    if (mapped.every(Boolean)) return mapped.join('');
  }
  return splitCompound(low) || word;
}

/**
 * 文件名 / 目录名 → 中文名。认不出任何词时返回原名。
 * 扩展名原样保留：server.js → 服务器.js
 */
export function translateName(name) {
  if (!name || CJK_RE.test(name)) return name || '';
  const exactKey = name.toLowerCase();
  if (EXACT[exactKey]) return EXACT[exactKey];

  let base = name;
  let ext = '';
  const dot = name.lastIndexOf('.');
  // 开头的点（.gitignore）不算扩展名。
  if (dot > 0 && /^\.[A-Za-z0-9]+$/.test(name.slice(dot))) {
    base = name.slice(0, dot);
    ext = name.slice(dot);
  }
  const baseKey = base.toLowerCase();
  if (EXACT[baseKey]) return EXACT[baseKey] + ext;

  const tokens = base.match(TOKEN_RE) || [];
  let translated = false;
  let out = '';
  for (const token of tokens) {
    if (/^[A-Za-z]+$/.test(token)) {
      const zh = wordZh(token);
      if (zh !== token) translated = true;
      out += zh;
    } else if (/^[0-9]+$/.test(token)) {
      out += token;
    } else {
      out += '·';
    }
  }
  if (!translated) return name;
  out = out.replace(/·{2,}/g, '·').replace(/^·|·$/g, '');
  return out + ext;
}

/** 路径逐段翻译，分隔符保持 /。 */
export function translatePath(path) {
  if (!path) return '';
  return path.split('/').map((part) => translateName(part)).join('/');
}

/**
 * 这个名字是不是「翻译出来的中文」：
 * 原名不含中文、被翻成了含中文的译名 → 真；其余（原名即中文、
 * 专名保留英文如 WorkBuddy、半截不认识保留英文）一律算假。
 * 用来决定显示时是否标粗，区分「翻出来的中文」和「本来就是中文」。
 */
export function isTranslated(name) {
  const zh = translateName(name);
  return zh !== name && CJK_RE.test(zh);
}

/**
 * 按当前显示模式取「主名 + 副名 + 是否标粗」。
 * en → 原名（不粗）；zh → 中文（翻出来的才粗）；
 * both → 中文为主、原名为副（没有译名时不重复，且都不粗）。
 */
export function nameDisplay(name, mode) {
  const zh = translateName(name);
  const bold = isTranslated(name);
  if (mode === 'en') return { text: name, alt: '', bold: false };
  if (mode === 'both') return zh === name ? { text: name, alt: '', bold: false } : { text: zh, alt: name, bold };
  return { text: zh, alt: '', bold };
}

/** 搜索时同时认原名和中文名，切到中文后照样能搜。 */
export function nameMatches(name, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (name.toLowerCase().includes(q)) return true;
  return translateName(name).toLowerCase().includes(q);
}
