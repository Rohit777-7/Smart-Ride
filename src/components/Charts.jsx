import { useEffect, useRef, useState } from 'react';
import { gsap, reducedMotion, useGSAP } from '../lib/motion.jsx';

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

const compact = (n) =>
  n >= 100000 ? `${(n / 100000).toFixed(1)}L` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n));

const PAD = { top: 12, right: 8, bottom: 26, left: 40 };

/** Vertical bars — one series. Rounded 4px data-end, square baseline, hover tooltip. */
export function BarChart({ data, height = 220, color = 'var(--v-bike)', format = String, label = 'Value', labelEvery = 1, yFormat = compact }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const dataKey = data.map((d) => d.value).join(',');
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(ref.current.querySelectorAll('path.bar'), { scaleY: 0, transformOrigin: '50% 100%', stagger: 0.025, duration: 0.9, ease: 'expo.out' });
    },
    { dependencies: [dataKey], scope: ref },
  );
  const max = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const slot = iw / Math.max(1, data.length);
  // Show as many x labels as fit (~52px each), never fewer than every labelEvery-th.
  const labelStep = Math.max(labelEvery, Math.ceil(data.length / Math.max(1, Math.floor(iw / 52))));
  const gap = Math.max(2, slot * 0.28);
  const bw = Math.max(2, slot - gap);
  const y = (v) => PAD.top + ih - (v / top) * ih;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={`${label} bar chart`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis-text" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">{yFormat(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * slot + gap / 2;
          const h = Math.max(0, (d.value / top) * ih);
          const r = Math.min(4, bw / 2, h);
          const yb = PAD.top + ih;
          const path = h > 0
            ? `M${x},${yb} V${yb - h + r} Q${x},${yb - h} ${x + r},${yb - h} H${x + bw - r} Q${x + bw},${yb - h} ${x + bw},${yb - h + r} V${yb} Z`
            : '';
          return (
            <g key={d.label + i}>
              {path && <path className="bar" d={path} fill={color} opacity={hover == null || hover === i ? 1 : 0.55} />}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={ih}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onTouchStart={() => setHover(i)}
              />
              {i % labelStep === 0 && (
                <text className="axis-text" x={x + bw / 2} y={height - 8} textAnchor="middle">{d.short ?? d.label}</text>
              )}
            </g>
          );
        })}
        <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih} />
      </svg>
      {hover != null && data[hover] && (
        <div className="chart-tip" style={{ left: PAD.left + hover * slot + slot / 2, top: y(data[hover].value) }}>
          <div className="muted">{data[hover].label}</div>
          <b>{format(data[hover].value)}</b>
          {data[hover].sub && <div className="muted">{data[hover].sub}</div>}
        </div>
      )}
    </div>
  );
}

/** Line + soft area — one series, crosshair tooltip. */
export function LineChart({ data, height = 220, color = '#3987e5', format = String, label = 'Value', labelEvery = 5, yFormat = compact }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const dataKey = data.map((d) => d.value).join(',');
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(ref.current.querySelector('.lc-line'), { drawSVG: '0%', duration: 1.6, ease: 'power2.inOut' });
      gsap.from(ref.current.querySelector('.lc-area'), { autoAlpha: 0, duration: 1.2, delay: 0.6 });
    },
    { dependencies: [dataKey], scope: ref },
  );
  const max = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v) => PAD.top + ih - (v / top) * ih;
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.value)}`).join(' ');
  const area = data.length ? `${line} L${x(data.length - 1)},${PAD.top + ih} L${x(0)},${PAD.top + ih} Z` : '';
  const gid = `lg-${label.replace(/\W/g, '')}`;

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
    const i = Math.round(((px - PAD.left) / iw) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  }

  return (
    <div className="chart" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${label} line chart`}
        onMouseMove={onMove}
        onTouchMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis-text" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">{yFormat(t)}</text>
          </g>
        ))}
        <path className="lc-area" d={area} fill={`url(#${gid})`} />
        <path className="lc-line" d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) =>
          (i % labelEvery === 0 && data.length - 1 - i >= labelEvery / 2) || i === data.length - 1 ? (
            <text key={i} className="axis-text" x={x(i)} y={height - 8} textAnchor="middle">{d.short ?? d.label}</text>
          ) : null,
        )}
        <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih} />
        {hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="rgba(148,163,184,.45)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(data[hover].value)} r="5" fill={color} stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover != null && data[hover] && (
        <div className="chart-tip" style={{ left: x(hover), top: y(data[hover].value) }}>
          <div className="muted">{data[hover].label}</div>
          <b>{format(data[hover].value)}</b>
          {data[hover].sub && <div className="muted">{data[hover].sub}</div>}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for a handful of named categories (direct-labelled, so no legend needed). */
export function HBarList({ rows, format = String }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const ref = useRef(null);
  const rowsKey = rows.map((r) => r.value).join(',');
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(ref.current.querySelectorAll('.hbar-fill'), { scaleX: 0, stagger: 0.08, duration: 1.1, ease: 'expo.out' });
    },
    { dependencies: [rowsKey], scope: ref },
  );
  return (
    <div className="col gap-8" ref={ref}>
      {rows.map((r) => (
        <div className="hbar" key={r.label} title={`${r.label}: ${format(r.value)}`}>
          <span className="row gap-8 small">
            {r.color && <span className="dot" style={{ background: r.color }} />}
            {r.label}
          </span>
          <div className="hbar-track" style={{ borderLeft: '1px solid rgba(148,163,184,.35)' }}>
            <div className="hbar-fill" style={{ width: `${(r.value / max) * 100}%`, background: r.color || 'var(--v-bike)' }} />
          </div>
          <span className="small num mono" style={{ textAlign: 'right' }}>{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Tiny trend line for KPI cards (no axes; the card states the number). */
export function Sparkline({ values, color = '#3d8eff', height = 38 }) {
  const ref = useRef(null);
  const w = 120;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const x = (i) => (values.length <= 1 ? w / 2 : (i / (values.length - 1)) * w);
  const y = (v) => height - 3 - ((v - min) / (max - min || 1)) * (height - 8);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = values.length ? `${line} L${w},${height} L0,${height} Z` : '';
  const gid = `sp${color.replace(/[^a-z0-9]/gi, '')}`;
  const key = values.join(',');
  useGSAP(
    () => {
      if (reducedMotion() || !values.length) return;
      gsap.from(ref.current.querySelector('.sp-line'), { drawSVG: '0%', duration: 1.4, ease: 'power2.inOut' });
      gsap.from(ref.current.querySelector('.sp-area'), { autoAlpha: 0, duration: 1, delay: 0.5 });
    },
    { dependencies: [key], scope: ref },
  );
  if (!values.length) return null;
  return (
    <svg ref={ref} className="sparkline" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.32" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="sp-area" d={area} fill={`url(#${gid})`} />
      <path className="sp-line" d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Donut for part-to-whole of a few categories, with a hover readout in the centre. */
export function Donut({ rows, format = String, size = 190, thickness = 22, centerLabel = 'Total' }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  const GAP = rows.length > 1 ? 3 : 0; // surface gap between segments
  const segs = rows.reduce((list, row) => {
    const start = list.length ? list[list.length - 1].end : 0;
    const len = (row.value / total) * C;
    return [...list, { ...row, len: Math.max(0, len - GAP), offset: -start, end: start + len }];
  }, []);
  const key = rows.map((x) => x.value).join(',');
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(ref.current.querySelector('.donut-ring'), { rotation: -120, transformOrigin: '50% 50%', autoAlpha: 0, duration: 1.2, ease: 'expo.out' });
    },
    { dependencies: [key], scope: ref },
  );
  const active = hover != null ? rows[hover] : null;
  return (
    <div className="donut" ref={ref} style={{ width: size, height: size }} onMouseLeave={() => setHover(null)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${centerLabel} by category`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.05)" strokeWidth={thickness} />
        <g className="donut-ring" transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {segs.map((s, i) => (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={hover === i ? thickness + 6 : thickness}
              strokeDasharray={`${s.len} ${C}`}
              strokeDashoffset={s.offset}
              opacity={hover == null || hover === i ? 1 : 0.35}
              style={{ transition: 'stroke-width .25s, opacity .25s', cursor: 'pointer' }}
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </g>
      </svg>
      <div className="donut-center">
        <span className="tiny muted">{active ? active.label : centerLabel}</span>
        <b>{format(active ? active.value : total)}</b>
        {active && <span className="tiny muted">{Math.round((active.value / total) * 100)}%</span>}
      </div>
    </div>
  );
}

/** One 100% stacked bar with a direct-labelled legend below (share of a whole). */
export function StackBar({ rows, format = String, ariaLabel = 'Share by payment method' }) {
  const ref = useRef(null);
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  const key = rows.map((x) => x.value).join(',');
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(ref.current.querySelectorAll('.stackbar-seg'), { scaleX: 0, transformOrigin: '0% 50%', stagger: 0.12, duration: 0.9, ease: 'expo.out' });
    },
    { dependencies: [key], scope: ref },
  );
  return (
    <div ref={ref} className="col gap-12">
      <div className="stackbar" role="img" aria-label={ariaLabel}>
        {rows.map((r) => (
          <div key={r.label} className="stackbar-seg" title={`${r.label}: ${format(r.value)}`} style={{ width: `${(r.value / total) * 100}%`, background: r.color }} />
        ))}
      </div>
      <div className="stackbar-legend">
        {rows.map((r) => (
          <div key={r.label}>
            <span className="row gap-8 small"><span className="dot" style={{ background: r.color }} />{r.label}</span>
            <b className="mono">{format(r.value)}</b>
            <span className="tiny muted">{Math.round((r.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
