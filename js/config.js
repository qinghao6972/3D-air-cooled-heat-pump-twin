/* =============================================================================
 * config.js — 场景常量 / 设备台账 / 点位表
 * 坐标系：GLB 由 Blender 以 export_yup=True 导出，
 *         Blender (x, y, z)  ->  glTF (x, z, -y)
 *         本文件中除 PIPE_PATHS 外均为 glTF 坐标；管路按 Blender 坐标书写后由 b2g() 转换，
 *         以便与 models/00_SceneLayout.py 中的数值逐一对应。
 * ========================================================================== */

/** Blender 坐标 -> glTF 坐标 */
export const b2g = (p) => [p[0], p[2], -p[1]];
export const b2gPath = (pts) => pts.map(b2g);

/* ---------------------------------------------------------------- 场地与管网 */
export const SITE = {
  fx: 40.0, fy: 25.0,                 // 1000 m² 混凝土地面
  zr: 1.75, zb: 1.15,                 // 红色供水 / 蓝色回水 主管标高
  pr: 0.10,                           // DN200 半径
  testX: [-19.80, 0.60],              // 试验区
  testY: [-6.40, 6.40],
};

export const HP_COLS = [-17.40, -12.60, -7.80, -3.00];   // 2 排 × 4 列
export const HP_ROWS = [-3.80, 3.80];
export const PUMP_X = 4.20;
export const PUMP_Y = [-4.20, -1.40, 1.40, 4.20];
export const BOILER_AT = b2g([13.00, 8.40, 0]);
export const TANK_AT = b2g([13.00, -4.20, 0]);
export const CR_AT = b2g([17.80, 0, 0]);
export const FCU_AT = b2g([17.80, 0, 2.26]);

/* --------------------------------------------------------------- 设备台账 */
// kind 决定仿真模型；四个 bbox 用于聚焦取景（glTF 坐标，[min],[max]）
export const EQUIPMENT = [
  // 排号 ri(0..1) × 列号 ci(0..3)：先排后列 -> HP_01..HP_04 为南排，HP_05..HP_08 为北排
  ...HP_ROWS.flatMap((cy, ri) => HP_COLS.map((cx, ci) => {
    const n = String(ri * 4 + ci + 1).padStart(2, '0');
    return {
      id: `HP_${n}`, node: `HP_${n}`, tag: `HP-${n}`,
      kind: 'heatpump', group: '试验机组',
      name: '风冷热泵机组', model: 'ACHP-1300/4R',
      pos: b2g([cx, cy, 0]), size: [4.0, 2.5, 2.0],
    };
  })),
  ...PUMP_Y.map((py, i) => ({
    id: `PUMP_${String(i + 1).padStart(2, '0')}`,
    node: `PUMP_${String(i + 1).padStart(2, '0')}`,
    tag: `PMP-${String(i + 1).padStart(2, '0')}`,
    kind: 'pump', group: '循环水泵',
    name: '离心水泵', model: 'CP-100/32',
    pos: b2g([PUMP_X, py, 0.10]), size: [1.96, 1.22, 0.64],
  })),
  { id: 'Boiler', node: 'Boiler', tag: 'BLR-01', kind: 'boiler', group: '热源',
    name: '蒸汽锅炉', model: 'LSS-3.0/1.5', pos: BOILER_AT, size: [4.48, 2.92, 2.0] },
  { id: 'WaterTank', node: 'WaterTank', tag: 'TNK-01', kind: 'tank', group: '蓄水',
    name: '组合式不锈钢水箱', model: 'V=30 m³', pos: TANK_AT, size: [5.6, 2.4, 3.2] },
  { id: 'FCU_01', node: 'FCU_01', tag: 'FCU-01', kind: 'fcu', group: '控制室',
    name: '吊顶式风机盘管', model: 'FP-51WA', pos: FCU_AT, size: [1.82, 1.40, 1.57] },
  { id: 'PG_01', node: 'PG_01', tag: 'PG-01', kind: 'gauge', group: '压力测点',
    name: '压力表组', model: 'DN15 三通阀组', pos: b2g([5.90, -2.10, 1.82]), size: [0.5, 0.95, 0.5] },
  { id: 'PG_02', node: 'PG_02', tag: 'PG-02', kind: 'gauge', group: '压力测点',
    name: '压力表组', model: 'DN15 三通阀组', pos: b2g([2.60, 2.10, 1.22]), size: [0.5, 0.95, 0.5] },
  { id: 'PG_03', node: 'PG_03', tag: 'PG-03', kind: 'gauge', group: '压力测点',
    name: '压力表组', model: 'DN15 三通阀组', pos: b2g([-8.95, -0.70, 1.82]), size: [0.5, 0.95, 0.5] },
  { id: 'PG_04', node: 'PG_04', tag: 'PG-04', kind: 'gauge', group: '压力测点',
    name: '压力表组', model: 'DN15 三通阀组', pos: b2g([-1.85, 0.70, 1.22]), size: [0.5, 0.95, 0.5] },
  { id: 'PG_05', node: 'PG_05', tag: 'PG-05', kind: 'gauge', group: '压力测点',
    name: '压力表组', model: 'DN15 三通阀组', pos: b2g([10.40, 3.60, 1.82]), size: [0.5, 0.95, 0.5] },
  { id: 'PG_06', node: 'PG_06', tag: 'PG-06', kind: 'gauge', group: '压力测点',
    name: '压力表组', model: 'DN15 三通阀组', pos: b2g([8.60, 0.60, 1.22]), size: [0.5, 0.95, 0.5] },
];

export const EQUIP_BY_NODE = Object.fromEntries(EQUIPMENT.map((e) => [e.node, e]));

/* --------------------------------------------------------------- 管路路径 */
// 全部按 models/00_SceneLayout.py 的原值书写（Blender 坐标）
const R = SITE.zr, B = SITE.zb;
const hpBranch = (cx, cy) => {
  const s = cy > 0 ? 1 : -1;
  const face = cy - s * 1.01, inn = cy - s * 0.73;
  return {
    red: b2gPath([[cx - 1.15, -0.70, R], [cx - 1.15, face, R], [cx - 1.15, face, 0.85], [cx - 1.15, inn, 0.85]]),
    blu: b2gPath([[cx + 1.15, 0.70, B], [cx + 1.15, face, B], [cx + 1.15, face, 0.55], [cx + 1.15, inn, 0.55]]),
  };
};
const pumpTie = (py) => ({
  blu: b2gPath([[3.585, py, 0.95], [3.585, py - 0.34, 0.95], [3.585, py - 0.34, B], [2.60, py - 0.34, B]]),
  red: b2gPath([[3.835, py, 1.02], [3.835, py + 0.34, 1.02], [3.835, py + 0.34, R], [5.90, py + 0.34, R]]),
});

export const PIPE_RUNS = [
  { id: 'PP_RedMainAisle', kind: 'red', label: '供水主管 DN200',
    path: b2gPath([[-19.90, -0.70, R], [10.40, -0.70, R], [10.40, 8.40, R], [10.40, 8.40, 3.30], [12.38, 8.40, 3.30], [12.38, 8.40, 2.07]]) },
  { id: 'PP_RedPumpHdr', kind: 'red', label: '供水集管 DN200',
    path: b2gPath([[5.90, -6.60, R], [5.90, 6.60, R]]) },
  { id: 'PP_BluMainAisle', kind: 'blu', label: '回水主管 DN200',
    path: b2gPath([[-19.90, 0.70, B], [2.60, 0.70, B]]) },
  { id: 'PP_BluPumpHdr', kind: 'blu', label: '回水集管 DN200',
    path: b2gPath([[2.60, -6.60, B], [2.60, 6.60, B]]) },
  { id: 'PP_BluToTank', kind: 'blu', label: '水箱回水支干管',
    path: b2gPath([[2.60, 6.60, B], [8.60, 6.60, B], [8.60, -4.20, B], [9.40, -4.20, B], [9.40, -4.20, 0.64], [10.05, -4.20, 0.64]]) },
  ...HP_COLS.flatMap((cx, ci) => HP_ROWS.map((cy, ri) => {
    const n = String(ri * 4 + ci + 1).padStart(2, '0');
    const p = hpBranch(cx, cy);
    return [
      { id: `PP_RedBr_${n}`, kind: 'red', owner: `HP_${n}`, label: `HP-${n} 供水支管`, path: p.red },
      { id: `PP_BluBr_${n}`, kind: 'blu', owner: `HP_${n}`, label: `HP-${n} 回水支管`, path: p.blu },
    ];
  })).flat(),
  ...PUMP_Y.flatMap((py, i) => {
    const n = String(i + 1).padStart(2, '0');
    const t = pumpTie(py);
    return [
      { id: `PP_PumpDis_${n}`, kind: 'red', owner: `PUMP_${n}`, label: `PMP-${n} 出水管`, path: t.red },
      { id: `PP_PumpSuc_${n}`, kind: 'blu', owner: `PUMP_${n}`, label: `PMP-${n} 吸水管`, path: t.blu },
    ];
  }),
];

/* --------------------------------------------------- 点位表（来自图纸文字） */
// 参考 PDF《风冷热泵控制设备配置》中唯一可提取的 11 条中文点位描述
export const POINT_TYPES = {
  pumpStart:  { name: '水泵启停控制',       code: 'DO', unit: '' },
  pumpRun:    { name: '水泵运行',           code: 'DI', unit: '' },
  pumpFault:  { name: '水泵故障',           code: 'DI', unit: '' },
  pumpMode:   { name: '手/自动状态',         code: 'DI', unit: '' },
  pumpFreq:   { name: '水泵频率调节及反馈',   code: 'AO/AI', unit: 'Hz' },
  temp:       { name: '温度传感器：温度',     code: 'AI', unit: '℃' },
  press:      { name: '压力传感器：压力',     code: 'AI', unit: 'MPa' },
  level:      { name: '液位传感器：液面高度', code: 'AI', unit: '%' },
  valveState: { name: '阀门开关状态',        code: 'DI', unit: '' },
  valveCtrl:  { name: '阀门开关控制',        code: 'DO', unit: '' },
  protocol:   { name: '高级协议',            code: 'BMS', unit: '' },
};

/** 每类设备对外暴露的点位（key 对应 POINT_TYPES） */
export const DEVICE_POINTS = {
  heatpump: ['pumpStart', 'pumpRun', 'pumpFault', 'pumpMode', 'temp', 'press', 'valveState', 'valveCtrl', 'protocol'],
  pump:     ['pumpStart', 'pumpRun', 'pumpFault', 'pumpMode', 'pumpFreq', 'temp', 'press', 'valveState', 'protocol'],
  boiler:   ['pumpStart', 'pumpRun', 'pumpFault', 'pumpMode', 'temp', 'press', 'valveState', 'valveCtrl', 'protocol'],
  tank:     ['level', 'temp', 'valveState', 'valveCtrl', 'protocol'],
  fcu:      ['pumpRun', 'pumpFreq', 'temp', 'valveState', 'protocol'],
  gauge:    ['press', 'valveState', 'protocol'],
};

/* ------------------------------------------------------------------ 视图 */
export const VIEWS = [
  { id: 'overview', label: '总览',   pos: [36, 26, 40],    target: [-2, 1.2, 0] },
  { id: 'top',      label: '俯视',   pos: [0, 62, 0.01],  target: [0, 0, 0] },
  { id: 'test',     label: '试验区', pos: [-4, 12, 26],   target: [-10, 1.4, 0] },
  { id: 'aisle',    label: '主通道', pos: [-21, 1.8, 1.2], target: [16, 1.1, -0.6] },
  { id: 'pumps',    label: '水泵房', pos: [11, 7.5, 13],  target: [4.2, 1.0, 0] },
  { id: 'boiler',   label: '锅炉房', pos: [22, 8, -1],    target: [13, 1.6, -8.4] },
  { id: 'tank',     label: '水箱',   pos: [22, 7, 11],    target: [13, 1.2, 4.2] },
  { id: 'cr',       label: '控制室', pos: [10, 5.5, 6],   target: [17.8, 1.6, 0] },
];

export const LAYERS = [
  { id: 'model',  label: '设备模型', on: true },
  { id: 'flow',   label: '管道流向', on: true },
  { id: 'halo',   label: '状态光环', on: true },
  { id: 'label',  label: '设备标签', on: true },
  { id: 'zones',  label: '分区标线', on: true },
  { id: 'walls',  label: '建筑构件', on: true },
];

export const STATUS_COLORS = {
  running: '#22d39a', standby: '#9fb2c9', fault: '#ff4d5e', offline: '#5b6b80', maint: '#ffb020',
};
export const PIPE_COLORS = { red: '#e5433f', blu: '#2f7fe0' };
