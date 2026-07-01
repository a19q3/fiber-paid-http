# Fiber Paid HTTP Evidence Console 重构方案

> 目标：**整齐、酷炫、但不过载、不混乱**。通过引入 **左侧 Sidebar** 与 **重组的 Settings 面板** 把信息压力从单屏 cockpit 分流出去。
> 参考：ThunderHub（`apotdevin/thunderhub`）的 shell 模式 —— 精简顶栏 + 可折叠分区侧栏 + 右侧 Inspector 抽屉 + 轻量 Preferences。
> 本文档**只提方案，不改代码**。

---

## 1. 现状诊断：为什么现在看起来乱

当前 `apps/evidence-web/index.html` 是一个 **5436 行的单文件**（CSS 2875 行 / body 330 行 / JS 2185 行）。所有东西挤在一个 cockpit 里：

### 1.1 顶栏（topbar）严重过载
`index.html:2887-2917` 的 `<header class="topbar">` 在约 74px 高度里塞进了 **5 组互不相干的东西**：

| 区域 | 内容 | 问题 |
| --- | --- | --- |
| brand | mark + 标题 + 副标题 | OK |
| badges | `#badges`（5 个证据徽章） | 与顶栏职责冲突，应属于侧栏常驻状态 |
| engine-boundary | Rust 卡片 ↔ TS 卡片（两个 `.engine-card` + `.swap`） | 视觉很重，占横向空间，但只是「立场声明」 |
| api-connection | URL 输入框 + Connect + Refresh + Live 复选框 + Settings 按钮 | **5 个控件挤在顶栏**，是过载主因之一 |

### 1.2 三个 workspace tab 仍然各自很密
导航是横向 `workspace-tabs`（`index.html:2919`），切到任一 tab 后主区依旧拥挤：

- **bootstrap**：roles 配置（3 个 select + capability）+ payment params + **8 字段 bootstrap 表单 + secret 开关 + 2 按钮**（`index.html:3009-3071`，是全页最大信息源）+ network。
- **flow**：request/scenario + timeline。
- **evidence**：tabs + JSON + reports 列表 + attack replay + parity grid 全揉在一个 `.evidence-panel` 里（`index.html:3083-3101`）。

### 1.3 配置在两处重复
主区的 Execution Roles / Payment Parameters 与 Settings 抽屉里的 `settings-payer-profile / settings-amount-ckb ...`（`index.html:3171-3200`）是**同一组配置的两份 UI**，既增加密度又增加维护成本。

### 1.4 底栏互相争抢
footer 同时放 Terminal/Event Log 和 Service/Actuator 卡片（`index.html:3104-3137`），两者都与主内容争注意力。

### 1.5 视觉上「酷炫」与「混乱」混在一起
`shell::before` 的 12s 扫描动画 + 网格背景 + 多层 radial glow + 卡片自身的渐变（`index.html:117-128, 82-88`）同时存在，动效互相竞争，反而稀释了「证据在流动」这个真正该被强调的动效。

**一句话总结**：一个屏幕同时承担了 *导航 + 状态 + 配置输入 + 流程 + 证据 + 日志 + 诊断* 七种职责 → 必然过载。

---

## 2. 设计目标

1. **单一职责分区**：header 只放状态与轻量开关；sidebar 只放导航与常驻状态；main 只放当前聚焦任务的结果；inspector 只放按需诊断；settings 承载所有配置输入。
2. **配置与结果分离**：主视图**永不出现配置输入框**，只展示证据/结果。所有 input/select 搬进 Settings。
3. **可扫瞄的常驻状态**：5 个证据徽章（Rust / TS / Fiber E2E / F402 / Production）做成 sidebar 底部的紧凑状态簇，一眼可读。
4. **克制的酷炫**：保留青色 cockpit 质感，但只保留**一个**环境动效，把视觉预算花在「协议流程时间轴的状态迁移」上。
5. **尊重现有约束**：单文件静态 HTML、`check-layout` / `check-action-coverage` / `check-browser-smoke` 必须继续通过（见 §9 迁移计划）。

---

## 3. ThunderHub 模式提取（我们借鉴什么）

克隆 `apotdevin/thunderhub` 后分析其 `src/client`：

| ThunderHub 模式 | 源文件 | 借鉴点 |
| --- | --- | --- |
| **精简 sticky header（~40px）** | `layouts/header/Header.tsx` | 顶栏只放：小 mark + 节点切换 + 快捷动作 + Preferences + Settings 图标。我们对应：连接状态点 + Refresh + Preferences + Settings |
| **分区左 sidebar** | `layouts/navigation/Navigation.tsx` | `mainNav` + `sections`（带分组标题），`NavItem {title, icon, link, beta}`；可折叠成 icon-rail（`open` prop），折叠时 hover 出 tooltip；active 态 `bg-primary/10` |
| **右侧 Inspector** | `layouts/sidebar/RightSidebar.tsx` | `hidden lg:flex w-[320px]`，放 Balances + Swap + **EventLog**；小屏变 Sheet 抽屉。我们对应：Event Log + Attack + Service 状态 |
| **PreferencesPopover** | `layouts/header/PreferencesPopover.tsx` | 轻量设置弹层（ToggleGroup：currency / theme / 布局开关 + logout），**不是**完整设置页。我们对应：density / live / 动画开关 / 连接重连 |
| **三栏 Wrapper** | `App.tsx:179-200` | `<Header/>` + `<div flex><Navigation/><main flex-1/><RightSidebar/></div>` + `<Footer/>`。这正是我们要的 shell 骨架 |
| **ConfigContext 全局 UI 态** | `context/ConfigContext` | theme / sidebar / rightSidebar 等布局态集中管理。我们已有 `consoleSettings` + `localStorage` 持久化，可直接扩展 |
| **响应式降级** | Header mobile 分支 | mobile → Sheet 抽屉（BurgerMenu / Balances）；`lg` 断点切换固定 sidebar vs 抽屉 |

**关键启发**：ThunderHub 把「设置」拆成两层 —— 顶栏 *Popover*（高频轻量开关）+ 独立 *SettingsPage*（完整配置）。我们照搬这个分层。

---

## 4. 新信息架构：三栏 + 双层设置

### 4.1 Shell 骨架

```
┌──────────────────────────────────────────────────────────────────┐
│  HEADER  (~48px, sticky)                                          │
│  [≡] Fiber Paid HTTP Evidence   Rust⟷TS   ● connected   [⟳][▦ prefs][⚙] │
├───────────┬────────────────────────────────────┬──────────────────┤
│  SIDEBAR  │  MAIN（聚焦的当前 workspace）       │  INSPECTOR       │
│  (left)   │                                    │  (right, 可开关)  │
│  ~220px   │                                    │  ~320px          │
│           │                                    │                  │
│  ▸ 导航   │                                    │                  │
│   Flow    │                                    │                  │
│   Bootstr │                                    │                  │
│   Evidenc │                                    │                  │
│   Attacks │                                    │                  │
│   Network │                                    │                  │
│  ───────  │                                    │                  │
│  ▸ 状态   │                                    │                  │
│   ● Rust  │                                    │                  │
│   ● TS    │                                    │                  │
│   ● Fiber │                                    │                  │
│   ● F402  │                                    │                  │
│   ● Prod  │                                    │                  │
│  ───────  │                                    │                  │
│  连接     │                                    │                  │
│  ● live   │                                    │                  │
└───────────┴────────────────────────────────────┴──────────────────┘
```

断点行为（对齐 ThunderHub `lg` 策略）：

| 宽度 | sidebar | inspector |
| --- | --- | --- |
| ≥ 1280px | 固定展开（可折叠 icon-rail） | 固定可见 |
| 1024–1279 | 固定展开 | 折叠为 overlay 抽屉（`PanelRight` 触发） |
| 768–1023 | 折叠为 icon-rail | overlay 抽屉 |
| < 768 | 底部 Sheet（汉堡触发） | 底部 Sheet |

### 4.2 信息再分配表（核心）

> 原则：**main 区只放结果，不放配置输入。**

| 现位置 | 内容 | 现问题 | 新归属 |
| --- | --- | --- | --- |
| topbar api-connection | URL 输入 + Connect + Refresh + Live + Settings | 5 控件塞顶栏 | header 仅留 **状态点 + Refresh + Preferences(▦) + Settings(⚙)**；URL/Live/重连 → **Settings·Connection** |
| topbar engine-boundary | Rust 卡 ↔ TS 卡 | 占横向、视觉重 | header 改为**单一紧凑 chip** `Rust⟷TS`（hover 展开详情）；完整版放 sidebar 底部或 Evidence workspace |
| topbar badges | 5 证据徽章 | 与顶栏职责冲突 | **sidebar 底部状态簇**（常驻、可扫瞄） |
| workspace-tabs | 横向 Bootstrap/Flow/Evidence | 横向空间紧 | **sidebar 垂直导航**（icon+label，新增 Attacks/Network 独立项） |
| bootstrap 表单 | 8 字段 + secret + 2 按钮 | **全页最大过载源** | 整体搬入 **Settings·Bootstrap Runtime**；bootstrap workspace 只留**只读检查结果 + flow + roles 证据** |
| Execution Roles | 3 select + capability | 与 settings 重复 | 搬入 **Settings·Profiles**；flow 顶部用**一行 active-roles chip** 概览 |
| Payment Parameters | CKB price + shannons | 与 settings 重复 | 搬入 **Settings·Flow Parameters**；flow 显示只读 price chip |
| Request/Scenario | 资源卡 + actions | 略冗长 | flow workspace 内**精简卡**（price chip / method / route chips / 4 个 action） |
| Terminal/Event Log | 底栏 | 与内容争抢 | **inspector 抽屉**（可折叠/可钉住） |
| Service/Actuator | 底栏 | 与内容争抢 | **inspector 抽屉** 或 sidebar 底部 mini 状态 |
| Attack Replay | evidence panel 内 | 被埋 + 污染证据区 | 独立 **Attacks workspace** + inspector 内 widget |
| Evidence & Reports | tabs+JSON+reports+parity | 四合一 | Evidence workspace 内**三段式**：顶部 parity 摘要条 / 左 report 列表 / 主 JSON viewer |
| Settings 抽屉 | persona/density/endpoint/profiles/price | 与主区重复 | 成为**唯一配置入口**（见 §5） |

---

## 5. Settings 面板（唯一配置入口）

参考 ThunderHub 的两层设置：**顶栏 PreferencesPopover（高频）** + **完整 Settings 抽屉（低频）**。

### 5.1 PreferencesPopover（顶栏 ▦，轻量高频）
对齐 `PreferencesPopover.tsx` 的 ToggleGroup 风格，只放「即时影响观感/连接」的开关：

- **Density**：Standard / Compact（ToggleGroup）
- **Live**：On / Off（自动刷新）
- **Motion**：动效 On / Off（关掉 shell-scan 等环境动画）
- **Inspector**：显示/隐藏右栏
- 底部：Reconnect（重连 API）

### 5.2 完整 Settings 抽屉（顶栏 ⚙）
分区（每段独立 `<section>`，带图标标题）：

1. **Connection** — API base URL、auto-refresh 间隔、Live 开关、Reconnect/Disconnect。
2. **Bootstrap Runtime** — Fiber mode（local/testnet）、currency、payer/payee/router RPC、payer/payee auth（password）、amount、generate-secret 开关 + Apply/Clear。（即现 `runtime-bootstrap` 表单整体迁入）
3. **Profiles** — payer / payee / gateway profile 选择 + capability 展示 + 可见 roster。（合并现主区 roles 与 settings roster）
4. **Flow Parameters** — 受保护 endpoint、price (CKB)、Fiber amount。
5. **Appearance** — density、persona（operator/payer/payee/auditor）、accent 强调色、motion。

> 这样主视图**完全不出现 `<input>`/`<select>` 配置**，只渲染证据与结果。这是降低过载的关键一刀。

---

## 6. 各 workspace 主区设计

### 6.1 Flow（默认首页，hero）
```
┌─ active roles ─ payer▸node1 · payee▸node3 · gw▸default · 100 CKB ─┐
├─ Request / Scenario（精简卡） ─────────────────────────────────────┤
│  GET /paid/protocol-service   [price][method][route chips][copy]   │
│  [Send unpaid ⌃U][Pay with Fiber ⌃P][Retry ⌃R][Replay ⌃Y]          │
├─ Protocol Flow Timeline（hero，占主视觉） ────────────────────────┤
│   client → 402 → fiber pay → settled → auth:Payment → receipt →   │
│   service executed → replay rejected                              │
│   （状态迁移动画 = 唯一被强调的动效）                              │
└───────────────────────────────────────────────────────────────────┘
```
角色/价格从 Settings 读，主区只显示只读 chip 行。

### 6.2 Bootstrap（只读证据）
仅渲染 `bootstrap-summary` + `bootstrap-flow` + `bootstrap-roles` 的**结果**。输入表单已在 Settings。顶部一条「Configure in Settings →」引导。

### 6.3 Evidence（三段式）
```
┌ Parity 摘要条：canonical_hash · engine:rust · parity✓ · f402✓ ────┐
├──────────────┬───────────────────────────────────────────────────┤
│ Report 列表  │  JSON viewer（行号 + copy + 字段高亮）             │
│ canonical    │                                                   │
│ fiber-local  │                                                   │
│ gate.*       │                                                   │
│ security     │                                                   │
└──────────────┴───────────────────────────────────────────────────┘
```
Attack replay 不再混在这里，移到 Attacks workspace。

### 6.4 Attacks
专门演示 replay 拒绝：状态卡（replay rejected = **绿色 pass**）+ reason + receipt_id + payment_hash + 「protected service: not re-executed」+ 「receipt reissued: false」。inspector 里也提供一个 mini 版。

### 6.5 Network
仅本地路由上下文（node1→node2→node3、channel count、route status: live/evidence/unconfigured）。**不**加任何通道/余额图表（守产品边界）。

---

## 7. 视觉系统：克制的酷炫

保留现 `:root` 青色 cockpit 调色板（`--cyan #32e6ef` / `--green #39e7ad` 等，`index.html:8-32`），但做减法：

- **唯一环境动效**：保留极弱的网格背景，**移除 `shell-scan` 12s 扫描**与多余 radial glow；把动效预算全部给 timeline 的状态迁移（绿/青逐级点亮、replay 红橙）。
- **统一 chip 系统**：状态一律用 `图标 + 圆点 + label + value` 的统一 chip，替代现在 badge/card/engine-card 混用。
- **密度真正生效**：`density=compact` 时收窄 panel padding、行高、chip 间距（现设置项存在但视觉差异弱）。
- **加大留白**：现 `.shell` gap 仅 10px（`index.html:109`），panel 间距偏挤；提到 14–16px，compact 模式回到 10px。
- **统一 panel header**：图标 + 标题 + 可选 action（refresh），高度一致；去掉各自不同的 title 样式。
- **配色语义固定**：绿=pass、青=进行中、橙=warn/需注意、红=fail/reject。replay-rejected 用绿框 + 红图标表达「安全结果」。

---

## 8. Build & Component Architecture（脱离单文件）

> 单文件 `index.html`（5436 行）不是特性，是负债。这一节定义如何按 ThunderHub 的工程范式把它拆成可维护的组件树，同时保住「静态产物 + 检查脚本」这套既有护栏。

### 8.1 单文件为什么是负债

1. **规模失控**：CSS 2875 行 + body 330 行 + JS 2185 行挤在一个文件；每加一个特性，三段都膨胀，冲突面线性增长。
2. **检查脚本与源码深度耦合**：`scripts/check-static.mjs` 用 `requiredHtmlFragments`（**200+ 条**）对 `index.html` 做字面子串 grep —— 元素 ID、class 名、JS 函数名、CSS 动画名（`shell-scan`/`timeline-energy`…）全被钉死。这意味着**改一个内部实现就要改检查脚本**，反向锁死了重构。
3. **无复用**：`<div class="panel-title">` 模板在 body 里手写了几十遍；chip、kv-row、role-pane 等结构没有抽象，复制粘贴漂移。
4. **图标靠内联 sprite**：`sync-icons.tsx` 把 lucide 静态标记当 JSON 内联进 HTML；换图标要重跑同步脚本改文件，而非 import 一个组件。
5. **无构建 = 无现代化能力**：无 tree-shake、无按需 polyfill、无 CSS code-split、无 source map、无 HMR、无 TS 类型检查覆盖 UI（现 `typecheck` 其实只跑 `sync-icons --check` + `check-static`）。

### 8.2 ThunderHub 的工程范式（我们照搬什么）

克隆分析 `apotdevin/thunderhub/src/client`：

| 维度 | ThunderHub 做法 | 源文件 |
| --- | --- | --- |
| 构建 | **Vite**（`@vitejs/plugin-react` + `@tailwindcss/vite`），源在 `src/client`，产物 `dist/` | `vite.config.ts` |
| 样式 | **Tailwind v4** + `globals.css` 把设计 token 写成 CSS 自定义属性（`--primary` `--card` `--radius` …），`.dark` 变体切换 | `styles/globals.css` |
| 入口 | `main.tsx` 挂载 React 根，`BrowserRouter`，启动期 `fetch` 拉运行时配置 | `main.tsx` |
| Shell | `App.tsx` 的 `Wrapper`：`<Header/>` + `<div flex><Navigation/><main/><RightSidebar/></div>` + `<Footer/>` | `App.tsx:179-200` |
| UI 原语 | **shadcn 风格**：`components/ui/*`（button/card/badge/dialog/sheet/popover/tabs/select/tooltip…），每个一个文件，`cva` 管 variants，`cn()` 合并 className | `components/ui/button.tsx` |
| `cn()` 工具 | `lib/utils.ts` = `twMerge(clsx(...))`，所有 className 走它 | `lib/utils.ts` |
| 特性视图 | `views/<feature>/` 页面级文件夹（home/channels/dashboard/settings…），内部再拆子组件 | `views/home/...` |
| 布局壳 | `layouts/{navigation,header,sidebar,footer}/`，shell 零件 | `layouts/` |
| 全局 UI 态 | `context/ConfigContext`（theme/sidebar/rightSidebar/currency），dispatcher 模式 + localStorage 持久化 | `context/` |
| Hooks | `hooks/`（UseLocalStorage/UseInterval/UseElementSize…），纯逻辑复用 | `hooks/` |
| 路由 | `react-router-dom`，`pages/*.tsx` 一个路由一页 | `pages/` |
| 移动端 | `lg` 断点切换：固定 sidebar ↔ Sheet 抽屉；`Header` 有 mobile 分支 | `Header.tsx:67-104` |

**核心启发**：UI 原语（`components/ui/*`）+ 特性视图（`views/*`）+ 布局壳（`layouts/*`）+ 全局态（`context/*`）四层分工，让任何一处改动只动一个文件。

### 8.3 提议的目录结构（`apps/evidence-web`）

照 ThunderHub 的四层分工，落到 Fiber Paid HTTP 约束（单 app、静态产物、`server.mjs` 服役）：

```
apps/evidence-web/
├─ vite.config.ts            # Vite 构建：react + tailwind，产物 dist/
├─ tsconfig.json             # 严格 TS（与 workspace 对齐）
├─ package.json              # build/dev/typecheck/lint 脚本
├─ server.mjs                # 保留：服役 dist/index.html + 静态资源（见 8.5）
├─ scripts/
│  ├─ check-layout.mjs       # 保留并演进（读 dist/）
│  ├─ check-action-coverage.mjs
│  ├─ check-browser-smoke.mjs
│  └─ check-build.mjs        # 新：替代 check-static 的「产物含必需 DOM 锚点」断言
├─ index.html                # Vite 入口模板（仅 <div id="root"> + 脚本注入）
└─ src/
   ├─ main.tsx               # 挂载 <App/>，启动期拉 /api/status 配置
   ├─ App.tsx                # <AppShell> 路由 + providers 组合
   ├─ styles/
   │  └─ globals.css         # Tailwind v4 + 设计 token（见 8.6）
   ├─ lib/
   │  ├─ utils.ts            # cn()
   │  ├─ api.ts              # getJson/postJson 封装（现内联 JS 抽出）
   │  └─ session.ts          # consoleSessionId / routeParams（现内联）
   ├─ components/
   │  ├─ ui/                 # shadcn 风格原语
   │  │  ├─ button.tsx  badge.tsx  card.tsx  chip.tsx
   │  │  ├─ dialog.tsx  sheet.tsx  popover.tsx  tooltip.tsx
   │  │  ├─ tabs.tsx   select.tsx  input.tsx   checkbox.tsx
   │  │  └─ kv-row.tsx panel.tsx   icon.tsx    ...
   │  └─ evidence/           # 跨视图复用的证据组件
   │     ├─ ParityBar.tsx  ReportList.tsx  JsonViewer.tsx
   │     └─ StatusBadge.tsx EngineStance.tsx
   ├─ layouts/
   │  ├─ AppShell.tsx        # header/sidebar/main/inspector 网格壳
   │  ├─ Header.tsx          # mark + 连接点 + Refresh + Prefs + Settings
   │  ├─ Sidebar.tsx         # 垂直导航 + 底部状态簇（5 徽章）
   │  ├─ InspectorDrawer.tsx # 右栏：EventLog + Service + Attack widget
   │  └─ PreferencesPopover.tsx  # 顶栏轻量开关
   ├─ views/
   │  ├─ flow/               # RequestScenario + Timeline（hero）
   │  ├─ bootstrap/          # 只读检查结果
   │  ├─ evidence/           # 三段式：parity / report-list / json
   │  ├─ attacks/            # replay 拒绝演示
   │  └─ network/            # 本地路由上下文
   ├─ settings/
   │  └─ SettingsDrawer.tsx  # 唯一配置入口（5 段：见 §5.2）
   ├─ context/
   │  ├─ ConfigContext.tsx   # density/live/motion/inspector/persona/accent
   │  └─ EvidenceContext.tsx # 流程状态机（现 state 对象）
   └─ hooks/
      ├─ useLocalStorage.ts  # 持久化偏好
      ├─ useAutoRefresh.ts   # scheduleAutoRefresh 抽出
      └─ useEvidenceFlow.ts  # send/pay/retry/replay 动作编排
```

**文件粒度原则**（对齐 ThunderHub）：每个组件一个文件、≤ ~150 行；超过就拆子组件进同名子目录（如 `views/flow/Timeline.tsx` → `views/flow/timeline/Step.tsx`）。

### 8.4 检查脚本的演进（关键：不能丢护栏）

现 `check-static.mjs` 的 200+ `requiredHtmlFragments` 把**源码内部实现**（class 名、函数名、动画名）也钉死了 —— 这是阻碍重构的根因。迁移策略：

1. **把「DOM 锚点」与「内部实现」分离**：只保留**外部契约**级锚点（被 `check-action-coverage` / `check-layout` / 集成测试引用的元素 ID、`data-panel-id`、`data-workspace`、关键 `aria-label`、后端端点字符串）。删除纯内部实现断言（如 `shell-scan`、`function renderSettings()`、`classList.toggle("is-busy"`）—— 这些应由**单元测试**守护，而非 grep。
2. **新 `check-build.mjs` 读 `dist/index.html`**：断言构建产物含上述外部契约锚点。这样源码自由重构，只要产物暴露约定的 ID/属性即可。
3. **`check-layout.mjs` / `check-action-coverage.mjs` 不变**：它们本就读产物（headless 截图 / grep），只是把路径从 `index.html` 改到 `dist/index.html`。
4. **`sync-icons.tsx` 退役**：React 直接 `import { Settings } from "lucide-react"`，tree-shake 按需，不再内联 sprite。
5. **补单元测试**：对 Timeline 状态机、`normalizeApiBase`、`runtimeBootstrapBody`、`personaActionReason` 等纯逻辑用 vitest 覆盖，替代被移除的 grep 断言。

> **护栏不减弱，只是从「钉死源码字符串」升级为「钉死外部契约 + 单元测试」**，反而更稳。

### 8.5 静态产物不变（保留 `server.mjs`）

- Vite `build` 产出 `dist/`（`index.html` + hash 化 `assets/*.js` `*.css`）。
- `server.mjs` 改为服役 `dist/`（`root` 指向 `dist`），安全头/路径校验逻辑原样保留。
- 仍可被 `apps/evidence-api` 作为静态中间件嵌入；仍支持 `PORT` / `FIBER_PAID_HTTP_EVIDENCE_API_BASE` 环境变量。
- 开发期 `vite dev` 代理 `/api` → evidence-api（对齐 ThunderHub `vite.config.ts:server.proxy`）。

### 8.6 设计 token 化（替代手写 CSS 变量散落）

现 `:root`（`index.html:8-32`）的 token 直接照搬进 `src/styles/globals.css`，用 Tailwind v4 的 `@theme` 暴露成工具类，并补 `.dark`（虽默认 dark，但为密度/persona 切换留口）：

```css
@import "tailwindcss";
@custom-variant dark (&:is(.dark *));

@theme {
  --color-bg: #061013;
  --color-panel: rgba(9,24,29,.86);
  --color-line: rgba(81,235,235,.16);
  --color-cyan: #32e6ef;
  --color-green: #39e7ad;
  --color-orange: #ffb24a;
  --color-red: #ff635f;
  --color-text: #e7f5f6;
  --color-muted: #8aa2aa;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
}
```

之后 `bg-panel text-muted border-line` 等工具类即用，配色语义统一（绿=pass/青=进行/橙=warn/红=reject）。

### 8.7 为什么不是「大爆炸重写」

- 200+ 锚点 + 集成测试 + gate 依赖 → 一次性重写风险极高。
- 采用 **strangler（绞杀者）模式**：Phase 0 先建 Vite 骨架 + 把现有 UI **1:1 移植**进组件（行为零变化、产物等价、检查照过），随后 Phase 1–4 在干净组件树上做信息架构调整，每阶段独立可回滚、可验证。
- 这正是 ThunderHub 把 `views/home`、`views/channels` 逐特性拆分的同款粒度。

---

## 9. 迁移计划（脱离单文件 + 守护既有检查）

### 9.1 必须守护的约束
- 现状仍是**单文件静态 `index.html`**（CSS/JS 内联）；Phase 0 起迁移到 Vite 组件树（见 §8），此后以构建产物 `dist/` 为准。
- `scripts/check-layout.mjs` 断言每个 workspace 的 panel 可见集合（`bootstrap:[roles,bootstrap,network]` / `flow:[request,timeline,evidence]` / `evidence:[network,evidence]`）与 tab jitter ≤ 1px，并在 8 个视口（390–1440）截图。
- `scripts/check-action-coverage.mjs` 用**元素 ID + 事件绑定字符串**做 grep 匹配（如 `$("#api-settings").addEventListener("submit"`、`id="open-settings"`、`id="api-apply"` 等），并映射到后端端点与集成测试。
- 2185 行 JS 绑定了大量固定 ID（`workspace-tabs`、`settings-*`、`bootstrap-*`、`payer-profile`…）；迁移到组件后这些 ID 须由组件渲染保留（见 §8.4）。

> **铁律：先建组件骨架（Phase 0），再做布局重排。** 单文件是重构的最大负债（见 §8），在 5400 行内做四轮重排只会让负债雪球。先用 Vite 把源码拆成组件树、保证产物等价、检查照过，再在干净的组件上做信息架构调整。

### 9.2 分阶段（每阶段跑：`lint` + `check-layout` + `check-action-coverage` + `check-browser-smoke`）

**Phase 0 — 审计映射 + 组件骨架（基础）**
- 从 `check-action-coverage.mjs` 与 JS `addEventListener` 全量提取「ID ↔ handler ↔ 后端端点」表，作为重构基线。
- 引入 Vite 构建 + 源码拆分组件树（§8），**1:1 移植**现有 HTML/CSS/JS，行为零变化。
- 产物 `dist/index.html` 等价于现 `index.html`；静态检查改读构建产物（见 §8.4）。

**Phase 1 — 重排 Shell（在组件上）**
- 引入 `AppShell` 网格：`Header / [Sidebar | Main | Inspector]`。
- 现有 panel 组件原样搬进新区域，**保留全部 DOM ID 与 `data-*`**。
- 横向 `workspace-tabs` → `Sidebar` 垂直导航（复用 `data-workspace-tab` 机制）。
- 若 panel 归属变化，同步改 `check-layout.mjs` 的 `expectedPanels`。

**Phase 2 — 配置迁入 Settings**
- bootstrap runtime 表单 + roles + payment params 搬进 `SettingsDrawer`（其 `settings-*` 镜像 ID 已存在，合并去重）。
- bootstrap workspace 仅留结果渲染。
- 更新 `check-action-coverage.mjs` 中受影响控件的 `frontend` handler 字符串与归属。

**Phase 3 — 构建 Inspector**
- terminal log + service actuator + attack widget 迁入 `InspectorDrawer`。
- 接入 `PanelRight` 开关（`PreferencesPopover` 模式）。

**Phase 4 — 视觉收敛**
- 统一 chip 系统、密度生效、移除冗余动效、加大留白、统一 panel header。

### 9.3 风险与对策
| 风险 | 对策 |
| --- | --- |
| 改 ID 破坏 action-coverage | 用 Phase 0 映射表逐项核对；任何 ID 变更同步改 check 脚本 |
| 改 panel 归属破坏 layout 检查 | 同步更新 `expectedPanels`；先用 headless 截图回归 8 视口 |
| 配置迁走后用户找不到 | Flow/Bootstrap 主区顶部加「Configure in Settings →」引导 chip；PreferencesPopover 放高频开关 |
| 移动端挤压 | 严格按断点表降级为 Sheet（参考 Header mobile 分支） |
| 组件化破坏 200+ grep 锚点 | 按 §8.4 把锚点从「钉源码字符串」升级为「钉产物外部契约 + 单元测试」 |

---

## 10. 产品边界（重构不得越界）

沿用 `docs/evidence-console-frontend-plan.md` 的 Product Boundary：

- console 只可视化**一个** Fiber Paid HTTP 证明流程；**不**做 Fiber 节点监控/通道管理/余额图表/钱包/checkout/市场。
- Network workspace 只展示理解证明所需的最小本地路由，不加通道开闭或拓扑图。
- TypeScript 不得暗示生产可信边界（`typescript_trusted_boundary: false`）。
- `production_ready_for_fiber_method` 仍由 gate 报告驱动，UI 不擅自置 true。

---

## 11. 一句话总结

> 把**配置**全部收进 Settings、把**导航与常驻状态**收进左侧 Sidebar、把**诊断日志**收进右侧 Inspector，让主区只专注「一条可验证的支付证明流程在流动」—— 整齐来自分区单一职责，酷炫来自时间轴状态迁移，而非堆砌装饰。
