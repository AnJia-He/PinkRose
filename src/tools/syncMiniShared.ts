/** Rewrite imports of shared files to same-directory paths without extensions. */
export function rewriteImports(source: string, knownNames: readonly string[]): string {
  return source.replace(
    /(from\s+['"])([^'"]+)(['"])/g,
    (whole, a: string, spec: string, c: string) => {
      const base = spec.split('/').pop() ?? ''
      if (!knownNames.includes(base)) return whole
      const noExt = base.replace(/\.ts$/, '')
      return `${a}./${noExt}${c}`
    },
  )
}
