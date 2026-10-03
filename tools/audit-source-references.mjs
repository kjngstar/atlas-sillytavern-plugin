import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const slash = value => value.replaceAll('\\', '/');
export const DEFAULT_ROOTS = [
  'index.js', 'src/atlas-browser-entry.ts', 'src/atlas-sql-browser-entry.ts',
  'src/atlas-sql-worker-entry.ts', 'src/atlas-server.ts', 'atlas-server-plugin/index.mjs',
];
const GENERATED_ENTRIES = {
  'dist/atlas-ui-core.mjs': 'src/atlas-browser-entry.ts',
  'dist/atlas-sql.mjs': 'src/atlas-sql-browser-entry.ts',
  'dist/atlas-sql-worker.js': 'src/atlas-sql-worker-entry.ts',
  'atlas-server-plugin/dist/atlas-server.mjs': 'src/atlas-server.ts',
  'atlas-server-plugin/dist/atlas-sql.mjs': 'src/atlas-sql-browser-entry.ts',
};
const PENDING = new Set([
  'src/atlas-sim-time.ts', 'src/atlas-sim-scheduler.ts', 'src/atlas-sim-propagation.ts',
  'src/atlas-sim-random.ts', 'src/atlas-sim-decision-context.ts', 'src/atlas-sim-outcome-context.ts',
]);
const IGNORED = new Set(['node_modules', 'dist', 'release', 'atlas-extension', '.git', '.tmp', '.worktrees', 'artifacts']);

/** Import graph only: root reachability is not proof that a feature runs in the host. */
export function auditSourceReferences(root, { productionRoots = DEFAULT_ROOTS, generatedEntries = GENERATED_ENTRIES } = {}) {
  root = resolve(root);
  const files = [];
  const walk = directory => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|mjs|js)$/.test(entry.name)) files.push(slash(relative(root, path)));
    }
  };
  for (const directory of ['src', 'lib', 'tools', 'tests', 'atlas-server-plugin']) walk(join(root, directory));
  for (const file of productionRoots) if (existsSync(join(root, file)) && !files.includes(file)) files.push(file);
  files.sort();
  const present = new Set(files);
  const edges = [], unknown = [], external = [];
  const targetOf = (from, specifier) => {
    if (!specifier.startsWith('.')) return null;
    const path = slash(relative(root, resolve(root, dirname(from), specifier)));
    if (generatedEntries[path]) return generatedEntries[path];
    for (const candidate of [path, `${path}.ts`, `${path}.mjs`, `${path}.js`, `${path}/index.ts`, `${path}/index.js`]) {
      if (present.has(candidate)) return candidate;
    }
    return undefined;
  };
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      extname(file) === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const add = (node, specifier, kind, typeOnly = false) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const to = targetOf(file, specifier);
      const row = { from: file, specifier, kind, typeOnly, line };
      if (to === null) external.push(row);
      else if (to === undefined) unknown.push({ ...row, reason: 'unresolved-relative-reference' });
      else edges.push({ ...row, to });
    };
    const visit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const allNamedTypes = !clause?.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
        add(node, node.moduleSpecifier.text, 'import', Boolean(clause?.isTypeOnly || allNamedTypes));
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.exportClause;
        const allNamedTypes = bindings && ts.isNamedExports(bindings) && bindings.elements.length > 0
          && bindings.elements.every(element => element.isTypeOnly);
        add(node, node.moduleSpecifier.text, 'export-from', Boolean(node.isTypeOnly || allNamedTypes));
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        add(node, node.argument.literal.text, 'import-type', true);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
        add(node, node.moduleReference.expression.text, 'import-equals', Boolean(node.isTypeOnly));
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const arg = node.arguments[0];
        const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require';
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) add(node, arg.text, kind);
        else unknown.push({ from: file, kind, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          reason: 'computed-reference', expression: arg?.getText(source).slice(0, 120) ?? '' });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const reference of source.referencedFiles) add(source, reference.fileName.startsWith('.') ? reference.fileName : `./${reference.fileName}`, 'reference-path', true);
  }
  const traverse = (starts, includeTypes) => {
    const result = new Set(starts.filter(file => present.has(file)));
    const queue = [...result];
    while (queue.length) {
      const file = queue.shift();
      for (const edge of edges) if (edge.from === file && (includeTypes || !edge.typeOnly) && !result.has(edge.to)) {
        result.add(edge.to); queue.push(edge.to);
      }
    }
    return result;
  };
  const production = traverse(productionRoots, false);
  const productionWithTypes = traverse(productionRoots, true);
  const tests = traverse(files.filter(file => file.startsWith('tests/')), true);
  const experiments = traverse(files.filter(file => file.startsWith('tools/map-lab/')), true);
  const modules = files.filter(file => file.startsWith('src/') || file.startsWith('lib/')).map(file => {
    const incoming = edges.filter(edge => edge.to === file).map(edge => ({ ...edge,
      sourceUses: [production.has(edge.from) ? 'production' : null,
        productionWithTypes.has(edge.from) && !production.has(edge.from) ? 'production-type' : null,
        tests.has(edge.from) ? 'test' : null, experiments.has(edge.from) ? 'experiment' : null].filter(Boolean) }));
    const uses = [production.has(file) ? 'production' : null,
      productionWithTypes.has(file) && !production.has(file) ? 'production-type' : null,
      tests.has(file) ? 'test' : null, experiments.has(file) ? 'experiment' : null].filter(Boolean);
    return { file, uses, pendingProductionHook: PENDING.has(file), incoming,
      status: uses.length ? 'referenced' : PENDING.has(file) ? 'pending-hook' : 'unreferenced-candidate' };
  });
  return { tool: 'atlas-source-reference-audit', productionRoots, generatedEntries,
    note: 'Static reachability is not host execution proof. Computed references are unknown; never automatically delete candidates.',
    modules, unknown, external };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--root');
  const root = index >= 0 ? process.argv[index + 1] : dirname(dirname(fileURLToPath(import.meta.url)));
  if (!root) throw new Error('--root requires a directory');
  process.stdout.write(`${JSON.stringify(auditSourceReferences(root), null, 2)}\n`);
}
