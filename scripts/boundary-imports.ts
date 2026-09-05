export function extractImports(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [
    /(?:from|import)\s*["']([^"']+)["']/g,
    /(?:import|require)\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2] ?? match[1];
      if (specifier) found.add(specifier);
    }
  }
  return [...found];
}

export function hasUnresolvedDynamicImport(source: string): boolean {
  for (const match of source.matchAll(/(?:import|require)\s*\(\s*([^)]*)\)/g)) {
    const argument = match[1]?.trim() ?? "";
    if (!/^(["'`])[^"'`]*\1$/.test(argument)) return true;
    if (argument.startsWith("`") && argument.includes("${")) return true;
  }
  return false;
}
