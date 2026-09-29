/* =============================================================================
 * sim.js — 数字孪生实时仿真引擎
 * 纯前端数据模拟：设备状态机 + 水力/热力耦合 + 点位刷新 + 告警事件 + 趋势缓存
 * ========================================================================== */
import { EQUIPMENT, DEVICE_POINTS, POINT_TYPES, STATUS_COLORS } from './config.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** 一阶惯性环节：让模拟量平滑趋近目标值 */
const approach = (cur, tgt, rate, dt) => cur + (tgt - cur) * clamp(rate * dt, 0, 1);

const NOMINAL = {
  heatpump: { q: 130, p: 38.5, cop: 3.38, fan: 6.2 },   // kW / kW / - / 风机 Hz
  pump: { flow: 100, head: 32, p: 15.0 },               // m³/h / m / kW
  boiler: { q: 2100, p: 0, cop: 0.94 },                 // kW 热
  fcu: { flow: 0.85, p: 0.12 },                         // 风量 m³/s / kW
};

class Device {
  constructor(def) {
    Object.assign(this, def);
    this.status = 'standby';
    this.prevStatus = 'standby';
    this.runHours = Math.round(rnd(1200, 9800));
    this.load = 0;                    // 0..1 负荷率
    this.freq = 0;                    // 水泵频率 Hz
    this.online = true;
    this.mode = Math.random() < 0.85 ? '自动' : '手动';
    this.valve = '开';
    this.valveCmd = '开';
    this.faultCode = null;
    this.temp = 0; this.press = 0; this.level = 0; this.flow = 0; this.power = 0; this.q = 0;
    this.extra = {};                  // 设备专有遥测（风机频率 / 送风温度 ...）
    this.pts = {};
    this._t = rnd(0, 10);
  }
  get color() { return STATUS_COLORS[this.status]; }
  get statusText() {
    return { running: '运行', standby: '待机', fault: '故障', offline: '离线', maint: '检修' }[this.status];
  }
}

export class TwinSim {
  constructor() {
    this.devices = new Map();
    this.list = EQUIPMENT.map((d) => { const dev = new Device(d); this.devices.set(dev.node, dev); return dev; });
    this.time = 0;
    this.clock = new Date();
    this.events = [];
    this.seq = 0;
    this.listeners = { tick: [], event: [], select: [] };
    this.trend = { t: [], Ts: [], Tr: [], load: [], cop: [], power: [] };
    this.system = { Ts: 7.0, Tr: 12.0, dT: 5.0, flow: 0, power: 0, cop: 0, q: 0,
                    running: 0, total: this.list.length, online: this.list.length, alarm: 0, mode: '自动' };
    this.scenario = 0;
    this._acc = 0;
    this._evtAcc = 0;
    this._seedStates();
  }

  on(evt, cb) { this.listeners[evt]?.push(cb); return this; }
  emit(evt, ...a) { this.listeners[evt]?.forEach((f) => f(...a)); }

  /** 初始工况：南排机组 + 1、3 号泵运行，形成可见的“运行中”画面 */
  _seedStates() {
    this.list.forEach((d) => {
      if (d.kind === 'heatpump') {
        d.status = /0[1-6]/.test(d.tag.slice(-2)) ? 'running' : 'standby';
        d.load = d.status === 'running' ? rnd(0.45, 0.92) : 0;
      } else if (d.kind === 'pump') {
        d.status = /0[13]/.test(d.tag.slice(-2)) ? 'running' : 'standby';
        d.freq = d.status === 'running' ? rnd(38, 47) : 0;
      } else if (d.kind === 'boiler') { d.status = 'running'; d.load = 0.62; }
      else if (d.kind === 'tank') { d.level = 78.4; d.temp = 11.2; }
      else if (d.kind === 'fcu') { d.status = 'running'; d.load = 0.55; }
      else if (d.kind === 'gauge') { d.press = rnd(0.32, 0.62); }
    });
    this._log('info', 'SYS', '数字孪生平台启动，模型载入完成');
    this._log('info', 'SYS', 'BMS 高级协议网关握手成功（Modbus TCP / BACnet IP）');
    this._log('info', 'SYS', '试验区分区阀门已置为自动模式');
  }

  _log(level, tag, text) {
    const e = { id: ++this.seq, t: new Date(), level, tag, text };
    this.events.unshift(e);
    if (this.events.length > 240) this.events.length = 240;
    this.emit('event', e);
    return e;
  }
  log(level, tag, text) { return this._log(level, tag, text); }

  /* ------------------------------------------------------------- 主循环 */
  step(dt) {
    this.time += dt;
    this.clock = new Date();
    this._acc += dt;
    const coarse = this._acc >= 1.0;      // 遥测刷新周期 1 s
    if (coarse) this._acc = 0;

    const sys = this.system;
    let flow = 0, power = 0, q = 0, running = 0, fault = 0;
    const hpRun = this.list.filter((d) => d.kind === 'heatpump' && d.status === 'running');

    for (const d of this.list) {
      d._t += dt;
      const n = NOMINAL[d.kind] || {};
      switch (d.kind) {
        case 'heatpump': {
          if (d.status === 'running') {
            d.load = clamp(approach(d.load, 0.55 + 0.35 * Math.sin(this.time / 47 + d._t * 0.11), 0.35, dt), 0.18, 1);
            d.q = n.q * d.load;
            d.power = n.p * (0.34 + 0.66 * d.load);
            d.temp = approach(d.temp, 6.6 + 1.5 * (1 - d.load) + 0.25 * Math.sin(this.time / 9 + d._t), 0.25, dt);
            d.press = approach(d.press, 1.42 + 0.22 * d.load, 0.3, dt);
            d.extra.fan = approach(d.extra.fan ?? 0, n.fan * (0.55 + 0.45 * d.load), 0.5, dt);
            d.extra.coil = 42.5 + 5.5 * d.load + 1.2 * Math.sin(this.time / 6 + d._t);
            running++;
          } else {
            d.load = approach(d.load, 0, 0.8, dt); d.q = 0; d.power = 0;
            d.extra.fan = approach(d.extra.fan ?? 0, 0, 0.8, dt);
            d.temp = approach(d.temp, 22.5 + 0.6 * Math.sin(this.time / 30 + d._t), 0.1, dt);
            d.press = approach(d.press, 1.05, 0.15, dt);
            d.extra.coil = approach(d.extra.coil ?? 24, 24.5, 0.1, dt);
          }
          d.extra.curr = d.status === 'running' ? d.power / 0.38 / 1.732 / 0.9 : 0;
          d.extra.evap = d.temp - 3.4;
          d.extra.suction = 0.62 + 0.16 * d.load;
          break;
        }
        case 'pump': {
          if (d.status === 'running') {
            d.freq = approach(d.freq, 44 + 3.2 * Math.sin(this.time / 38 + d._t * 0.2), 0.35, dt);
            const ratio = d.freq / 50;
            d.flow = n.flow * ratio;
            d.extra.head = n.head * ratio * ratio;
            d.power = n.p * Math.pow(ratio, 3) / 0.92;
            d.press = 0.24 + 0.30 * ratio * ratio;
            d.temp = approach(d.temp, 11.4 + 0.4 * Math.sin(this.time / 12 + d._t), 0.2, dt);
            d.extra.curr = d.power / 0.38 / 1.732 / 0.88;
            running++;
          } else {
            d.freq = approach(d.freq, 0, 1.2, dt);
            d.flow = approach(d.flow, 0, 1.2, dt); d.power = 0;
            d.extra.head = approach(d.extra.head ?? 0, 0, 1.2, dt);
            d.press = approach(d.press, 0.18, 0.4, dt);
            d.temp = approach(d.temp, 20.5, 0.12, dt);
            d.extra.curr = 0;
          }
          break;
        }
        case 'boiler': {
          if (d.status === 'running') {
            d.temp = approach(d.temp, 95 + 2.5 * Math.sin(this.time / 55 + d._t), 0.15, dt);
            d.press = approach(d.press, 0.98 + 0.06 * Math.sin(this.time / 21), 0.2, dt);
            d.q = n.q * d.load; d.power = n.q / n.cop * 0;
            d.extra.flue = 168 + 14 * d.load;
            d.extra.level = approach(d.extra.level ?? 62, 58 + 8 * Math.sin(this.time / 70), 0.2, dt);
            running++;
          } else {
            d.temp = approach(d.temp, 46, 0.06, dt); d.q = 0; d.press = approach(d.press, 0.12, 0.2, dt);
            d.extra.flue = approach(d.extra.flue ?? 168, 32, 0.08, dt);
          }
          break;
        }
        case 'tank': {
          d.level = clamp(approach(d.level, 74 + 9 * Math.sin(this.time / 96), 0.1, dt), 8, 96);
          d.temp = approach(d.temp, 11.0 + 0.9 * Math.sin(this.time / 44), 0.1, dt);
          break;
        }
        case 'fcu': {
          if (d.status === 'running') {
            d.extra.air = approach(d.extra.air ?? 0, 0.78 * (0.7 + 0.3 * Math.sin(this.time / 26)), 0.4, dt);
            d.temp = approach(d.temp, 24.5 - 7.5 * d.load + 0.4 * Math.sin(this.time / 15), 0.2, dt);
            d.power = 0.12; running++;
          } else { d.extra.air = approach(d.extra.air ?? 0, 0, 0.5, dt); d.power = 0; d.temp = approach(d.temp, 27.5, 0.1, dt); }
          break;
        }
        case 'gauge': {
          const jitter = 0.012 * Math.sin(this.time * 2.1 + d._t * 3.3);
          d.press = approach(d.press, (d.tag === 'PG-01' || d.tag === 'PG-03' || d.tag === 'PG-05' ? 0.52 : 0.34) + jitter, 0.6, dt);
          break;
        }
      }
      if (d.status === 'fault') fault++;
      if (d.kind === 'pump') flow += d.flow;
      power += d.power || 0;
      q += d.q || 0;
      if (coarse) this._syncPoints(d);
    }

    /* 系统级水力/热力耦合 */
    const ratio = clamp(flow / 400, 0, 1);
    sys.flow = flow;
    sys.Ts = approach(sys.Ts, hpRun.length ? 6.4 + 1.9 * (1 - clamp(hpRun.length / 8, 0, 1)) : 13.8, 0.12, dt);
    sys.Tr = approach(sys.Tr, sys.Ts + (ratio > 0.05 ? clamp(q * 0.86 / Math.max(flow, 1) * 4.2, 2.0, 8.5) : 2.4), 0.12, dt);
    sys.dT = sys.Tr - sys.Ts;
    // 热泵电功率 + 水泵电功率 + 辅机
    sys.power = power + 3.6;
    sys.q = flow > 1 ? flow * 1.163 * sys.dT * 1000 / 3600 : 0;   // m³/h·K -> kW
    sys.cop = sys.power > 0.5 ? sys.q / sys.power : 0;
    sys.running = running; sys.alarm = fault;
    sys.online = this.list.filter((d) => d.online).length;

    if (coarse) {
      const T = this.trend;
      T.t.push(this.time); T.Ts.push(sys.Ts); T.Tr.push(sys.Tr);
      T.load.push(clamp(sys.q / (8 * 130), 0, 1)); T.cop.push(sys.cop); T.power.push(sys.power);
      const CAP = 180;
      for (const k of Object.keys(T)) if (T[k].length > CAP) T[k].shift();
      this.emit('tick', this);
      this._scenarios(dt);
    }
  }

  _syncPoints(d) {
    const v = {};
    switch (d.kind) {
      case 'heatpump':
        v.pumpStart = d.status === 'running' ? '启动' : '停止';
        v.pumpRun = d.status === 'running' ? '运行' : '停止';
        v.pumpFault = d.status === 'fault' ? '故障' : '正常';
        v.pumpMode = d.mode;
        v.temp = `${d.temp.toFixed(1)} ℃ 供水 / ${(d.temp + 5).toFixed(1)} ℃ 回水`;
        v.press = `${d.press.toFixed(2)} MPa`;
        v.valveState = d.valve; v.valveCtrl = d.valveCmd;
        v.protocol = d.online ? '在线' : '离线';
        break;
      case 'pump':
        v.pumpStart = d.status === 'running' ? '启动' : '停止';
        v.pumpRun = d.status === 'running' ? '运行' : '停止';
        v.pumpFault = d.status === 'fault' ? '故障' : '正常';
        v.pumpMode = d.mode;
        v.pumpFreq = `${d.freq.toFixed(1)} Hz（反馈 ${(d.freq * 0.998).toFixed(1)} Hz）`;
        v.temp = `${d.temp.toFixed(1)} ℃`;
        v.press = `${d.press.toFixed(2)} MPa`;
        v.valveState = d.valve;
        v.protocol = d.online ? '在线' : '离线';
        break;
      case 'boiler':
        v.pumpStart = d.status === 'running' ? '启动' : '停止';
        v.pumpRun = d.status === 'running' ? '运行' : '停止';
        v.pumpFault = d.status === 'fault' ? '故障' : '正常';
        v.pumpMode = d.mode;
        v.temp = `${d.temp.toFixed(1)} ℃`;
        v.press = `${d.press.toFixed(2)} MPa`;
        v.valveState = d.valve; v.valveCtrl = d.valveCmd;
        v.protocol = d.online ? '在线' : '离线';
        break;
      case 'tank':
        v.level = `${d.level.toFixed(1)} %`;
        v.temp = `${d.temp.toFixed(1)} ℃`;
        v.valveState = d.valve; v.valveCtrl = d.valveCmd;
        v.protocol = d.online ? '在线' : '离线';
        break;
      case 'fcu':
        v.pumpRun = d.status === 'running' ? '运行' : '停止';
        v.pumpFreq = `${((d.extra.air || 0) * 1000).toFixed(0)} m³/h`;
        v.temp = `${d.temp.toFixed(1)} ℃`;
        v.valveState = d.valve;
        v.protocol = d.online ? '在线' : '离线';
        break;
      case 'gauge':
        v.press = `${d.press.toFixed(3)} MPa`;
        v.valveState = d.valve;
        v.protocol = d.online ? '在线' : '离线';
        break;
    }
    const keys = DEVICE_POINTS[d.kind] || [];
    d.pts = keys.map((k) => ({ key: k, ...POINT_TYPES[k], value: v[k] ?? '—' }));
  }

  /** 运行台数 / 负荷 / COP / 能耗 */
  get metrics() {
    const s = this.system;
    const T = this.trend;
    const energy = T.power.reduce((a, b) => a + b, 0) / 3600;   // kWh（1 s 采样）
    return {
      ...s,
      energy,
      load: clamp(s.q / (8 * 130), 0, 1),
      hpRun: this.list.filter((d) => d.kind === 'heatpump' && d.status === 'running').length,
      hpTotal: 8,
      pumpRun: this.list.filter((d) => d.kind === 'pump' && d.status === 'running').length,
      pumpTotal: 4,
    };
  }

  /* ----------------------------------------------------- 事件/故障注入 */
  _scenarios(dt) {
    this._evtAcc += dt;
    if (this._evtAcc < 3.2) return;
    this._evtAcc = 0;
    const r = Math.random();
    if (r < 0.22) {
      const d = this._pick(['pump'], (x) => x.status === 'running');
      if (d) {
        const nh = (d.freq + rnd(-2.2, 2.2)).toFixed(1);
        this._log('info', d.tag, `变频调节：频率设定 ${nh} Hz，反馈跟随正常`);
      }
    } else if (r < 0.32) {
      const d = this._pick(['heatpump'], (x) => x.status === 'running');
      if (d) this._log('info', d.tag, `机组加载：当前负荷 ${(d.load * 100).toFixed(0)} %，翅片温度 ${(d.extra.coil || 0).toFixed(1)} ℃`);
    } else if (r < 0.40) {
      const d = this._pick(['heatpump'], (x) => x.status === 'standby');
      if (d) { d.status = 'running'; d.load = 0.35; this._log('info', d.tag, '投入运行（区域负荷需求上升）'); }
    } else if (r < 0.46) {
      const d = this._pick(['heatpump'], (x) => x.status === 'running' && x.load < 0.5);
      if (d) { d.status = 'standby'; this._log('info', d.tag, '按需停机（负荷回落）'); }
    } else if (r < 0.52) {
      const d = this._pick(['pump'], (x) => x.status === 'running');
      if (d) {
        const cur = d.valve;
        d.valveCmd = cur === '开' ? '关' : '开';
        setTimeout(() => { d.valve = d.valveCmd; this._log('info', d.tag, `电动阀${d.valve}到位（阀门开关状态反馈一致）`); }, 1400);
        this._log('info', d.tag, `下发阀门开关控制指令：${d.valveCmd}`);
      }
    } else if (r < 0.56 && this.system.alarm === 0) {
      const d = this._pick(['heatpump', 'pump'], (x) => x.status === 'running');
      if (d) {
        d.status = 'fault';
        d.faultCode = ['E-201 高压保护', 'E-118 水流开关断开', 'E-305 电机过载'][Math.floor(Math.random() * 3)];
        this._log('fault', d.tag, `${d.faultCode}，设备停机并上送故障信号`);
      }
    } else if (r < 0.66) {
      const d = this._pick(null, (x) => x.status === 'fault');
      if (d) {
        d.status = d.kind === 'pump' ? 'running' : 'running';
        this._log('info', d.tag, `故障复位成功（${d.faultCode}），恢复运行`);
        d.faultCode = null;
      }
    } else if (r < 0.74) {
      this._log('info', 'TNK-01', `液位 ${this.devices.get('WaterTank').level.toFixed(1)} %，补水阀动作正常`);
    } else if (r < 0.80) {
      this._log('warn', 'PG-05', `供水压力 ${this.devices.get('PG_05').press.toFixed(3)} MPa，接近低压预警线`);
    } else if (r < 0.86) {
      this._log('info', 'BLR-01', `锅炉汽包压力 ${this.devices.get('Boiler').press.toFixed(2)} MPa，燃烧器自动调节`);
    } else if (r < 0.90) {
      this._log('info', 'SYS', `BMS 轮询完成：${this.list.length} 台设备在线，${this.system.alarm} 条未复位告警`);
    }
  }
  _pick(kinds, filt) {
    const pool = this.list.filter((d) => (!kinds || kinds.includes(d.kind)) && filt(d));
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  /* ------------------------------------------------------ 人工干预接口 */
  command(node, action) {
    const d = this.devices.get(node); if (!d) return;
    if (action === 'start') { d.status = 'running'; d.load = 0.4; this._log('info', d.tag, '远程启动指令下发（DO 水泵启停控制）'); }
    if (action === 'stop') { d.status = 'standby'; this._log('info', d.tag, '远程停机指令下发'); }
    if (action === 'toggle') {
      if (d.status === 'running') this.command(node, 'stop'); else this.command(node, 'start');
    }
    if (action === 'reset' && d.status === 'fault') { d.status = 'running'; this._log('info', d.tag, '告警复位，设备重新投入'); d.faultCode = null; }
    if (action === 'mode') { d.mode = d.mode === '自动' ? '手动' : '自动'; this._log('info', d.tag, `手/自动状态切换为「${d.mode}」`); }
    if (action === 'valve') {
      d.valveCmd = d.valveCmd === '开' ? '关' : '开';
      const tgt = d.valveCmd;
      setTimeout(() => { d.valve = tgt; this._log('info', d.tag, `电动阀${tgt}到位`); }, 1200);
      this._log('info', d.tag, `电动阀控制指令：${tgt}`);
    }
  }
}
