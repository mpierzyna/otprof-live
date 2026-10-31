// Number formats: very small and very large magnitudes in scientific notation with superscript exponents (2.5×10⁻¹⁵),
// for variables shown linearly that are stored as log₁₀ (Cₙ²).

import { format, type FormatLocaleObject } from "d3-format";
import type { NumberValue } from "d3-scale";

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const needsSci = (m: number) => m !== 0 && (m < 1e-3 || m >= 1e5);

/** `v` as e.g. 2.5×10⁻¹⁵ (10⁻¹⁵ for a mantissa of 1), with up to `digits` significant digits. */
export function sci(v: number, digits = 3): string {
  const [m, e] = format(`.${digits - 1}~e`)(v).split("e");
  const exp = String(+e).replace(/\d/g, (d) => SUP[+d]).replace("-", "⁻");
  return `${m === "1" ? "" : `${m.replace("-", "−")}×`}10${exp}`;
}

/** Values: scientific notation below 10⁻³ and from 10⁵ on, else the d3-format `spec`; "–" for NaN. */
export function numberFormat(spec: string): (v: number) => string {
  const f: ReturnType<FormatLocaleObject["format"]> = format(spec);
  return (v) => (Number.isNaN(v) ? "–" : needsSci(Math.abs(v)) ? sci(v) : f(v).replace("-", "−"));
}

/** Tick labels of a linear scale: d3's, or scientific notation if its domain is very small or large. */
export function tickFormat(
  scale: { domain(): number[]; tickFormat(count?: number): (d: NumberValue) => string },
  count: number,
): (d: NumberValue) => string {
  if (!needsSci(Math.max(...scale.domain().map(Math.abs)))) return scale.tickFormat(count);
  return (d) => (+d === 0 ? "0" : sci(+d, 2));
}
