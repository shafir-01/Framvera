import { clock } from '../lib/format.ts';
import { packRows, unitsOf, type Bar, type Lane, type Model, type Unit } from './model.ts';

export const ROW = 58;
export const BAR_H = 34;
export const BAND_H = 48;
export const LANE_PAD = 8;
export const LANE_GAP = 10;
export const AXIS_H = 44;
export const HEADER_H = 28;
export const LABEL_W = 176;
export const PAD_X = 16;
export const MOBILE_MIN_PLOT = 760;
export const MOBILE_BREAKPOINT = 640;

export interface Placed {
  bar: Bar;
  top: number;
  mid: number;
}

export interface UnitGeo {
  unit: Unit;
  row: number;
  top: number;
  height: number;
}

export interface LaneGeo {
  lane: Lane;
  top: number;
  height: number;
  headerH: number;
  units: UnitGeo[];
}

export interface Tick {
  t: number;
  x: number;
  hour: number;
  midnight: boolean;
}

export interface Geo {
  width: number;
  height: number;
  mobile: boolean;
  plotLeft: number;
  plotRight: number;
  lanes: LaneGeo[];
  place: Map<string, Placed>;
  ticks: Tick[];
  x: (t: number) => number;
  invX: (x: number) => number;
}

const HOUR = 3_600_000;

function ticksFor(t0: number, t1: number, x: (t: number) => number, plotW: number): Tick[] {
  const spanH = (t1 - t0) / HOUR;
  const step = [1, 2, 3, 6, 12, 24].find((s) => plotW / (spanH / s) >= 58) ?? 24;
  const out: Tick[] = [];
  for (let t = Math.ceil(t0 / HOUR) * HOUR; t <= t1; t += HOUR) {
    const hour = Number(clock(new Date(t).toISOString()).slice(0, 2));
    if (hour % step === 0) out.push({ t, x: x(t), hour, midnight: hour === 0 });
  }
  return out;
}

export function computeGeo(model: Model, containerW: number): Geo {
  const mobile = containerW < MOBILE_BREAKPOINT;
  const width = mobile ? Math.max(containerW, MOBILE_MIN_PLOT) : Math.max(containerW, 480);
  const plotLeft = mobile ? PAD_X : LABEL_W;
  const plotRight = width - PAD_X;
  const plotW = plotRight - plotLeft;
  const span = model.t1 - model.t0;
  const x = (t: number) => plotLeft + ((t - model.t0) / span) * plotW;
  const invX = (px: number) => model.t0 + ((px - plotLeft) / plotW) * span;
  const gapMs = (10 / plotW) * span;

  const headerH = mobile ? HEADER_H : 0;
  const place = new Map<string, Placed>();
  const lanes: LaneGeo[] = [];
  let cursor = AXIS_H;
  for (const lane of model.lanes) {
    const units = unitsOf(lane);
    const { rows, count } = packRows(units, gapMs);
    const height = headerH + LANE_PAD * 2 + count * ROW;
    const geos: UnitGeo[] = units.map((unit, i) => {
      const row = rows[i]!;
      const top = cursor + headerH + LANE_PAD + row * ROW;
      unit.bars.forEach((bar, k) => {
        const barTop = top + k * ROW + (ROW - BAR_H) / 2;
        place.set(bar.key, { bar, top: barTop, mid: barTop + BAR_H / 2 });
      });
      return { unit, row, top, height: unit.bars.length * ROW };
    });
    lanes.push({ lane, top: cursor, height, headerH, units: geos });
    cursor += height + LANE_GAP;
  }
  return { width, height: cursor + 28, mobile, plotLeft, plotRight, lanes, place, ticks: ticksFor(model.t0, model.t1, x, plotW), x, invX };
}
