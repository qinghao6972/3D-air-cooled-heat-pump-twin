/* =============================================================================
 * ui.js — HUD 面板：KPI / 趋势图 / 设备清单 / 设备详情与点位表 / 事件流 / 视角与图层
 * ========================================================================== */
import { EQUIPMENT, VIEWS, LAYERS as CFG_LAYERS, STATUS_COLORS, DEVICE_POINTS, POINT_TYPES } from './config.js';

const $ = (s) => document.querySelector(s);
const fmt = (v, n = 1) => (v === undefined || v === null || Number.isNaN(v) ? '--' : v.toFixed(n));
const hhmmss = (d) => d.toTimeString().slice(0, 8);

const GROUPS = ['试验机组', '循环水泵', '热源', '蓄水', '控制室', '压力测点'];

export class UI {
  constructor(sim, model, app) {
    this.sim = sim; this.model = model; this.app = app;
    this.selected = null;
    this.rows = new Map();
    this.maxEvents = 60;
    this._trendAcc = 0;
    this._buildTopStats();
    this._buildKpis();
    this._buildTree();
    this._buildViews();
    this._buildLayers();
    $('#devCount').textContent = `${EQUIPMENT.length} 台`;
    $('#loadPct').textContent = '100 %';
  }

  /* ------------------------------------------------------------ 顶栏统计 */
  _buildTopStats() {
    const defs = [
      ['hpRun', '热泵运行', (m) => `${m.hpRun}<u>/8 台</u>`],
      ['flow', '系统流量', (m) => `${fmt(m.flow, 0)}<u>m³/h</u>`],
      ['q', '制冷量', (m) => `${fmt(m.q, 0)}<u>kW</u>`],
      ['cop', '系统 COP', (m) => `${fmt(m.cop, 2)}`],
      ['power', '总功率', (m) => `${fmt(m.power, 0)}<u>kW</u>`],
    ];
    $('#topstats').innerHTML = defs.map(([k, label]) =>
      `<div class="st"><i>${label}</i><b data-k="${k}">--</b></div>`).join('');
    this.topEls = Object.fromEntries(defs.map(([k]) => [k, $(`#topstats [data-k="${k}"]`)]));
  }

  /* ------------------------------------------------------------ KPI 卡片 */
  _buildKpis() {
    const defs = [
      ['Ts', '供水温度', '℃', 'b', 1], ['Tr', '回水温度', '℃', 'a', 1],
      ['dT', '供回水温差', 'K', 'b', 1], ['flow', '系统流量', 'm³/h', 'b', 0],
      ['power', '系统总功率', 'kW', 'a', 1], ['q', '制冷量', 'kW', 'g', 0],
      ['cop', '系统 COP', '', 'g', 2], ['running', '运行设备', '台', 'b', 0],
    ];
    $('#kpis').innerHTML = defs.map(([k, label, unit, cls, dp]) =>
      `<div class="kpi ${cls}"><i>${label}</i><b data-k="${k}">--<u>${unit}</u></b>
       <small data-s="${k}"></small></div>`).join('');
    this.kpiEls = Object.fromEntries(defs.map(([k, , , , dp]) =>
      [k, { v: $(`#kpis [data-k="${k}"]`), s: $(`#kpis [data-s="${k}"]`), dp }]));
  }

  /* ------------------------------------------------------------ 设备清单 */
  _buildTree() {
    const host = $('#tree');
    host.innerHTML = '';
    for (const g of GROUPS) {
      const list = EQUIPMENT.filter((e) => e.group === g);
      if (!list.length) continue;
      const h = document.createElement('div');
      h.className = 'grp'; h.textContent = `${g} · ${list.length}`;
      host.appendChild(h);
      for (const e of list) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="dot"></span><span class="tag">${e.tag}</span>
          <span class="nm">${e.name}</span><span class="val">--</span>`;
        row.addEventListener('click', () => this.app.select(e.id, true));
        row.addEventListener('dblclick', () => this.app.focus(e.id));
        host.appendChild(row);
        this.rows.set(e.id, row);
      }
    }
  }

  _rowValue(d) {
    switch (d.kind) {
      case 'heatpump': return d.status === 'running' ? `${fmt(d.load * 100, 0)}%` : d.statusText;
      case 'pump': return d.status === 'running' ? `${fmt(d.freq, 1)}Hz` : d.statusText;
      case 'boiler': return d.status === 'running' ? `${fmt(d.temp, 0)}℃` : d.statusText;
      case 'tank': return `${fmt(d.level, 1)}%`;
      case 'fcu': return d.status === 'running' ? `${fmt(d.temp, 1)}℃` : d.statusText;
      case 'gauge': return `${fmt(d.press, 3)}MPa`;
      default: return d.statusText;
    }
  }

  /* ------------------------------------------------------------ 视角/图层 */
  _buildViews() {
    $('#viewbar').innerHTML = VIEWS.map((v) =>
      `<button data-v="${v.id}"${v.id === 'overview' ? ' class="on"' : ''}>${v.label}</button>`).join('')
      + `<button data-v="__fit">适配</button>`;
    $('#viewbar').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      [...$('#viewbar').children].forEach((c) => c.classList.toggle('on', c === b));
      if (b.dataset.v === '__fit') this.app.fitAll(); else this.app.setView(b.dataset.v);
    });
  }

  _buildLayers() {
    $('#layers').innerHTML = CFG_LAYERS.map((l) =>
      `<button data-l="${l.id}" class="${l.on ? 'on' : ''}">${l.label}</button>`).join('');
    $('#layers').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      b.classList.toggle('on');
      this.app.setLayer(b.dataset.l, b.classList.contains('on'));
    });
  }

  /* ------------------------------------------------------------ 设备详情 */
  renderDetail() {
    const id = this.selected;
    const body = $('#detailBody'), empty = $('#detailEmpty');
    if (!id) { body.hidden = true; empty.hidden = false; return; }
    const e = EQUIPMENT.find((x) => x.id === id), d = this.sim.devices.get(id);
    empty.hidden = true; body.hidden = false;

    const cells = this._detailCells(d);
    body.innerHTML = `
      <div class="dhead">
        <div>
          <div class="tag">${e.tag}</div>
          <div class="nm">${e.name}</div>
          <div class="md">${e.model} · ${e.group}</div>
        </div>
        <div class="st">
          <b style="color:${STATUS_COLORS[d.status]}">${d.statusText}</b>
          <i>${d.mode} · ${d.online ? '在线' : '离线'}</i>
          <i>运行 ${d.runHours.toLocaleString()} h</i>
        </div>
      </div>
      <div class="dgrid">${cells}</div>
      ${d.faultCode ? `<div class="evt fault" style="padding:7px 9px;border-radius:7px;margin-bottom:8px">
        <span class="tg">ALARM</span><span class="tx">${d.faultCode}</span></div>` : ''}
      <table class="ptable">
        <thead><tr><th style="width:64px">类型</th><th>点位名称</th><th style="text-align:right">实时值</th></tr></thead>
        <tbody>${d.pts.map((p) => `<tr>
          <td class="io">${p.code}</td>
          <td class="nm"><span class="led ${this._led(p)}"></span>${p.name}</td>
          <td class="vl">${p.value}</td></tr>`).join('')}</tbody>
      </table>
      <div class="cmds">
        <button data-c="toggle">${d.status === 'running' ? '停止' : '启动'}</button>
        <button data-c="reset"${d.status === 'fault' ? '' : ' disabled style="opacity:.45"'}>故障复位</button>
        <button data-c="mode">切换 ${d.mode === '自动' ? '手动' : '自动'}</button>
        <button data-c="valve">阀门${d.valveCmd === '开' ? '关' : '开'}</button>
        <button data-c="focus">定位</button>
      </div>`;
    body.querySelector('.cmds').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.c === 'focus') this.app.focus(id); else this.app.command(id, b.dataset.c);
    });
  }

  _led(p) {
    const v = String(p.value);
    if (p.code === 'DI' || p.code === 'DO') {
      if (/故障|断开/.test(v)) return 'err';
      if (/运行|启动|开|自动|在线/.test(v)) return 'on';
      return '';
    }
    return 'on';
  }

  _detailCells(d) {
    const c = (label, val, unit = '') =>
      `<div class="dcell"><i>${label}</i><b>${val}<u>${unit}</u></b></div>`;
    switch (d.kind) {
      case 'heatpump': return c('负荷率', fmt(d.load * 100, 0), '%') + c('制冷量', fmt(d.q, 0), 'kW')
        + c('输入功率', fmt(d.power, 1), 'kW') + c('出水温度', fmt(d.temp, 1), '℃')
        + c('吸气压力', fmt(d.extra.suction, 2), 'MPa') + c('风机频率', fmt(d.extra.fan, 1), 'Hz')
        + c('翅片温度', fmt(d.extra.coil, 1), '℃') + c('运行电流', fmt(d.extra.curr, 0), 'A')
        + c('蒸发温度', fmt(d.extra.evap, 1), '℃');
      case 'pump': return c('运行频率', fmt(d.freq, 1), 'Hz') + c('流量', fmt(d.flow, 0), 'm³/h')
        + c('扬程', fmt(d.extra.head, 1), 'm') + c('轴功率', fmt(d.power, 1), 'kW')
        + c('出口压力', fmt(d.press, 2), 'MPa') + c('运行电流', fmt(d.extra.curr, 1), 'A')
        + c('介质温度', fmt(d.temp, 1), '℃') + c('转速', fmt(d.freq * 58.8, 0), 'rpm')
        + c('累计运行', d.runHours.toLocaleString(), 'h');
      case 'boiler': return c('汽包压力', fmt(d.press, 2), 'MPa') + c('给水温度', fmt(d.temp, 1), '℃')
        + c('排烟温度', fmt(d.extra.flue, 0), '℃') + c('热功率', fmt(d.q, 0), 'kW')
        + c('水位', fmt(d.extra.level, 0), '%') + c('效率', '94.0', '%')
        + c('负荷率', fmt(d.load * 100, 0), '%') + c('运行', d.runHours.toLocaleString(), 'h')
        + c('燃料', '天然气', '');
      case 'tank': return c('液位', fmt(d.level, 1), '%') + c('水温', fmt(d.temp, 1), '℃')
        + c('有效容积', '30', 'm³') + c('当前水量', fmt(d.level * 0.3, 1), 'm³')
        + c('补水阀', d.valve, '') + c('溢流', '正常', '')
        + c('材质', 'SUS304', '') + c('保温', '50 mm', '') + c('液位计', '在线', '');
      case 'fcu': return c('送风温度', fmt(d.temp, 1), '℃') + c('风量', fmt((d.extra.air || 0) * 3600, 0), 'm³/h')
        + c('功率', fmt(d.power * 1000, 0), 'W') + c('盘管', d.valve, '')
        + c('档位', d.status === 'running' ? '中速' : '停止', '') + c('凝水盘', '正常', '')
        + c('过滤网', '清洁', '') + c('安装', '吊顶', '') + c('房间', '控制室', '');
      case 'gauge': return c('当前压力', fmt(d.press, 3), 'MPa') + c('量程', '0 ~ 1.6', 'MPa')
        + c('精度', '1.6', '级') + c('表阀', d.valve, '')
        + c('取压点', 'DN15', '') + c('缓冲管', '环形', '')
        + c('表盘', 'ø100', 'mm') + c('接口', 'M20×1.5', '') + c('状态', '正常', '');
      default: return '';
    }
  }

  /* ------------------------------------------------------------ 趋势图 */
  drawTrend(force) {
    this._trendAcc += 1;
    if (!force && this._trendAcc % 2) return;
    const cv = $('#trend'), g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const T = this.sim.trend;
    g.clearRect(0, 0, W, H);

    // 网格
    g.strokeStyle = 'rgba(90,130,180,.14)'; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = 8 + (H - 20) * i / 4;
      g.beginPath(); g.moveTo(30, y); g.lineTo(W - 8, y); g.stroke();
    }
    const n = T.t.length;
    if (n < 2) return;
    const x0 = 30, x1 = W - 8, y0 = 8, y1 = H - 12;
    const px = (i) => x0 + (x1 - x0) * i / Math.max(1, n - 1);
    const py = (v, a, b) => y1 - (y1 - y0) * Math.min(1, Math.max(0, (v - a) / (b - a)));

    const series = [
      { d: T.Tr, c: '#ff7a59', a: 4, b: 18 },
      { d: T.Ts, c: '#3ea0ff', a: 4, b: 18 },
      { d: T.load, c: '#22d39a', a: 0, b: 1 },
      { d: T.cop, c: '#ffc857', a: 0, b: 6 },
    ];
    for (const s of series) {
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const X = px(i), Y = py(s.d[i], s.a, s.b);
        i ? g.lineTo(X, Y) : g.moveTo(X, Y);
      }
      g.strokeStyle = s.c; g.lineWidth = 2; g.lineJoin = 'round';
      if (s.c === '#22d39a' || s.c === '#ffc857') g.setLineDash([4, 3]); else g.setLineDash([]);
      g.stroke(); g.setLineDash([]);
      // 末端亮点
      const lx = px(n - 1), ly = py(s.d[n - 1], s.a, s.b);
      g.beginPath(); g.arc(lx, ly, 2.6, 0, 6.3); g.fillStyle = s.c; g.fill();
    }
    // 坐标标签
    g.fillStyle = 'rgba(127,147,173,.85)'; g.font = '15px Consolas, monospace';
    g.textAlign = 'right';
    g.fillText('18', 25, py(18, 4, 18) + 5);
    g.fillText('11', 25, py(11, 4, 18) + 5);
    g.fillText('4', 25, py(4, 4, 18) + 5);
    g.textAlign = 'left';
    g.fillText('120s', x0 + 2, H - 1);
    g.textAlign = 'right';
    g.fillText('now', x1 - 2, H - 1);
  }

  /* ------------------------------------------------------------ 事件流 */
  pushEvent(e) {
    const host = $('#events');
    const div = document.createElement('div');
    div.className = `evt ${e.level}`;
    div.innerHTML = `<time>${hhmmss(e.t)}</time><span class="tg">${e.tag}</span><span class="tx">${e.text}</span>`;
    host.prepend(div);
    while (host.children.length > this.maxEvents) host.lastChild.remove();
    const n = this.sim.events.filter((x) => x.level !== 'info').length;
    $('#evtCount').textContent = n ? `${n} 条未复位` : '全部正常';
  }

  /* ------------------------------------------------------------ 周期刷新 */
  update(dt) {
    const m = this.sim.metrics;
    for (const [k, el] of Object.entries(this.topEls)) {
      el.innerHTML = {
        hpRun: `${m.hpRun}<u>/8 台</u>`, flow: `${fmt(m.flow, 0)}<u>m³/h</u>`,
        q: `${fmt(m.q, 0)}<u>kW</u>`, cop: fmt(m.cop, 2), power: `${fmt(m.power, 0)}<u>kW</u>`,
      }[k];
    }
    const vals = {
      Ts: `${fmt(m.Ts, 1)}<u>℃</u>`, Tr: `${fmt(m.Tr, 1)}<u>℃</u>`, dT: `${fmt(m.dT, 1)}<u>K</u>`,
      flow: `${fmt(m.flow, 0)}<u>m³/h</u>`, power: `${fmt(m.power, 1)}<u>kW</u>`,
      q: `${fmt(m.q, 0)}<u>kW</u>`, cop: `${fmt(m.cop, 2)}<u></u>`,
      running: `${m.running}<u>台</u>`,
    };
    for (const [k, o] of Object.entries(this.kpiEls)) if (o.v) o.v.innerHTML = vals[k];
    const sub = { Ts: '设定 7.0 ℃', Tr: '回水', flow: `${m.pumpRun} 泵运行`, power: '含辅机 3.6 kW',
                  cop: `制冷量/功率`, q: `${fmt(m.load * 100, 0)} % 负荷`, dT: `Δ T`, running: `/ ${m.total} 台` };
    for (const [k, o] of Object.entries(this.kpiEls)) if (o.s) o.s.textContent = sub[k] || '';

    // 设备清单行
    for (const e of EQUIPMENT) {
      const d = this.sim.devices.get(e.id), row = this.rows.get(e.id);
      if (!row || !d) continue;
      row.querySelector('.dot').style.color = STATUS_COLORS[d.status];
      row.querySelector('.val').textContent = this._rowValue(d);
      row.classList.toggle('sel', this.selected === e.id);
    }

    // 顶栏时钟 / 系统徽标
    $('#clock').textContent = hhmmss(this.sim.clock);
    $('#date').textContent = this.sim.clock.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
    const badge = $('#sysbadge');
    const alarm = m.alarm;
    badge.className = `badge ${alarm ? 'err' : m.cop < 2.6 ? 'warn' : 'ok'}`;
    badge.innerHTML = `<span></span>${alarm ? `${alarm} 台设备故障` : m.cop < 2.6 ? '能效偏低' : '系统正常'}`;

    this.drawTrend();
  }

  setSelected(id) { this.selected = id; this.renderDetail(); }
  setLoadProgress(p) {
    $('#loadBar').style.width = `${(p * 100).toFixed(0)}%`;
    $('#loadPct').textContent = `${(p * 100).toFixed(0)} %`;
  }
}
