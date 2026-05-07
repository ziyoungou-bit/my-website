/**
 * 扰流柱冷板优化研究台账
 * Pin-fin Cold Plate Optimization Logbook
 *
 * 单文件 React 组件，用 Tailwind 样式。
 * 设计目标：低摩擦录入 CFD 算例 → 自动算导出指标 → Pareto 图找最优。
 */

import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Plus, Search, Download, Upload, Trash2, Pencil, Copy,
  Sun, Moon, X, ChevronDown, ChevronRight, Check,
  GitCompare, ScatterChart, LineChart, Filter, Star,
  AlertCircle, Layers, Settings2,
} from "lucide-react";

// =============================================================================
// 常量与预设
// =============================================================================

// 工质物性（约 25°C 进口温度，工程近似值）
// rho [kg/m^3], mu [Pa·s], k [W/(m·K)], cp [J/(kg·K)]
const FLUID_PRESETS = {
  "Water":          { rho: 997,  mu: 0.00089, k: 0.606, cp: 4186 },
  "PAO":            { rho: 830,  mu: 0.018,   k: 0.137, cp: 2200 },
  "Novec 7100":     { rho: 1510, mu: 0.00058, k: 0.069, cp: 1183 },
  "Galden HT-200":  { rho: 1700, mu: 0.0029,  k: 0.07,  cp: 970  },
  "50/50 EGW":      { rho: 1071, mu: 0.0034,  k: 0.39,  cp: 3380 },
};

const SHAPES = ["圆柱", "方柱", "菱形", "水滴形", "椭圆", "翼型", "自定义"];
const ARRANGEMENTS = ["顺排", "叉排"];
const STATUSES = ["进行中", "已完成", "失败", "已归档"];
const SOLVERS = ["Fluent", "COMSOL", "OpenFOAM", "Star-CCM+", "其他"];
const TURB_MODELS = ["层流", "k-ε", "k-ω SST", "LES", "其他"];

// 形状颜色（散点图配色）
const SHAPE_COLORS = {
  "圆柱":   "#4F46E5",
  "方柱":   "#DC2626",
  "菱形":   "#059669",
  "水滴形": "#D97706",
  "椭圆":   "#7C3AED",
  "翼型":   "#0891B2",
  "自定义": "#6B7280",
};

// 状态颜色
const STATUS_STYLES = {
  "进行中": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "已完成": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  "失败":   "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  "已归档": "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

// =============================================================================
// 纯计算函数（独立可测试）
// =============================================================================

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Reynolds 数：Re = ρ · u · D / μ
 * @param rho [kg/m^3], u [m/s], D_mm [mm], mu [Pa·s]
 * @returns 无量纲；输入不全或非正则返回 null
 */
function calcRe({ rho, u, D_mm, mu }) {
  if (![rho, u, D_mm, mu].every(isNum)) return null;
  if (rho <= 0 || u <= 0 || D_mm <= 0 || mu <= 0) return null;
  return (rho * u * (D_mm / 1000)) / mu;
}

/**
 * 进口流速：u = ṁ / (ρ · A_freestream)
 * 这里近似用流道横截面（不含柱）：A = W · H_channel
 */
function calcUFromMdot({ mdot_g_s, rho, W_mm, H_mm }) {
  if (![mdot_g_s, rho, W_mm, H_mm].every(isNum)) return null;
  if (rho <= 0 || W_mm <= 0 || H_mm <= 0) return null;
  const A = (W_mm / 1000) * (H_mm / 1000);
  return (mdot_g_s / 1000) / (rho * A);
}

/**
 * 热阻：R_th = (T_max - T_in) / Q
 * @returns [K/W]
 */
function calcRth({ Tmax, Tin, Q }) {
  if (![Tmax, Tin, Q].every(isNum)) return null;
  if (Q <= 0) return null;
  return (Tmax - Tin) / Q;
}

/**
 * 泵功率：P_pump = ΔP · V̇ = ΔP · ṁ / ρ
 * @param dP_kPa [kPa], mdot_g_s [g/s], rho [kg/m^3]
 * @returns [W]
 */
function calcPumpPower({ dP_kPa, mdot_g_s, rho }) {
  if (![dP_kPa, mdot_g_s, rho].every(isNum)) return null;
  if (rho <= 0) return null;
  const dP_Pa = dP_kPa * 1000;
  const mdot = mdot_g_s / 1000;
  return (dP_Pa * mdot) / rho;
}

/**
 * 性能评价准则：PEC = (Nu/Nu_ref) / (f/f_ref)^(1/3)
 * 用于热-阻-动力综合评价（同等泵功率下的换热增益）
 */
function calcPEC({ Nu, Nu_ref, f, f_ref }) {
  if (![Nu, Nu_ref, f, f_ref].every(isNum)) return null;
  if (Nu <= 0 || Nu_ref <= 0 || f <= 0 || f_ref <= 0) return null;
  return (Nu / Nu_ref) / Math.cbrt(f / f_ref);
}

/**
 * 非支配排序找 Pareto 前沿（最小化 x 和 y）
 * 一个点 p 被 q 支配：q.x ≤ p.x ∧ q.y ≤ p.y ∧ 至少一项严格小于
 */
function findParetoFront(points) {
  return points.filter(p =>
    !points.some(q =>
      q.id !== p.id && q.x <= p.x && q.y <= p.y && (q.x < p.x || q.y < p.y)
    )
  );
}

// =============================================================================
// 派生工具：从原始 case 算出物性、流量、Re、Rth、Ppump
// =============================================================================

function getFluidProps(c) {
  if (c.fluid === "自定义" && c.fluid_custom) return c.fluid_custom;
  return FLUID_PRESETS[c.fluid] || null;
}

function getMassFlow(c) {
  // 返回 g/s
  if (c.flow_mode === "mdot") return isNum(c.mdot) ? c.mdot : null;
  if (c.flow_mode === "u") {
    const props = getFluidProps(c);
    if (!props || !isNum(c.u_in) || !isNum(c.channel_W) || !isNum(c.channel_H)) return null;
    const A = (c.channel_W / 1000) * (c.channel_H / 1000);
    return c.u_in * props.rho * A * 1000; // kg/s → g/s
  }
  return null;
}

function getInletVelocity(c) {
  // 返回 m/s
  if (c.flow_mode === "u") return isNum(c.u_in) ? c.u_in : null;
  if (c.flow_mode === "mdot") {
    const props = getFluidProps(c);
    if (!props) return null;
    return calcUFromMdot({ mdot_g_s: c.mdot, rho: props.rho, W_mm: c.channel_W, H_mm: c.channel_H });
  }
  return null;
}

function getHeatLoad(c) {
  // 返回 W；q" 模式下用 q" × A_base（用流道底面）
  if (c.heat_mode === "Q") return isNum(c.Q_total) ? c.Q_total : null;
  if (c.heat_mode === "q") {
    if (!isNum(c.q_flux) || !isNum(c.channel_L) || !isNum(c.channel_W)) return null;
    const A_cm2 = (c.channel_L / 10) * (c.channel_W / 10); // mm × mm → cm²
    return c.q_flux * A_cm2;
  }
  return null;
}

/**
 * 给一条 case 算出所有衍生量：返回 { ...c, _derived: {...} }
 */
function deriveCase(c) {
  const props = getFluidProps(c);
  const mdot_g_s = getMassFlow(c);
  const u = getInletVelocity(c);
  const Q = getHeatLoad(c);

  // Re：优先用用户填的，否则自己算
  let Re = isNum(c.Re_input) ? c.Re_input : null;
  let Re_auto = false;
  if (Re == null && props && isNum(u) && isNum(c.D)) {
    Re = calcRe({ rho: props.rho, u, D_mm: c.D, mu: props.mu });
    Re_auto = Re != null;
  }

  const Rth = calcRth({ Tmax: c.T_max, Tin: c.T_in, Q });
  const Ppump = props ? calcPumpPower({ dP_kPa: c.dP, mdot_g_s, rho: props.rho }) : null;

  // 间距比
  const ST_D = isNum(c.S_T) && isNum(c.D) && c.D > 0 ? c.S_T / c.D : null;
  const SL_D = isNum(c.S_L) && isNum(c.D) && c.D > 0 ? c.S_L / c.D : null;

  return {
    ...c,
    _derived: { Re, Re_auto, Rth, Ppump, mdot_g_s, u, Q, ST_D, SL_D, props },
  };
}

// =============================================================================
// CSV 导入导出
// =============================================================================

const CSV_FIELDS = [
  "id", "date", "tags", "status",
  "shape", "arrangement", "D", "H", "S_T", "S_L",
  "channel_L", "channel_W", "channel_H",
  "fluid", "fluid_rho", "fluid_mu", "fluid_k", "fluid_cp",
  "heat_mode", "q_flux", "Q_total", "T_in",
  "flow_mode", "mdot", "u_in", "Re_input",
  "solver", "turb_model", "mesh_wan", "remarks",
  "T_max", "T_base_avg", "dP", "Nu", "f",
];

function escapeCSV(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function casesToCSV(cases) {
  const lines = [CSV_FIELDS.join(",")];
  for (const c of cases) {
    const fc = c.fluid_custom || {};
    const row = {
      id: c.id, date: c.date, tags: (c.tags || []).join("|"), status: c.status,
      shape: c.shape, arrangement: c.arrangement, D: c.D, H: c.H, S_T: c.S_T, S_L: c.S_L,
      channel_L: c.channel_L, channel_W: c.channel_W, channel_H: c.channel_H,
      fluid: c.fluid, fluid_rho: fc.rho, fluid_mu: fc.mu, fluid_k: fc.k, fluid_cp: fc.cp,
      heat_mode: c.heat_mode, q_flux: c.q_flux, Q_total: c.Q_total, T_in: c.T_in,
      flow_mode: c.flow_mode, mdot: c.mdot, u_in: c.u_in, Re_input: c.Re_input,
      solver: c.solver, turb_model: c.turb_model, mesh_wan: c.mesh_wan, remarks: c.remarks,
      T_max: c.T_max, T_base_avg: c.T_base_avg, dP: c.dP, Nu: c.Nu, f: c.f,
    };
    lines.push(CSV_FIELDS.map(k => escapeCSV(row[k])).join(","));
  }
  return lines.join("\n");
}

function parseCSVLine(line) {
  const cells = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function csvToCases(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]);
  const num = (v) => v === "" || v == null ? null : (isNaN(+v) ? null : +v);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    const r = {}; header.forEach((h, j) => r[h] = cells[j] ?? "");
    const c = {
      id: r.id || `case-${Date.now()}-${i}`,
      date: r.date || "",
      tags: r.tags ? r.tags.split("|").filter(Boolean) : [],
      status: r.status || "已完成",
      shape: r.shape || "圆柱", arrangement: r.arrangement || "顺排",
      D: num(r.D), H: num(r.H), S_T: num(r.S_T), S_L: num(r.S_L),
      channel_L: num(r.channel_L), channel_W: num(r.channel_W), channel_H: num(r.channel_H),
      fluid: r.fluid || "Water",
      fluid_custom: (num(r.fluid_rho) != null) ? {
        rho: num(r.fluid_rho), mu: num(r.fluid_mu), k: num(r.fluid_k), cp: num(r.fluid_cp),
      } : null,
      heat_mode: r.heat_mode || "Q",
      q_flux: num(r.q_flux), Q_total: num(r.Q_total), T_in: num(r.T_in),
      flow_mode: r.flow_mode || "mdot",
      mdot: num(r.mdot), u_in: num(r.u_in), Re_input: num(r.Re_input),
      solver: r.solver || "", turb_model: r.turb_model || "",
      mesh_wan: num(r.mesh_wan), remarks: r.remarks || "",
      T_max: num(r.T_max), T_base_avg: num(r.T_base_avg),
      dP: num(r.dP), Nu: num(r.Nu), f: num(r.f),
    };
    out.push(c);
  }
  return out;
}

// =============================================================================
// 种子数据：8 条算例（Water，T_in=25°C，Q=200W，覆盖典型设计空间）
// =============================================================================
const SEED_CASES = [
  {
    id: "C-001", date: "2025-03-12", tags: ["圆柱", "顺排", "基线"], status: "已完成",
    shape: "圆柱", arrangement: "顺排",
    D: 2.0, H: 4.0, S_T: 4.0, S_L: 4.0,
    channel_L: 50, channel_W: 30, channel_H: 4,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: 200, T_in: 25,
    flow_mode: "mdot", mdot: 4, u_in: null, Re_input: null,
    solver: "Fluent", turb_model: "层流", mesh_wan: 180, remarks: "基线参考算例",
    T_max: 68.5, T_base_avg: 58.2, dP: 4.8, Nu: 24.5, f: 0.180,
  },
  {
    id: "C-002", date: "2025-03-14", tags: ["圆柱", "叉排"], status: "已完成",
    shape: "圆柱", arrangement: "叉排",
    D: 2.0, H: 4.0, S_T: 4.0, S_L: 4.0,
    channel_L: 50, channel_W: 30, channel_H: 4,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: 200, T_in: 25,
    flow_mode: "mdot", mdot: 4, u_in: null, Re_input: null,
    solver: "Fluent", turb_model: "k-ω SST", mesh_wan: 220, remarks: "叉排相比顺排换热更强但压降更大",
    T_max: 60.0, T_base_avg: 51.0, dP: 8.2, Nu: 32.0, f: 0.275,
  },
  {
    id: "C-003", date: "2025-03-18", tags: ["圆柱", "叉排", "高 Re"], status: "已完成",
    shape: "圆柱", arrangement: "叉排",
    D: 2.0, H: 4.0, S_T: 4.0, S_L: 4.0,
    channel_L: 50, channel_W: 30, channel_H: 4,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: 200, T_in: 25,
    flow_mode: "mdot", mdot: 12, u_in: null, Re_input: null,
    solver: "Fluent", turb_model: "k-ω SST", mesh_wan: 280, remarks: "高流量下换热提升明显",
    T_max: 45.5, T_base_avg: 39.8, dP: 38.5, Nu: 65.0, f: 0.215,
  },
  {
    id: "C-004", date: "2025-03-22", tags: ["圆柱", "顺排", "小直径"], status: "已完成",
    shape: "圆柱", arrangement: "顺排",
    D: 1.5, H: 4.0, S_T: 3.0, S_L: 3.0,
    channel_L: 50, channel_W: 30, channel_H: 4,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: 200, T_in: 25,
    flow_mode: "mdot", mdot: 8, u_in: null, Re_input: null,
    solver: "Fluent", turb_model: "层流", mesh_wan: 240, remarks: "更密集的小直径柱阵",
    T_max: 52.3, T_base_avg: 44.6, dP: 13.5, Nu: 40.0, f: 0.165,
  },
  {
    id: "C-005", date: "2025-03-26", tags: ["水滴形", "叉排"], status: "已完成",
    shape: "水滴形", arrangement: "叉排",
    D: 2.0, H: 4.0, S_T: 4.0, S_L: 4.0,
    channel_L: 50, channel_W: 30, channel_H: 4,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: 200, T_in: 25,
    flow_mode: "mdot", mdot: 8, u_in: null, Re_input: null,
    solver: "Fluent", turb_model: "k-ω SST", mesh_wan: 320, remarks: "水滴形减少形阻，综合性能好",
    T_max: 50.2, T_base_avg: 42.5, dP: 9.5, Nu: 50.0, f: 0.122,
  },
  {
    id: "C-006", date: "2025-04-02", tags: ["水滴形", "叉排", "高 Re"], status: "已完成",
    shape: "水滴形", arrangement: "叉排",
    D: 2.0, H: 4.0, S_T: 4.0, S_L: 4.0,
    channel_L: 50, channel_W: 30, channel_H: 4,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: 200, T_in: 25,
    flow_mode: "mdot", mdot: 16, u_in: null, Re_input: null,
    solver: "Fluent", turb_model: "k-ω SST", mesh_wan: 340, remarks: "Pareto 候选",
    T_max: 42.0, T_base_avg: 36.5, dP: 24.0, Nu: 75.0, f: 0.108,
  },
  {
    id: "C-007", date: "2025-04-08", tags: ["翼型", "叉排"], status: "已完成",
    shape: "翼型", arrangement: "叉排",
    D: 3.0, H: 4.0, S_T: 5.0, S_L: 5.0,
    channel_L: 50, channel_W: 30, channel_H: 4,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: 200, T_in: 25,
    flow_mode: "mdot", mdot: 18, u_in: null, Re_input: null,
    solver: "Fluent", turb_model: "k-ω SST", mesh_wan: 380, remarks: "NACA 0020 截面，最低形阻",
    T_max: 39.8, T_base_avg: 34.2, dP: 19.5, Nu: 85.0, f: 0.087,
  },
  {
    id: "C-008", date: "2025-04-15", tags: ["方柱", "顺排"], status: "已完成",
    shape: "方柱", arrangement: "顺排",
    D: 2.0, H: 4.0, S_T: 4.0, S_L: 4.0,
    channel_L: 50, channel_W: 30, channel_H: 4,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: 200, T_in: 25,
    flow_mode: "mdot", mdot: 6, u_in: null, Re_input: null,
    solver: "Fluent", turb_model: "k-ω SST", mesh_wan: 200, remarks: "方柱形阻显著",
    T_max: 58.0, T_base_avg: 49.5, dP: 14.5, Nu: 35.0, f: 0.32,
  },
];

// =============================================================================
// UI 工具组件
// =============================================================================

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_STYLES[status] || STATUS_STYLES["已完成"]}`}>
      {status}
    </span>
  );
}

function Field({ label, hint, children, required }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
          {label}{required && <span className="text-rose-500 ml-0.5">*</span>}
        </span>
        {hint && <span className="text-[10px] text-slate-400 dark:text-slate-500">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

const inputCls = "w-full px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 tabular-nums transition-colors";

function NumInput({ value, onChange, placeholder, step = "any" }) {
  return (
    <input
      type="number"
      step={step}
      className={inputCls}
      value={value == null || value === "" ? "" : value}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : parseFloat(v));
      }}
    />
  );
}

function TextInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      className={inputCls}
      value={value || ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Select({ value, onChange, options }) {
  return (
    <select className={inputCls + " pr-7 appearance-none bg-no-repeat bg-[right_0.5rem_center]"}
            style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' stroke='%2394a3b8' fill='none' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")" }}
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}>
      {options.map(o => {
        const isObj = typeof o === "object" && o !== null;
        const v = isObj ? o.value : o;
        const l = isObj ? o.label : o;
        return <option key={v} value={v}>{l}</option>;
      })}
    </select>
  );
}

function SegToggle({ value, onChange, options }) {
  return (
    <div className="inline-flex bg-slate-100 dark:bg-slate-800 rounded p-0.5 text-xs">
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  value === o.value
                    ? "bg-white dark:bg-slate-700 shadow-sm font-medium text-slate-900 dark:text-slate-100"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                }`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, icon: Icon, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-slate-200 dark:border-slate-800 last:border-0">
      <button type="button" onClick={() => setOpen(o => !o)}
              className="w-full flex items-center justify-between py-2.5 text-left">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={14} className="text-slate-400" />}
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">{title}</span>
        </div>
        <ChevronDown size={14} className={`text-slate-400 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="pb-4 space-y-3">{children}</div>}
    </div>
  );
}

// =============================================================================
// 扰流柱阵列俯视 SVG（详情面板用）
// =============================================================================

function PinFinLayout({ caseData }) {
  const c = caseData;
  if (!isNum(c.channel_L) || !isNum(c.channel_W) || !isNum(c.D) || !isNum(c.S_T) || !isNum(c.S_L)) {
    return <div className="text-xs text-slate-400 italic">几何参数不完整</div>;
  }

  const W = 280, H = Math.max(80, W * c.channel_W / c.channel_L);
  const scale = W / c.channel_L; // mm → px

  // 计算柱阵
  const pins = [];
  const nCol = Math.floor(c.channel_L / c.S_L);
  const nRow = Math.floor(c.channel_W / c.S_T);
  const offX = (c.channel_L - (nCol - 1) * c.S_L) / 2;
  const offY = (c.channel_W - (nRow - 1) * c.S_T) / 2;
  for (let j = 0; j < nRow; j++) {
    const shift = (c.arrangement === "叉排" && j % 2 === 1) ? c.S_L / 2 : 0;
    for (let i = 0; i < nCol; i++) {
      const xMm = offX + i * c.S_L + shift;
      const yMm = offY + j * c.S_T;
      if (xMm > 0 && xMm < c.channel_L) pins.push({ x: xMm * scale, y: yMm * scale });
    }
  }
  const r = (c.D / 2) * scale;

  const drawPin = (p, idx) => {
    const color = SHAPE_COLORS[c.shape] || "#64748b";
    if (c.shape === "方柱") {
      return <rect key={idx} x={p.x - r} y={p.y - r} width={2 * r} height={2 * r} fill={color} fillOpacity="0.85" />;
    }
    if (c.shape === "菱形") {
      return <polygon key={idx} points={`${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}`} fill={color} fillOpacity="0.85" />;
    }
    if (c.shape === "水滴形") {
      return <path key={idx} d={`M ${p.x - r} ${p.y} A ${r} ${r} 0 1 1 ${p.x + r} ${p.y} L ${p.x + 2 * r} ${p.y} Z`} fill={color} fillOpacity="0.85" />;
    }
    if (c.shape === "椭圆") {
      return <ellipse key={idx} cx={p.x} cy={p.y} rx={r * 1.4} ry={r * 0.7} fill={color} fillOpacity="0.85" />;
    }
    if (c.shape === "翼型") {
      const len = r * 3;
      return <path key={idx} d={`M ${p.x - r} ${p.y} Q ${p.x} ${p.y - r * 0.7} ${p.x + len * 0.7} ${p.y - r * 0.2} L ${p.x + len * 0.7} ${p.y + r * 0.2} Q ${p.x} ${p.y + r * 0.7} ${p.x - r} ${p.y} Z`} fill={color} fillOpacity="0.85" />;
    }
    return <circle key={idx} cx={p.x} cy={p.y} r={r} fill={color} fillOpacity="0.85" />;
  };

  return (
    <div>
      <svg viewBox={`-10 -10 ${W + 20} ${H + 20}`} className="w-full">
        {/* 流道边界 */}
        <rect x="0" y="0" width={W} height={H} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1" className="text-slate-400" />
        {/* 流向箭头 */}
        <g className="text-slate-400">
          <path d={`M -8 ${H / 2} L -3 ${H / 2}`} stroke="currentColor" strokeOpacity="0.6" strokeWidth="1.2" markerEnd="url(#arrow)" />
        </g>
        <defs>
          <marker id="arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="currentColor" className="text-slate-400" />
          </marker>
        </defs>
        {pins.map(drawPin)}
      </svg>
      <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">
        {nCol} × {nRow} 阵列 ｜ S_T/D = {(c.S_T / c.D).toFixed(2)}, S_L/D = {(c.S_L / c.D).toFixed(2)}
      </div>
    </div>
  );
}

// =============================================================================
// Pareto 散点图（核心可视化）
// =============================================================================

function ParetoPlot({ cases, filteredIds, selectedId, onSelect, refId }) {
  const [hoverId, setHoverId] = useState(null);

  // 取所有有效点
  const points = useMemo(() => {
    return cases
      .map(c => ({ ...c, _x: c._derived.Ppump, _y: c._derived.Rth }))
      .filter(c => isNum(c._x) && c._x > 0 && isNum(c._y));
  }, [cases]);

  if (points.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-slate-400">
        没有有效算例可绘制 — 添加算例并填好压降、流量、热阻所需字段
      </div>
    );
  }

  // 坐标范围
  const xs = points.map(p => p._x), ys = points.map(p => p._y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  // 对数 X 轴边界（向 10^k 取整稍扩展）
  const logXMin = Math.floor(Math.log10(xMin)) - 0.1;
  const logXMax = Math.ceil(Math.log10(xMax)) + 0.1;
  // 线性 Y 轴边界
  const yPad = (yMax - yMin) * 0.12 || 0.01;
  const yLo = Math.max(0, yMin - yPad), yHi = yMax + yPad;

  const W = 720, H = 440;
  const M = { l: 64, r: 24, t: 24, b: 56 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const xScale = (x) => M.l + ((Math.log10(x) - logXMin) / (logXMax - logXMin)) * iw;
  const yScale = (y) => M.t + (1 - (y - yLo) / (yHi - yLo)) * ih;

  // 对数刻度 ticks
  const xTicks = [];
  for (let p = Math.ceil(logXMin); p <= Math.floor(logXMax); p++) {
    xTicks.push(Math.pow(10, p));
  }
  // Y 轴 ticks（5–6 个 nice 数字）
  const niceStep = (range, n) => {
    const raw = range / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  };
  const ySpan = yHi - yLo;
  const yStep = niceStep(ySpan, 5);
  const yTicks = [];
  let yt = Math.ceil(yLo / yStep) * yStep;
  while (yt <= yHi) { yTicks.push(+yt.toFixed(6)); yt += yStep; }

  // Pareto 前沿（用筛选后的点算，让筛选有意义）
  const visiblePoints = points.filter(p => filteredIds.has(p.id));
  const front = useMemo(() => {
    return findParetoFront(visiblePoints.map(p => ({ id: p.id, x: p._x, y: p._y })))
      .sort((a, b) => a.x - b.x);
  }, [visiblePoints]);
  const frontIds = new Set(front.map(f => f.id));

  // 点形状（按排列）
  const renderMarker = (p, hovered) => {
    const filled = p.arrangement === "顺排";
    const r = hovered ? 8 : (frontIds.has(p.id) ? 6.5 : 5);
    if (filled) {
      return <circle cx={xScale(p._x)} cy={yScale(p._y)} r={r}
                     fill={SHAPE_COLORS[p.shape]} stroke="#fff" strokeWidth={hovered ? 2 : 1.2} />;
    } else {
      // 空心钻石（叉排）
      const cx = xScale(p._x), cy = yScale(p._y);
      const s = r + 1;
      return <polygon points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
                      fill="white" stroke={SHAPE_COLORS[p.shape]} strokeWidth={hovered ? 2.5 : 1.8} />;
    }
  };

  const hoverPoint = points.find(p => p.id === hoverId);

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none">
        {/* 背景网格 */}
        <g className="text-slate-200 dark:text-slate-800">
          {xTicks.map((t, i) => (
            <line key={`xg${i}`} x1={xScale(t)} y1={M.t} x2={xScale(t)} y2={H - M.b}
                  stroke="currentColor" strokeWidth="1" />
          ))}
          {yTicks.map((t, i) => (
            <line key={`yg${i}`} x1={M.l} y1={yScale(t)} x2={W - M.r} y2={yScale(t)}
                  stroke="currentColor" strokeWidth="1" />
          ))}
        </g>

        {/* 坐标轴 */}
        <g className="text-slate-400 dark:text-slate-500">
          <line x1={M.l} y1={H - M.b} x2={W - M.r} y2={H - M.b} stroke="currentColor" strokeWidth="1.2" />
          <line x1={M.l} y1={M.t} x2={M.l} y2={H - M.b} stroke="currentColor" strokeWidth="1.2" />
        </g>

        {/* X tick 标签 */}
        <g className="fill-slate-500 dark:fill-slate-400 text-[10px] tabular-nums">
          {xTicks.map((t, i) => (
            <text key={`xt${i}`} x={xScale(t)} y={H - M.b + 14} textAnchor="middle">
              {t < 0.001 ? t.toExponential(0) : t < 1 ? t : t.toString()}
            </text>
          ))}
        </g>
        {/* Y tick 标签 */}
        <g className="fill-slate-500 dark:fill-slate-400 text-[10px] tabular-nums">
          {yTicks.map((t, i) => (
            <text key={`yt${i}`} x={M.l - 6} y={yScale(t) + 3} textAnchor="end">
              {t.toFixed(t < 0.1 ? 3 : 2)}
            </text>
          ))}
        </g>

        {/* 轴标题 */}
        <text x={M.l + iw / 2} y={H - 12} textAnchor="middle"
              className="fill-slate-600 dark:fill-slate-300 text-[11px] font-medium">
          泵功率 P_pump (W) — 对数轴
        </text>
        <text transform={`rotate(-90, 18, ${M.t + ih / 2})`} x={18} y={M.t + ih / 2} textAnchor="middle"
              className="fill-slate-600 dark:fill-slate-300 text-[11px] font-medium">
          热阻 R_th (K/W)
        </text>

        {/* Pareto 前沿连线 */}
        {front.length > 1 && (
          <polyline
            points={front.map(f => `${xScale(f.x)},${yScale(f.y)}`).join(" ")}
            fill="none" stroke="#4F46E5" strokeWidth="2.2" strokeDasharray="4 3" opacity="0.85"
          />
        )}

        {/* 散点 */}
        {points.map(p => {
          const visible = filteredIds.has(p.id);
          const isSel = p.id === selectedId;
          const isRef = p.id === refId;
          const hovered = p.id === hoverId;
          return (
            <g key={p.id}
               opacity={visible ? 1 : 0.18}
               onMouseEnter={() => setHoverId(p.id)}
               onMouseLeave={() => setHoverId(null)}
               onClick={() => visible && onSelect(p.id)}
               style={{ cursor: visible ? "pointer" : "default" }}>
              {isSel && (
                <circle cx={xScale(p._x)} cy={yScale(p._y)} r={11}
                        fill="none" stroke="#4F46E5" strokeWidth="2" />
              )}
              {isRef && (
                <circle cx={xScale(p._x)} cy={yScale(p._y)} r={14}
                        fill="none" stroke="#F59E0B" strokeWidth="1.5" strokeDasharray="3 2" />
              )}
              {renderMarker(p, hovered)}
            </g>
          );
        })}
      </svg>

      {/* tooltip */}
      {hoverPoint && (
        <div className="absolute pointer-events-none px-2.5 py-2 text-xs rounded-md shadow-lg bg-slate-900 text-slate-100 dark:bg-slate-800 dark:border dark:border-slate-700 tabular-nums"
             style={{
               left: `min(${(xScale(hoverPoint._x) / W) * 100}%, calc(100% - 200px))`,
               top: `${(yScale(hoverPoint._y) / H) * 100}%`,
               transform: "translate(12px, -100%)",
             }}>
          <div className="font-semibold flex items-center gap-1.5">
            <span style={{ color: SHAPE_COLORS[hoverPoint.shape] }}>●</span>
            {hoverPoint.id}
          </div>
          <div className="text-slate-300 mt-0.5 leading-relaxed">
            {hoverPoint.shape} · {hoverPoint.arrangement} · D={hoverPoint.D}mm
            <br />
            Re={hoverPoint._derived.Re ? hoverPoint._derived.Re.toFixed(0) : "—"} ｜ R_th={hoverPoint._y.toFixed(3)} K/W
            <br />
            P_pump={hoverPoint._x < 0.01 ? hoverPoint._x.toExponential(2) : hoverPoint._x.toFixed(3)} W
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// 趋势图（次要视图）
// =============================================================================

const TREND_X_VARS = [
  { key: "ST_D",  label: "S_T/D" },
  { key: "SL_D",  label: "S_L/D" },
  { key: "D",     label: "D (mm)" },
  { key: "Re",    label: "Re" },
];
const TREND_Y_VARS = [
  { key: "Rth",   label: "热阻 R_th (K/W)" },
  { key: "PEC",   label: "PEC" },
  { key: "Nu",    label: "Nu" },
  { key: "f",     label: "摩擦系数 f" },
  { key: "Ppump", label: "泵功率 (W)" },
];

function TrendPlot({ cases, filteredIds, xKey, yKey, refId }) {
  const getX = (c) => {
    if (xKey === "Re") return c._derived.Re;
    if (xKey === "ST_D") return c._derived.ST_D;
    if (xKey === "SL_D") return c._derived.SL_D;
    return c[xKey];
  };
  const getY = (c) => {
    if (yKey === "Rth") return c._derived.Rth;
    if (yKey === "Ppump") return c._derived.Ppump;
    if (yKey === "PEC") {
      if (!refId) return null;
      const ref = cases.find(x => x.id === refId);
      if (!ref) return null;
      return calcPEC({ Nu: c.Nu, Nu_ref: ref.Nu, f: c.f, f_ref: ref.f });
    }
    return c[yKey];
  };

  const points = cases
    .filter(c => filteredIds.has(c.id))
    .map(c => ({ ...c, _x: getX(c), _y: getY(c) }))
    .filter(c => isNum(c._x) && isNum(c._y));

  if (points.length === 0) {
    return <div className="h-full flex items-center justify-center text-sm text-slate-400">数据不足</div>;
  }
  if (yKey === "PEC" && !refId) {
    return <div className="h-full flex items-center justify-center text-sm text-amber-600 dark:text-amber-400">需要先指定参考算例（在列表里点星标）</div>;
  }

  const xs = points.map(p => p._x), ys = points.map(p => p._y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xPad = (xMax - xMin) * 0.08 || 1;
  const yPad = (yMax - yMin) * 0.12 || 1;

  const W = 720, H = 440;
  const M = { l: 64, r: 24, t: 24, b: 56 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const xScale = (x) => M.l + ((x - (xMin - xPad)) / ((xMax + xPad) - (xMin - xPad))) * iw;
  const yScale = (y) => M.t + (1 - (y - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad))) * ih;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <g className="text-slate-400 dark:text-slate-500">
        <line x1={M.l} y1={H - M.b} x2={W - M.r} y2={H - M.b} stroke="currentColor" strokeWidth="1.2" />
        <line x1={M.l} y1={M.t} x2={M.l} y2={H - M.b} stroke="currentColor" strokeWidth="1.2" />
      </g>
      <text x={M.l + iw / 2} y={H - 12} textAnchor="middle"
            className="fill-slate-600 dark:fill-slate-300 text-[11px] font-medium">
        {TREND_X_VARS.find(v => v.key === xKey)?.label}
      </text>
      <text transform={`rotate(-90, 18, ${M.t + ih / 2})`} x={18} y={M.t + ih / 2} textAnchor="middle"
            className="fill-slate-600 dark:fill-slate-300 text-[11px] font-medium">
        {TREND_Y_VARS.find(v => v.key === yKey)?.label}
      </text>
      {points.map(p => (
        <circle key={p.id} cx={xScale(p._x)} cy={yScale(p._y)} r="5"
                fill={SHAPE_COLORS[p.shape]} fillOpacity={p.arrangement === "顺排" ? 1 : 0.4}
                stroke={SHAPE_COLORS[p.shape]} strokeWidth="1.5" />
      ))}
    </svg>
  );
}

// =============================================================================
// 详情面板
// =============================================================================

function DetailPanel({ caseData, refCase, onClose, onEdit, onDelete, onDuplicate, onSetRef, isRef }) {
  if (!caseData) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 text-sm text-slate-400 dark:text-slate-500">
        <Layers size={28} strokeWidth={1.2} className="mb-2 opacity-50" />
        点选 Pareto 图上的点或左侧列表中的算例查看详情
      </div>
    );
  }
  const c = caseData;
  const d = c._derived;
  const fmt = (v, p = 3) => isNum(v) ? v.toFixed(p) : "—";
  const fmtSci = (v) => !isNum(v) ? "—" : (v < 0.01 || v > 1e4) ? v.toExponential(2) : v.toFixed(3);

  const pec = (refCase && refCase.id !== c.id)
    ? calcPEC({ Nu: c.Nu, Nu_ref: refCase.Nu, f: c.f, f_ref: refCase.f })
    : null;

  return (
    <div className="h-full flex flex-col">
      {/* 头部 */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">{c.id}</span>
            <StatusBadge status={c.status} />
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{c.date} · {c.shape} · {c.arrangement}</div>
        </div>
        <div className="flex gap-0.5">
          <button onClick={() => onSetRef(isRef ? null : c.id)}
                  title={isRef ? "取消参考" : "设为参考算例（PEC 基准）"}
                  className={`p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${isRef ? "text-amber-500" : "text-slate-400"}`}>
            <Star size={14} fill={isRef ? "currentColor" : "none"} />
          </button>
          <button onClick={onDuplicate} title="复制" className="p-1.5 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"><Copy size={14} /></button>
          <button onClick={onEdit} title="编辑" className="p-1.5 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"><Pencil size={14} /></button>
          <button onClick={onDelete} title="删除" className="p-1.5 rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/30 transition-colors"><Trash2 size={14} /></button>
          <button onClick={onClose} title="关闭" className="p-1.5 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors lg:hidden"><X size={14} /></button>
        </div>
      </div>

      {/* 内容滚动区 */}
      <div className="flex-1 overflow-auto px-4 pb-4 text-sm">
        {/* 关键指标卡 */}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <Metric label="热阻" value={fmt(d.Rth, 3)} unit="K/W" emphasis />
          <Metric label="泵功率" value={fmtSci(d.Ppump)} unit="W" emphasis />
          <Metric label="Re" value={d.Re ? d.Re.toFixed(0) : "—"} unit="" badge={d.Re_auto ? "自动" : null} />
          <Metric label="PEC" value={fmt(pec, 3)} unit="" badge={refCase && !isRef ? `vs ${refCase.id}` : null} />
        </div>

        {/* 几何 */}
        <Section title="几何" icon={Layers} defaultOpen>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <KV k="形状" v={c.shape} />
            <KV k="排列" v={c.arrangement} />
            <KV k="D" v={`${fmt(c.D, 2)} mm`} />
            <KV k="H (柱高)" v={`${fmt(c.H, 2)} mm`} />
            <KV k="S_T" v={`${fmt(c.S_T, 2)} mm`} />
            <KV k="S_L" v={`${fmt(c.S_L, 2)} mm`} />
            <KV k="S_T/D" v={fmt(d.ST_D, 2)} />
            <KV k="S_L/D" v={fmt(d.SL_D, 2)} />
            <KV k="流道 L×W×H" v={`${c.channel_L}×${c.channel_W}×${c.channel_H} mm`} colspan />
          </div>
          <div className="mt-3">
            <PinFinLayout caseData={c} />
          </div>
        </Section>

        {/* 工质与边界 */}
        <Section title="工质与边界" icon={Settings2}>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <KV k="工质" v={c.fluid} />
            <KV k="ρ / μ" v={d.props ? `${d.props.rho} / ${d.props.mu.toExponential(2)}` : "—"} />
            <KV k="T_in" v={`${fmt(c.T_in, 1)} °C`} />
            <KV k="热载" v={c.heat_mode === "Q" ? `Q = ${fmt(c.Q_total, 1)} W` : `q" = ${fmt(c.q_flux, 2)} W/cm²`} />
            <KV k="流量" v={isNum(d.mdot_g_s) ? `${d.mdot_g_s.toFixed(2)} g/s` : "—"} />
            <KV k="进口流速" v={isNum(d.u) ? `${d.u.toFixed(3)} m/s` : "—"} />
          </div>
        </Section>

        {/* 求解器 */}
        {(c.solver || c.turb_model || c.mesh_wan || c.remarks) && (
          <Section title="求解器" defaultOpen={false}>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <KV k="软件" v={c.solver || "—"} />
              <KV k="湍流模型" v={c.turb_model || "—"} />
              <KV k="网格量" v={isNum(c.mesh_wan) ? `${c.mesh_wan} 万` : "—"} />
            </div>
            {c.remarks && (
              <div className="mt-2 text-xs text-slate-600 dark:text-slate-400 leading-relaxed bg-slate-50 dark:bg-slate-800/50 rounded p-2">
                {c.remarks}
              </div>
            )}
          </Section>
        )}

        {/* 结果 */}
        <Section title="原始结果">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <KV k="T_max" v={`${fmt(c.T_max, 2)} °C`} />
            <KV k="T_base 平均" v={isNum(c.T_base_avg) ? `${c.T_base_avg.toFixed(2)} °C` : "—"} />
            <KV k="ΔP" v={`${fmt(c.dP, 2)} kPa`} />
            <KV k="Nu (avg)" v={fmt(c.Nu, 2)} />
            <KV k="f" v={fmt(c.f, 4)} />
          </div>
        </Section>

        {/* 标签 */}
        {c.tags?.length > 0 && (
          <div className="pt-3 flex flex-wrap gap-1">
            {c.tags.map(t => (
              <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">{t}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, unit, emphasis, badge }) {
  return (
    <div className={`rounded-md p-2.5 border ${emphasis ? "border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/50 dark:bg-indigo-950/30" : "border-slate-200 dark:border-slate-800"}`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">{label}</span>
        {badge && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{badge}</span>}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</span>
        {unit && <span className="text-xs text-slate-500 dark:text-slate-400">{unit}</span>}
      </div>
    </div>
  );
}

function KV({ k, v, colspan }) {
  return (
    <div className={colspan ? "col-span-2" : ""}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{k}</div>
      <div className="text-slate-900 dark:text-slate-100 tabular-nums mt-0.5">{v}</div>
    </div>
  );
}

// =============================================================================
// 算例列表（左侧）
// =============================================================================

function CaseList({ cases, selectedId, onSelect, search, onSearchChange, compareIds, onToggleCompare, refId }) {
  const filtered = cases.filter(c => {
    if (!search) return true;
    const s = search.toLowerCase();
    return c.id.toLowerCase().includes(s)
      || c.shape.toLowerCase().includes(s)
      || (c.tags || []).some(t => t.toLowerCase().includes(s))
      || (c.remarks || "").toLowerCase().includes(s);
  });

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 pt-3 pb-2 border-b border-slate-200 dark:border-slate-800">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input type="text"
                 placeholder="搜索 ID、形状、标签、备注..."
                 value={search}
                 onChange={(e) => onSearchChange(e.target.value)}
                 className="w-full pl-7 pr-2 py-1.5 text-xs bg-slate-50 dark:bg-slate-900 border border-transparent focus:border-indigo-500 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-colors" />
        </div>
        <div className="mt-2 text-[10px] text-slate-500 dark:text-slate-400 flex items-center justify-between">
          <span className="tabular-nums">{filtered.length} / {cases.length} 算例</span>
          {compareIds.size > 0 && (
            <span className="text-indigo-600 dark:text-indigo-400 font-medium">{compareIds.size} 个待比较</span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {filtered.map(c => {
          const d = c._derived;
          const sel = c.id === selectedId;
          const inCompare = compareIds.has(c.id);
          const isRef = c.id === refId;
          return (
            <div key={c.id}
                 onClick={() => onSelect(c.id)}
                 className={`group px-3 py-2 border-b border-slate-100 dark:border-slate-800/60 cursor-pointer transition-colors ${
                   sel ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"
                 }`}>
              <div className="flex items-start gap-2">
                <input type="checkbox"
                       checked={inCompare}
                       onChange={(e) => { e.stopPropagation(); onToggleCompare(c.id); }}
                       onClick={(e) => e.stopPropagation()}
                       className="mt-1 accent-indigo-600 w-3 h-3" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{c.id}</span>
                    {isRef && <Star size={11} className="text-amber-500 shrink-0" fill="currentColor" />}
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5">
                    <span style={{ color: SHAPE_COLORS[c.shape] }}>●</span>
                    <span>{c.shape}</span>
                    <span>·</span>
                    <span>{c.arrangement}</span>
                    <span>·</span>
                    <span className="tabular-nums">D={c.D}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-600 dark:text-slate-400 tabular-nums">
                    <span>R<sub>th</sub>: <strong className="text-slate-900 dark:text-slate-200">{isNum(d.Rth) ? d.Rth.toFixed(3) : "—"}</strong></span>
                    <span className="text-slate-300 dark:text-slate-700">|</span>
                    <span>P<sub>p</sub>: <strong className="text-slate-900 dark:text-slate-200">{isNum(d.Ppump) ? (d.Ppump < 0.01 ? d.Ppump.toExponential(1) : d.Ppump.toFixed(2)) : "—"}</strong></span>
                  </div>
                </div>
                <StatusBadge status={c.status} />
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="p-6 text-center text-xs text-slate-400">没有匹配的算例</div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// 筛选条
// =============================================================================

function FilterBar({ filters, onChange, cases }) {
  const active = filters.shapes.size + filters.arrangements.size + filters.fluids.size
    + (filters.reMin != null ? 1 : 0) + (filters.reMax != null ? 1 : 0);
  const [open, setOpen] = useState(false);

  const toggle = (key, val) => {
    const next = new Set(filters[key]);
    if (next.has(val)) next.delete(val); else next.add(val);
    onChange({ ...filters, [key]: next });
  };

  const fluidsInUse = Array.from(new Set(cases.map(c => c.fluid)));

  return (
    <div className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <button type="button" onClick={() => setOpen(o => !o)}
              className="w-full px-4 py-2 flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
        <Filter size={13} />
        筛选
        {active > 0 && (
          <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded-full text-[10px] tabular-nums">{active}</span>
        )}
        <ChevronDown size={13} className={`ml-auto transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-2">
          <FilterChips title="形状" options={SHAPES} selected={filters.shapes}
                       onToggle={(v) => toggle("shapes", v)}
                       colorMap={SHAPE_COLORS} />
          <FilterChips title="排列" options={ARRANGEMENTS} selected={filters.arrangements}
                       onToggle={(v) => toggle("arrangements", v)} />
          {fluidsInUse.length > 1 && (
            <FilterChips title="工质" options={fluidsInUse} selected={filters.fluids}
                         onToggle={(v) => toggle("fluids", v)} />
          )}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium w-12">Re</span>
            <input type="number" placeholder="min" className={`${inputCls} w-24 py-1 text-xs`}
                   value={filters.reMin ?? ""}
                   onChange={(e) => onChange({ ...filters, reMin: e.target.value === "" ? null : +e.target.value })} />
            <span className="text-slate-400">—</span>
            <input type="number" placeholder="max" className={`${inputCls} w-24 py-1 text-xs`}
                   value={filters.reMax ?? ""}
                   onChange={(e) => onChange({ ...filters, reMax: e.target.value === "" ? null : +e.target.value })} />
            {active > 0 && (
              <button onClick={() => onChange({ shapes: new Set(), arrangements: new Set(), fluids: new Set(), reMin: null, reMax: null })}
                      className="ml-auto text-[10px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline">
                清空
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChips({ title, options, selected, onToggle, colorMap }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium w-12 mt-1.5">{title}</span>
      <div className="flex flex-wrap gap-1.5 flex-1">
        {options.map(o => {
          const isOn = selected.has(o);
          return (
            <button key={o} onClick={() => onToggle(o)}
                    className={`px-2 py-1 text-[11px] rounded transition-colors flex items-center gap-1 ${
                      isOn
                        ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
                    }`}>
              {colorMap && <span className="w-1.5 h-1.5 rounded-full" style={{ background: colorMap[o] }} />}
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// 录入表单 Modal
// =============================================================================

function emptyCase() {
  return {
    id: "", date: new Date().toISOString().slice(0, 10), tags: [], status: "进行中",
    shape: "圆柱", arrangement: "顺排",
    D: null, H: null, S_T: null, S_L: null,
    channel_L: null, channel_W: null, channel_H: null,
    fluid: "Water", fluid_custom: null,
    heat_mode: "Q", q_flux: null, Q_total: null, T_in: null,
    flow_mode: "mdot", mdot: null, u_in: null, Re_input: null,
    solver: "", turb_model: "", mesh_wan: null, remarks: "",
    T_max: null, T_base_avg: null, dP: null, Nu: null, f: null,
  };
}

function CaseFormModal({ initial, onSave, onClose, existingIds }) {
  const [c, setC] = useState(() => initial || emptyCase());
  const set = (patch) => setC(prev => ({ ...prev, ...patch }));
  const [tagInput, setTagInput] = useState("");

  const isEdit = !!initial?.id;
  const idValid = c.id && (isEdit || !existingIds.has(c.id));

  const submit = () => {
    let id = c.id;
    if (!id) {
      // 自动生成
      let n = 1;
      while (existingIds.has(`C-${String(n).padStart(3, "0")}`)) n++;
      id = `C-${String(n).padStart(3, "0")}`;
    }
    onSave({ ...c, id });
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 dark:bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col border border-slate-200 dark:border-slate-800">
        {/* Modal header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-slate-900 dark:text-slate-100">{isEdit ? "编辑算例" : "新建算例"}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">必填项标 *，其他可后补</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X size={16} />
          </button>
        </div>

        {/* Modal body */}
        <div className="flex-1 overflow-auto px-5 py-3">
          {/* 标识 */}
          <Section title="标识" icon={null} defaultOpen>
            <div className="grid grid-cols-3 gap-3">
              <Field label="算例 ID" hint={isEdit ? "" : "留空自动生成"}>
                <TextInput value={c.id} onChange={v => set({ id: v })} placeholder="C-009" />
              </Field>
              <Field label="日期">
                <input type="date" className={inputCls}
                       value={c.date || ""}
                       onChange={(e) => set({ date: e.target.value })} />
              </Field>
              <Field label="状态">
                <Select value={c.status} onChange={v => set({ status: v })} options={STATUSES} />
              </Field>
            </div>
            <Field label="标签" hint="回车添加">
              <div className="flex flex-wrap gap-1.5 p-1.5 border border-slate-200 dark:border-slate-700 rounded min-h-[2rem]">
                {(c.tags || []).map(t => (
                  <span key={t} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    {t}
                    <button onClick={() => set({ tags: c.tags.filter(x => x !== t) })} className="text-slate-400 hover:text-rose-500">
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <input value={tagInput}
                       onChange={(e) => setTagInput(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key === "Enter" && tagInput.trim()) {
                           e.preventDefault();
                           if (!c.tags.includes(tagInput.trim())) set({ tags: [...c.tags, tagInput.trim()] });
                           setTagInput("");
                         }
                       }}
                       placeholder="添加标签..."
                       className="flex-1 min-w-[100px] text-xs bg-transparent outline-none" />
              </div>
            </Field>
          </Section>

          {/* 几何 */}
          <Section title="几何" defaultOpen>
            <div className="grid grid-cols-2 gap-3">
              <Field label="扰流柱形状" required>
                <Select value={c.shape} onChange={v => set({ shape: v })} options={SHAPES} />
              </Field>
              <Field label="排列方式" required>
                <Select value={c.arrangement} onChange={v => set({ arrangement: v })} options={ARRANGEMENTS} />
              </Field>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <Field label="D" hint="特征尺寸"><div className="flex items-center gap-1"><NumInput value={c.D} onChange={v => set({ D: v })} placeholder="2.0" /><span className="text-xs text-slate-400">mm</span></div></Field>
              <Field label="H" hint="柱高"><div className="flex items-center gap-1"><NumInput value={c.H} onChange={v => set({ H: v })} placeholder="4.0" /><span className="text-xs text-slate-400">mm</span></div></Field>
              <Field label="S_T" hint="横向间距"><div className="flex items-center gap-1"><NumInput value={c.S_T} onChange={v => set({ S_T: v })} placeholder="4.0" /><span className="text-xs text-slate-400">mm</span></div></Field>
              <Field label="S_L" hint="纵向间距"><div className="flex items-center gap-1"><NumInput value={c.S_L} onChange={v => set({ S_L: v })} placeholder="4.0" /><span className="text-xs text-slate-400">mm</span></div></Field>
            </div>
            {isNum(c.D) && c.D > 0 && (isNum(c.S_T) || isNum(c.S_L)) && (
              <div className="px-2 py-1.5 bg-slate-50 dark:bg-slate-800/50 rounded text-[11px] text-slate-600 dark:text-slate-400 tabular-nums">
                S_T/D = {isNum(c.S_T) ? (c.S_T / c.D).toFixed(2) : "—"} ｜ S_L/D = {isNum(c.S_L) ? (c.S_L / c.D).toFixed(2) : "—"}
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Field label="流道 L"><div className="flex items-center gap-1"><NumInput value={c.channel_L} onChange={v => set({ channel_L: v })} placeholder="50" /><span className="text-xs text-slate-400">mm</span></div></Field>
              <Field label="流道 W"><div className="flex items-center gap-1"><NumInput value={c.channel_W} onChange={v => set({ channel_W: v })} placeholder="30" /><span className="text-xs text-slate-400">mm</span></div></Field>
              <Field label="流道 H"><div className="flex items-center gap-1"><NumInput value={c.channel_H} onChange={v => set({ channel_H: v })} placeholder="4" /><span className="text-xs text-slate-400">mm</span></div></Field>
            </div>
          </Section>

          {/* 工质 */}
          <Section title="工质" defaultOpen>
            <Field label="流体">
              <Select value={c.fluid} onChange={v => set({ fluid: v, fluid_custom: v === "自定义" ? (c.fluid_custom || { rho: null, mu: null, k: null, cp: null }) : null })}
                      options={[...Object.keys(FLUID_PRESETS), "自定义"]} />
            </Field>
            {c.fluid === "自定义" ? (
              <div className="grid grid-cols-4 gap-3">
                <Field label="ρ" hint="kg/m³"><NumInput value={c.fluid_custom?.rho} onChange={v => set({ fluid_custom: { ...c.fluid_custom, rho: v } })} placeholder="997" /></Field>
                <Field label="μ" hint="Pa·s"><NumInput value={c.fluid_custom?.mu} onChange={v => set({ fluid_custom: { ...c.fluid_custom, mu: v } })} placeholder="0.00089" /></Field>
                <Field label="k" hint="W/(m·K)"><NumInput value={c.fluid_custom?.k} onChange={v => set({ fluid_custom: { ...c.fluid_custom, k: v } })} placeholder="0.606" /></Field>
                <Field label="cp" hint="J/(kg·K)"><NumInput value={c.fluid_custom?.cp} onChange={v => set({ fluid_custom: { ...c.fluid_custom, cp: v } })} placeholder="4186" /></Field>
              </div>
            ) : (
              <div className="px-2 py-1.5 bg-slate-50 dark:bg-slate-800/50 rounded text-[11px] text-slate-600 dark:text-slate-400 tabular-nums">
                {(() => {
                  const p = FLUID_PRESETS[c.fluid];
                  return p ? <>ρ={p.rho} kg/m³ ｜ μ={p.mu.toExponential(2)} Pa·s ｜ k={p.k} W/(m·K) ｜ cp={p.cp} J/(kg·K)</> : "—";
                })()}
              </div>
            )}
          </Section>

          {/* 边界条件 */}
          <Section title="边界条件" defaultOpen>
            <div className="grid grid-cols-2 gap-3">
              <Field label="热载入方式">
                <SegToggle value={c.heat_mode} onChange={v => set({ heat_mode: v })}
                           options={[{ value: "Q", label: "总功率 Q" }, { value: "q", label: "热流密度 q\"" }]} />
              </Field>
              <Field label="进口温度 T_in" required>
                <div className="flex items-center gap-1"><NumInput value={c.T_in} onChange={v => set({ T_in: v })} placeholder="25" /><span className="text-xs text-slate-400">°C</span></div>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {c.heat_mode === "Q" ? (
                <Field label="总热载 Q" required><div className="flex items-center gap-1"><NumInput value={c.Q_total} onChange={v => set({ Q_total: v })} placeholder="200" /><span className="text-xs text-slate-400">W</span></div></Field>
              ) : (
                <Field label="热流密度 q&quot;" required><div className="flex items-center gap-1"><NumInput value={c.q_flux} onChange={v => set({ q_flux: v })} placeholder="100" /><span className="text-xs text-slate-400">W/cm²</span></div></Field>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="流量给定方式">
                <SegToggle value={c.flow_mode} onChange={v => set({ flow_mode: v })}
                           options={[{ value: "mdot", label: "质量流量" }, { value: "u", label: "进口流速" }]} />
              </Field>
              {c.flow_mode === "mdot" ? (
                <Field label="ṁ" required><div className="flex items-center gap-1"><NumInput value={c.mdot} onChange={v => set({ mdot: v })} placeholder="4" /><span className="text-xs text-slate-400">g/s</span></div></Field>
              ) : (
                <Field label="u_in" required><div className="flex items-center gap-1"><NumInput value={c.u_in} onChange={v => set({ u_in: v })} placeholder="0.2" /><span className="text-xs text-slate-400">m/s</span></div></Field>
              )}
            </div>
            <Field label="Re（覆盖自动计算，可选）">
              <NumInput value={c.Re_input} onChange={v => set({ Re_input: v })} placeholder="留空 → 用 ρuD/μ 自动算" />
            </Field>
          </Section>

          {/* 求解器 */}
          <Section title="求解器（可选）" defaultOpen={false}>
            <div className="grid grid-cols-3 gap-3">
              <Field label="软件"><Select value={c.solver || ""} onChange={v => set({ solver: v })} options={["", ...SOLVERS]} /></Field>
              <Field label="湍流模型"><Select value={c.turb_model || ""} onChange={v => set({ turb_model: v })} options={["", ...TURB_MODELS]} /></Field>
              <Field label="网格量" hint="万"><NumInput value={c.mesh_wan} onChange={v => set({ mesh_wan: v })} placeholder="200" /></Field>
            </div>
            <Field label="备注">
              <textarea className={inputCls + " resize-none"} rows="2"
                        value={c.remarks || ""}
                        onChange={(e) => set({ remarks: e.target.value })}
                        placeholder="网格无关性、收敛情况、特殊处理..." />
            </Field>
          </Section>

          {/* 结果 */}
          <Section title="结果" defaultOpen>
            <div className="grid grid-cols-3 gap-3">
              <Field label="T_max" required><div className="flex items-center gap-1"><NumInput value={c.T_max} onChange={v => set({ T_max: v })} placeholder="65" /><span className="text-xs text-slate-400">°C</span></div></Field>
              <Field label="T_base 平均"><div className="flex items-center gap-1"><NumInput value={c.T_base_avg} onChange={v => set({ T_base_avg: v })} placeholder="55" /><span className="text-xs text-slate-400">°C</span></div></Field>
              <Field label="ΔP" required><div className="flex items-center gap-1"><NumInput value={c.dP} onChange={v => set({ dP: v })} placeholder="5" /><span className="text-xs text-slate-400">kPa</span></div></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nu (avg)"><NumInput value={c.Nu} onChange={v => set({ Nu: v })} placeholder="25" /></Field>
              <Field label="摩擦系数 f"><NumInput value={c.f} onChange={v => set({ f: v })} placeholder="0.18" /></Field>
            </div>
          </Section>
        </div>

        {/* Modal footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/50">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {!idValid && c.id && !isEdit && (
              <span className="text-rose-500 flex items-center gap-1">
                <AlertCircle size={12} /> ID 已存在
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose}
                    className="px-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
              取消
            </button>
            <button onClick={submit}
                    disabled={c.id && !idValid && !isEdit}
                    className="px-4 py-1.5 text-xs rounded bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed font-medium">
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 对比 Modal
// =============================================================================

function CompareModal({ cases, refCase, onClose }) {
  // 构造对比表行
  const fmt = (v, p = 3) => isNum(v) ? v.toFixed(p) : "—";
  const fmtSci = (v) => !isNum(v) ? "—" : (v < 0.01 || v > 1e4) ? v.toExponential(2) : v.toFixed(3);

  const rows = [
    { label: "形状", get: c => c.shape, type: "text" },
    { label: "排列", get: c => c.arrangement, type: "text" },
    { label: "D (mm)", get: c => c.D, type: "num", p: 2 },
    { label: "H (mm)", get: c => c.H, type: "num", p: 2 },
    { label: "S_T (mm)", get: c => c.S_T, type: "num", p: 2 },
    { label: "S_L (mm)", get: c => c.S_L, type: "num", p: 2 },
    { label: "S_T/D", get: c => c._derived.ST_D, type: "num", p: 2 },
    { label: "S_L/D", get: c => c._derived.SL_D, type: "num", p: 2 },
    { label: "工质", get: c => c.fluid, type: "text" },
    { label: "T_in (°C)", get: c => c.T_in, type: "num", p: 1 },
    { label: "Q (W)", get: c => c._derived.Q, type: "num", p: 1 },
    { label: "ṁ (g/s)", get: c => c._derived.mdot_g_s, type: "num", p: 2 },
    { label: "Re", get: c => c._derived.Re, type: "num", p: 0 },
    { label: "T_max (°C)", get: c => c.T_max, type: "num", p: 2 },
    { label: "ΔP (kPa)", get: c => c.dP, type: "num", p: 2 },
    { label: "Nu", get: c => c.Nu, type: "num", p: 2 },
    { label: "f", get: c => c.f, type: "num", p: 4 },
    { label: "R_th (K/W)", get: c => c._derived.Rth, type: "num", p: 3, highlight: true },
    { label: "P_pump (W)", get: c => c._derived.Ppump, type: "sci", highlight: true },
    {
      label: "PEC", highlight: true,
      get: c => refCase ? calcPEC({ Nu: c.Nu, Nu_ref: refCase.Nu, f: c.f, f_ref: refCase.f }) : null,
      type: "num", p: 3,
    },
  ];

  const fmtCell = (row, c) => {
    const v = row.get(c);
    if (row.type === "text") return v ?? "—";
    if (row.type === "sci") return fmtSci(v);
    return fmt(v, row.p);
  };

  // 找出每行的差异（数值型）
  const isDiff = (row) => {
    if (row.type === "text") return new Set(cases.map(c => row.get(c))).size > 1;
    const vals = cases.map(c => row.get(c)).filter(isNum);
    if (vals.length < 2) return false;
    return Math.max(...vals) - Math.min(...vals) > 1e-9;
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 dark:bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col border border-slate-200 dark:border-slate-800">
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-slate-900 dark:text-slate-100">算例对比</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">差异列高亮 ｜ {cases.length} 个算例</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900/95 backdrop-blur z-10">
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="text-left px-4 py-2 font-medium text-slate-600 dark:text-slate-400 w-32">参数</th>
                {cases.map(c => (
                  <th key={c.id} className="text-left px-4 py-2 font-mono font-semibold text-slate-900 dark:text-slate-100">
                    <div className="flex items-center gap-1.5">
                      <span style={{ color: SHAPE_COLORS[c.shape] }}>●</span>
                      {c.id}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const diff = isDiff(row);
                return (
                  <tr key={i} className={`border-b border-slate-100 dark:border-slate-800/60 ${row.highlight ? "bg-indigo-50/40 dark:bg-indigo-950/20" : ""}`}>
                    <td className={`px-4 py-1.5 text-slate-600 dark:text-slate-400 ${row.highlight ? "font-medium" : ""}`}>{row.label}</td>
                    {cases.map(c => (
                      <td key={c.id} className={`px-4 py-1.5 text-slate-900 dark:text-slate-100 ${diff ? "bg-amber-50/60 dark:bg-amber-900/20 font-medium" : ""}`}>
                        {fmtCell(row, c)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 主组件
// =============================================================================

export default function PinFinOptimizer() {
  const [rawCases, setRawCases] = useState(SEED_CASES);
  const [selectedId, setSelectedId] = useState("C-001");
  const [refId, setRefId] = useState("C-001"); // PEC 参考算例
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({
    shapes: new Set(), arrangements: new Set(), fluids: new Set(),
    reMin: null, reMax: null,
  });
  const [compareIds, setCompareIds] = useState(new Set());
  const [showCompare, setShowCompare] = useState(false);
  const [editing, setEditing] = useState(null); // null | "new" | case object
  const [view, setView] = useState("pareto"); // "pareto" | "trend"
  const [trendX, setTrendX] = useState("ST_D");
  const [trendY, setTrendY] = useState("Rth");
  const [dark, setDark] = useState(false);
  const fileInputRef = useRef(null);

  // 派生：每条 case 加上计算字段
  const cases = useMemo(() => rawCases.map(deriveCase), [rawCases]);

  // 筛选后的可见 ID 集合
  const filteredIds = useMemo(() => {
    const out = new Set();
    for (const c of cases) {
      if (filters.shapes.size > 0 && !filters.shapes.has(c.shape)) continue;
      if (filters.arrangements.size > 0 && !filters.arrangements.has(c.arrangement)) continue;
      if (filters.fluids.size > 0 && !filters.fluids.has(c.fluid)) continue;
      const re = c._derived.Re;
      if (filters.reMin != null && (re == null || re < filters.reMin)) continue;
      if (filters.reMax != null && (re == null || re > filters.reMax)) continue;
      out.add(c.id);
    }
    return out;
  }, [cases, filters]);

  const selectedCase = cases.find(c => c.id === selectedId) || null;
  const refCase = cases.find(c => c.id === refId) || null;
  const existingIds = useMemo(() => new Set(rawCases.map(c => c.id)), [rawCases]);

  // 操作
  const saveCase = (newCase) => {
    setRawCases(prev => {
      const idx = prev.findIndex(c => c.id === newCase.id);
      if (idx >= 0) {
        const next = [...prev]; next[idx] = newCase; return next;
      }
      return [...prev, newCase];
    });
    setSelectedId(newCase.id);
    setEditing(null);
  };

  const deleteCase = (id) => {
    if (!confirm(`确定删除算例 ${id}？此操作不可撤销。`)) return;
    setRawCases(prev => prev.filter(c => c.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (refId === id) setRefId(null);
    setCompareIds(prev => { const n = new Set(prev); n.delete(id); return n; });
  };

  const duplicateCase = (id) => {
    const c = rawCases.find(x => x.id === id);
    if (!c) return;
    let n = 1; let newId;
    do { newId = `C-${String(rawCases.length + n).padStart(3, "0")}`; n++; } while (existingIds.has(newId));
    setEditing({ ...c, id: "", date: new Date().toISOString().slice(0, 10), status: "进行中" });
  };

  const toggleCompare = (id) => {
    setCompareIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else if (n.size < 3) n.add(id);
      else { alert("最多对比 3 个算例"); return prev; }
      return n;
    });
  };

  const handleExport = () => {
    const csv = casesToCSV(rawCases);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `pin_fin_cases_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = csvToCases(ev.target.result);
        if (imported.length === 0) { alert("CSV 中没有有效数据"); return; }
        if (confirm(`导入 ${imported.length} 条算例。点确定将合并到当前数据，相同 ID 会被覆盖。`)) {
          setRawCases(prev => {
            const map = new Map(prev.map(c => [c.id, c]));
            for (const c of imported) map.set(c.id, c);
            return Array.from(map.values());
          });
        }
      } catch (err) {
        alert("解析失败：" + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const compareCases = cases.filter(c => compareIds.has(c.id));

  return (
    <div className={dark ? "dark" : ""}>
      <div className="h-screen w-full flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
           style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif" }}>

        {/* 顶栏 */}
        <header className="shrink-0 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white font-bold text-xs">PF</div>
            <div>
              <div className="text-sm font-semibold leading-tight">扰流柱冷板优化台账</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">Pin-Fin Cold Plate Optimization Logbook</div>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => setView(v => v === "pareto" ? "trend" : "pareto")}
                    className="px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5">
              {view === "pareto" ? <><LineChart size={13} /> 趋势图</> : <><ScatterChart size={13} /> Pareto 图</>}
            </button>
            {compareIds.size >= 2 && (
              <button onClick={() => setShowCompare(true)}
                      className="px-2.5 py-1.5 text-xs rounded bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5">
                <GitCompare size={13} /> 对比 {compareIds.size}
              </button>
            )}
            <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />
            <button onClick={() => fileInputRef.current?.click()}
                    title="导入 CSV"
                    className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">
              <Upload size={13} />
            </button>
            <button onClick={handleExport} title="导出 CSV"
                    className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">
              <Download size={13} />
            </button>
            <button onClick={() => setDark(d => !d)} title="切换深色模式"
                    className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">
              {dark ? <Sun size={13} /> : <Moon size={13} />}
            </button>
            <button onClick={() => setEditing("new")}
                    className="px-3 py-1.5 text-xs rounded bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white text-white font-medium flex items-center gap-1.5">
              <Plus size={13} /> 新增
            </button>
          </div>
        </header>

        <FilterBar filters={filters} onChange={setFilters} cases={cases} />

        {/* 主体三栏 */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[300px_1fr_380px]">
          {/* 左：列表 */}
          <aside className="hidden lg:block border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-h-0">
            <CaseList cases={cases} selectedId={selectedId} onSelect={setSelectedId}
                      search={search} onSearchChange={setSearch}
                      compareIds={compareIds} onToggleCompare={toggleCompare}
                      refId={refId} />
          </aside>

          {/* 中：可视化 */}
          <main className="flex flex-col min-h-0 bg-white dark:bg-slate-900">
            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3">
              <div>
                <div className="text-sm font-semibold">
                  {view === "pareto" ? "设计空间 Pareto 图" : "趋势图"}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {view === "pareto"
                    ? "横轴：泵功率（对数） ｜ 纵轴：热阻 ｜ 虚线为 Pareto 前沿（最优解集）"
                    : "选 X、Y 变量自由组合"}
                </div>
              </div>
              {view === "trend" && (
                <div className="ml-auto flex items-center gap-2">
                  <Select value={trendX} onChange={setTrendX} options={TREND_X_VARS.map(v => ({ value: v.key, label: v.label }))} />
                  <span className="text-slate-400 text-xs">vs</span>
                  <Select value={trendY} onChange={setTrendY} options={TREND_Y_VARS.map(v => ({ value: v.key, label: v.label }))} />
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 p-4 flex items-center justify-center overflow-auto">
              {view === "pareto" ? (
                <ParetoPlot cases={cases} filteredIds={filteredIds} selectedId={selectedId}
                            onSelect={setSelectedId} refId={refId} />
              ) : (
                <TrendPlot cases={cases} filteredIds={filteredIds} xKey={trendX} yKey={trendY} refId={refId} />
              )}
            </div>
            {/* 图例 */}
            {view === "pareto" && (
              <div className="px-5 py-2.5 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
                <div className="text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wider">图例</div>
                <div className="flex flex-wrap gap-3">
                  {SHAPES.filter(s => cases.some(c => c.shape === s)).map(s => (
                    <div key={s} className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: SHAPE_COLORS[s] }} />
                      <span>{s}</span>
                    </div>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-3 text-slate-500 dark:text-slate-400">
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-slate-500" />顺排</span>
                  <span className="flex items-center gap-1">
                    <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="5,1 9,5 5,9 1,5" fill="white" stroke="#64748b" strokeWidth="1.5" /></svg>
                    叉排
                  </span>
                </div>
              </div>
            )}
          </main>

          {/* 右：详情 */}
          <aside className="hidden lg:block border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-h-0">
            <DetailPanel
              caseData={selectedCase}
              refCase={refCase}
              isRef={selectedCase?.id === refId}
              onClose={() => setSelectedId(null)}
              onEdit={() => selectedCase && setEditing(selectedCase)}
              onDelete={() => selectedCase && deleteCase(selectedCase.id)}
              onDuplicate={() => selectedCase && duplicateCase(selectedCase.id)}
              onSetRef={setRefId}
            />
          </aside>
        </div>

        {/* 移动端：列表 + 详情切换面板（简化） */}
        <div className="lg:hidden border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 max-h-[40vh] overflow-auto">
          <CaseList cases={cases} selectedId={selectedId} onSelect={setSelectedId}
                    search={search} onSearchChange={setSearch}
                    compareIds={compareIds} onToggleCompare={toggleCompare}
                    refId={refId} />
        </div>

        {/* Modals */}
        {editing !== null && (
          <CaseFormModal
            initial={editing === "new" ? null : editing}
            onSave={saveCase}
            onClose={() => setEditing(null)}
            existingIds={existingIds}
          />
        )}

        {showCompare && compareCases.length >= 2 && (
          <CompareModal
            cases={compareCases}
            refCase={refCase}
            onClose={() => setShowCompare(false)}
          />
        )}
      </div>
    </div>
  );
}
