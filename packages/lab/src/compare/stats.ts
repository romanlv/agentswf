// The few distributions a paired comparison needs, so the package takes no statistics dependency.

export const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The sample standard deviation; 0 below two values. */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Φ, to about 1e-7 (Abramowitz and Stegun 7.1.26). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.5053203294168, 24.01409824083091, -1.231739572450155,
    1.20865097386618e-3, -5.395239384953e-6,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.00000000019002;
  for (const coefficient of c) series += coefficient / ++y;
  return -tmp + Math.log((Math.sqrt(2 * Math.PI) * series) / x);
}

/** The regularized incomplete beta function, by its continued fraction (Numerical Recipes 6.4). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  const fraction = (x: number, a: number, b: number) => {
    const tiny = 1e-30;
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    d = 1 / (Math.abs(d) < tiny ? tiny : d);
    let h = d;
    for (let m = 1; m <= 200; m++) {
      for (const numerator of [
        (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)),
        (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1)),
      ]) {
        d = 1 + numerator * d;
        d = 1 / (Math.abs(d) < tiny ? tiny : d);
        c = 1 + numerator / c;
        if (Math.abs(c) < tiny) c = tiny;
        h *= d * c;
      }
      if (Math.abs(d * c - 1) < 1e-12) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2)
    ? (front * fraction(x, a, b)) / a
    : 1 - (front * fraction(1 - x, b, a)) / b;
}

/** Student's t CDF with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  const tail = incompleteBeta(df / (df + t * t), df / 2, 0.5) / 2;
  return t >= 0 ? 1 - tail : tail;
}

/** The value below which Student's t with `df` degrees of freedom falls with probability `p`. */
export function tQuantile(p: number, df: number): number {
  let low = -1;
  let high = 1;
  while (tCdf(low, df) > p) low *= 2;
  while (tCdf(high, df) < p) high *= 2;
  for (let i = 0; i < 200 && high - low > 1e-10 * Math.max(1, Math.abs(high)); i++) {
    const middle = (low + high) / 2;
    if (tCdf(middle, df) < p) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

const bounds = new Map<string, number>();

/**
 * The O'Brien–Fleming bound for looks at information fractions `fractions` (ascending, the last 1),
 * one-sided at `alpha`: the constant `c` on the score scale, so look k claims at z ≥ c/√t_k. Found
 * by numerical integration of a Brownian motion's crossing probability over a grid, which is how
 * group-sequential software computes it (Armitage, McPherson and Rowe 1969).
 */
export function obrienFleming(fractions: readonly number[], alpha: number): number {
  if (!fractions.every((f, i) => f > (fractions[i - 1] ?? 0) && f <= 1) || fractions.at(-1) !== 1) {
    throw new Error(
      `information fractions rise within (0, 1] and end at 1: ${fractions.join(", ")}`,
    );
  }
  const key = `${fractions.join(",")}@${alpha}`;
  const known = bounds.get(key);
  if (known !== undefined) return known;
  const step = 0.02;
  const crossing = (c: number) => {
    // The density of S_k at cell midpoints below c, having not crossed at any earlier look. The
    // cells hang from c, so the crossing probability moves smoothly with it and bisection can
    // find c between grid points.
    const grid: number[] = [];
    for (let s = c - step / 2; s > -8; s -= step) grid.push(s);
    let density = grid.map((s) => normalDensity(s, fractions[0]!));
    for (let k = 1; k < fractions.length; k++) {
      const variance = fractions[k]! - fractions[k - 1]!;
      density = grid.map((y) => {
        let total = 0;
        for (let i = 0; i < grid.length; i++) {
          total += density[i]! * normalDensity(y - grid[i]!, variance);
        }
        return total * step;
      });
    }
    return 1 - density.reduce((a, b) => a + b, 0) * step;
  };
  let lowC = 0.5;
  let highC = 5;
  for (let i = 0; i < 30; i++) {
    const middle = (lowC + highC) / 2;
    if (crossing(middle) > alpha) lowC = middle;
    else highC = middle;
  }
  const c = (lowC + highC) / 2;
  bounds.set(key, c);
  return c;
}

function normalDensity(x: number, variance: number): number {
  return Math.exp((-x * x) / (2 * variance)) / Math.sqrt(2 * Math.PI * variance);
}
