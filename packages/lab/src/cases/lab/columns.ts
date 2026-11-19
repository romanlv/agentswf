import { type Column, PARAM_NAME, type Params, type RunRecord } from "../format/records";
import { Refusal } from "./refusal";

/** `--param` and `--vary`, read: the values every column shares, and each varied name's values. */
export type ParamPlan = { fixed: Params; varied: [name: string, values: string[]][] };

/** Reads `--param {name}={value}` and `--vary {name}={a,b}`, each repeatable. */
export function readParams(param: readonly string[], vary: readonly string[]): ParamPlan {
  const fixed: Params = {};
  const varied: [string, string[]][] = [];
  const seen = new Set<string>();
  const split = (flag: string, given: string) => {
    const at = given.indexOf("=");
    const name = at > 0 ? given.slice(0, at) : "";
    const value = at > 0 ? given.slice(at + 1) : "";
    if (!PARAM_NAME.test(name) || value === "") {
      throw new Refusal(
        `${flag} ${given}: give {name}=${flag === "--vary" ? "{a,b}" : "{value}"}, the name a letter then letters, digits, - or _`,
      );
    }
    if (seen.has(name)) throw new Refusal(`${flag} ${given}: ${name} is given twice`);
    seen.add(name);
    return { name, value };
  };
  for (const given of param) {
    const { name, value } = split("--param", given);
    fixed[name] = value;
  }
  for (const given of vary) {
    const { name, value } = split("--vary", given);
    const values = value.split(",").map((v) => v.trim());
    if (values.some((v) => v === "") || new Set(values).size !== values.length) {
      throw new Refusal(`--vary ${given}: each value once, none empty`);
    }
    if (values.length < 2) {
      throw new Refusal(
        `--vary ${given}: give two values or more; one is --param ${name}=${value}`,
      );
    }
    varied.push([name, values]);
  }
  return { fixed, varied };
}

/** Every combination of the varied values, the first `--vary` outermost, each with the fixed. */
export function combinations({ fixed, varied }: ParamPlan): Params[] {
  let combos: Params[] = [{ ...fixed }];
  for (const [name, values] of varied) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value })));
  }
  return combos;
}

/**
 * The run's columns: each folder under each combination, the folders outermost, so the first is
 * the reference column, your checkout under each `--vary`'s first value.
 */
export function columnsOf(folders: number, combos: readonly Params[]): Column[] {
  return Array.from({ length: folders }, (_, folder) =>
    combos.map((params) => ({ folder, params })),
  ).flat();
}

function sameParams(a: Params, b: Params): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** The column of a run with this folder and these parameters, if it has one. */
export function columnLike(run: RunRecord, path: string, params: Params): number | undefined {
  const at = run.columns.findIndex(
    (c) => run.folders[c.folder]?.path === path && sameParams(c.params, params),
  );
  return at < 0 ? undefined : at;
}

/** The parameters whose value differs between the run's columns, in the order first given. */
function varyingNames(run: RunRecord): string[] {
  const names = [...new Set(run.columns.flatMap((c) => Object.keys(c.params)))];
  return names.filter((name) => new Set(run.columns.map((c) => c.params[name])).size > 1);
}

/**
 * A column's name in the report: `against {n}` for another folder, then each parameter that
 * differs between columns, such as `model=b`; your checkout alone is "this checkout".
 */
export function columnLabel(run: RunRecord, index: number): string {
  const column = run.columns[index];
  if (!column) return `column ${index}`;
  const params = varyingNames(run).map((name) => `${name}=${column.params[name] ?? "-"}`);
  const parts = [...(column.folder > 0 ? [`against ${column.folder}`] : []), ...params];
  return parts.length > 0 ? parts.join(" ") : "this checkout";
}

/** The parameters every column shares, as `name=value`, for the report's head. */
export function sharedParams(run: RunRecord): string[] {
  const varying = new Set(varyingNames(run));
  return Object.entries(run.columns[0]?.params ?? {})
    .filter(([name]) => !varying.has(name))
    .map(([name, value]) => `${name}=${value}`);
}
