/**
 * Static codebase scanner for CLAUDE.md generation.
 *
 * Mirrors `skills/claude-md/scanner.py` 1:1 — all detection is deterministic,
 * no LLM calls. The output shape is identical to the Python scanner (same
 * field names, same JSON structure) so existing tests + goldens compare
 * byte-for-byte against the reference Python output.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Output types — kebab_case fields to match Python dict keys
// ---------------------------------------------------------------------------

export interface ProjectIdentity {
  name: string;
}

export interface TechStack {
  languages: string[];
  frameworks: string[];
  build_systems: string[];
}

export interface Conventions {
  naming: string;
  test_patterns: string[];
  primary_extensions: string[];
}

export interface ValidatorSummary {
  name: string;
  command: string;
  phase: string;
}

export interface ReferenceEntry {
  path: string;
  label: string;
}

export interface ToolDirective {
  name: string;
  directive: string;
}

export interface ProveConfigSummary {
  exists: boolean;
  validators: ValidatorSummary[];
  has_index: boolean;
  references: ReferenceEntry[];
  tool_directives: ToolDirective[];
}

export interface CafiSummary {
  available: boolean;
  file_count: number;
}

export interface CoreCommand {
  name: string;
  summary: string;
}

export interface ScanResult {
  project: ProjectIdentity;
  tech_stack: TechStack;
  key_dirs: Record<string, string>;
  conventions: Conventions;
  prove_config: ProveConfigSummary;
  cafi: CafiSummary;
  core_commands: CoreCommand[];
  plugin_version: string;
  plugin_dir: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run all scanners and return structured results.
 *
 * @param projectRoot Absolute path to the target project root.
 * @param pluginDir Absolute path to the prove plugin directory. If `undefined`,
 *   defaults to the plugin root derived from this file's compile-time location
 *   (packages/cli/src/topics/claude-md -> 4 levels up). The caller is expected
 *   to pass an explicit value in production; this default is test-only.
 */
export function scanProject(projectRoot: string, pluginDir?: string): ScanResult {
  const resolvedPlugin = pluginDir ?? defaultPluginDir();
  return {
    project: scanProjectIdentity(projectRoot),
    tech_stack: scanTechStack(projectRoot),
    key_dirs: scanKeyDirs(projectRoot),
    conventions: scanConventions(projectRoot),
    prove_config: scanProveConfig(projectRoot, resolvedPlugin),
    cafi: scanCafi(projectRoot),
    core_commands: scanCoreCommands(resolvedPlugin),
    plugin_version: scanPluginVersion(resolvedPlugin),
    plugin_dir: resolvedPlugin,
  };
}

function defaultPluginDir(): string {
  // Fallback used only when the caller omits plugin_dir (primarily tests).
  // Mirrors Python scanner.py: Path(__file__).resolve().parent.parent.parent
  return resolve(__dirname, '..', '..', '..');
}

// ---------------------------------------------------------------------------
// Project identity
// ---------------------------------------------------------------------------

export function scanProjectIdentity(root: string): ProjectIdentity {
  let name = basename(resolve(root));

  for (const configFile of ['package.json', 'Cargo.toml', 'pyproject.toml']) {
    const configPath = join(root, configFile);
    if (!isFile(configPath)) continue;

    try {
      if (configFile === 'package.json') {
        const data = JSON.parse(readFileSync(configPath, 'utf8'));
        const pkgName = typeof data?.name === 'string' ? data.name : '';
        if (pkgName) {
          name = pkgName;
          break;
        }
      } else {
        // Cargo.toml + pyproject.toml both use `name = "..."`.
        const content = readFileSync(configPath, 'utf8');
        const match = /name\s*=\s*"([^"]+)"/.exec(content);
        if (match?.[1]) {
          name = match[1];
          break;
        }
      }
    } catch {
      // Fall through to the next config file / the dirname fallback.
    }
  }

  return { name };
}

// ---------------------------------------------------------------------------
// Tech stack
// ---------------------------------------------------------------------------

interface TechCheck {
  filename: string;
  lang: string | null;
  framework: string | null;
  buildSystem: string | null;
}

const TECH_CHECKS: TechCheck[] = [
  { filename: 'go.mod', lang: 'Go', framework: null, buildSystem: 'go' },
  { filename: 'Cargo.toml', lang: 'Rust', framework: null, buildSystem: 'cargo' },
  { filename: 'package.json', lang: 'JavaScript/TypeScript', framework: null, buildSystem: 'npm' },
  { filename: 'pyproject.toml', lang: 'Python', framework: null, buildSystem: 'pip' },
  { filename: 'setup.py', lang: 'Python', framework: null, buildSystem: 'pip' },
  { filename: 'requirements.txt', lang: 'Python', framework: null, buildSystem: 'pip' },
  { filename: 'Gemfile', lang: 'Ruby', framework: null, buildSystem: 'bundler' },
  { filename: 'project.godot', lang: 'GDScript', framework: 'Godot', buildSystem: null },
  { filename: 'Makefile', lang: null, framework: null, buildSystem: 'make' },
  { filename: 'CMakeLists.txt', lang: 'C/C++', framework: null, buildSystem: 'cmake' },
  { filename: 'pom.xml', lang: 'Java', framework: null, buildSystem: 'maven' },
  { filename: 'build.gradle', lang: 'Java/Kotlin', framework: null, buildSystem: 'gradle' },
];

const NODE_FRAMEWORK_MAP: Record<string, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  svelte: 'Svelte',
  express: 'Express',
  fastify: 'Fastify',
};

export function scanTechStack(root: string): TechStack {
  const languages: string[] = [];
  const frameworks: string[] = [];
  const buildSystems: string[] = [];

  for (const check of TECH_CHECKS) {
    if (!isFile(join(root, check.filename))) continue;
    if (check.lang && !languages.includes(check.lang)) languages.push(check.lang);
    if (check.framework && !frameworks.includes(check.framework)) frameworks.push(check.framework);
    if (check.buildSystem && !buildSystems.includes(check.buildSystem)) {
      buildSystems.push(check.buildSystem);
    }
  }

  // Detect TypeScript specifically.
  if (isFile(join(root, 'tsconfig.json')) && !languages.includes('JavaScript/TypeScript')) {
    languages.push('JavaScript/TypeScript');
  }

  // Node frameworks from package.json deps.
  const pkgPath = join(root, 'package.json');
  if (isFile(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = {
        ...(pkg?.dependencies ?? {}),
        ...(pkg?.devDependencies ?? {}),
      } as Record<string, unknown>;
      for (const [dep, fwName] of Object.entries(NODE_FRAMEWORK_MAP)) {
        if (dep in deps && !frameworks.includes(fwName)) {
          frameworks.push(fwName);
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }

  return { languages, frameworks, build_systems: buildSystems };
}

// ---------------------------------------------------------------------------
// Key dirs
// ---------------------------------------------------------------------------

const DIR_HINTS: Record<string, string> = {
  src: 'Source code',
  lib: 'Library code',
  pkg: 'Go packages',
  cmd: 'Go CLI entry points',
  internal: 'Internal packages',
  app: 'Application code',
  pages: 'Page routes',
  components: 'UI components',
  api: 'API endpoints',
  routes: 'Route handlers',
  models: 'Data models',
  services: 'Service layer',
  utils: 'Utility functions',
  helpers: 'Helper functions',
  tests: 'Test files',
  test: 'Test files',
  spec: 'Test specifications',
  __tests__: 'Test files',
  scripts: 'Build/utility scripts',
  docs: 'Documentation',
  config: 'Configuration files',
  migrations: 'Database migrations',
  tools: 'Development tools',
  skills: 'Plugin skills',
  agents: 'Agent definitions',
  commands: 'Slash commands',
};

export function scanKeyDirs(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }

  for (const entry of [...entries].sort()) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    if (!isDir(full)) continue;
    const hint = DIR_HINTS[entry];
    if (hint !== undefined) {
      found[entry] = hint;
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  'target',
  'build',
  'dist',
]);

// Source extensions used for naming-convention sampling (matches Python scanner.py).
const SOURCE_EXT_SET = new Set([
  '.py',
  '.go',
  '.rs',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.rb',
  '.java',
  '.kt',
]);

// Extensions used for test-pattern detection (tighter set than SOURCE_EXT_SET,
// matches Python's inner `if ext in (...)` check in _scan_conventions).
const TEST_PATTERN_EXT_SET = new Set(['.py', '.go', '.rs', '.js', '.ts', '.tsx', '.jsx']);

const PRIMARY_EXT_SET = new Set([
  '.py',
  '.go',
  '.rs',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.rb',
  '.java',
  '.kt',
  '.gd',
]);

export function scanConventions(root: string): Conventions {
  const extCounts = new Map<string, number>();
  const sampleNames: string[] = [];
  const testPatterns: string[] = [];

  walkProject(root, (dirpath, filename) => {
    const ext = extname(filename);
    if (ext) {
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }

    if (SOURCE_EXT_SET.has(ext)) {
      sampleNames.push(filename);
    }

    const lower = filename.toLowerCase();
    if (lower.includes('test') || lower.includes('spec')) {
      if (TEST_PATTERN_EXT_SET.has(ext)) {
        if (filename.startsWith('test_')) {
          testPatterns.push('test_*.ext (prefix)');
        } else if (filename.endsWith(`_test${ext}`)) {
          testPatterns.push('*_test.ext (suffix)');
        } else if (filename.endsWith(`.test${ext}`)) {
          testPatterns.push('*.test.ext (dot)');
        } else if (filename.endsWith(`.spec${ext}`)) {
          testPatterns.push('*.spec.ext (dot)');
        }
      }
    }
    // Suppress unused-var warning for dirpath (walkProject passes it for callers that need it).
    void dirpath;
  });

  const naming = detectNaming(sampleNames);

  // Deduplicate preserving insertion order, cap at 3.
  const uniqueTest = Array.from(new Set(testPatterns)).slice(0, 3);

  // most_common(5), keep only primary extensions, preserve ordering.
  const sortedExts = [...extCounts.entries()].sort(([aExt, aCount], [bExt, bCount]) => {
    if (bCount !== aCount) return bCount - aCount;
    // Python Counter.most_common ties: keeps insertion order; ours uses Map insertion order too.
    return 0;
  });
  const primaryExtensions = sortedExts
    .slice(0, 5)
    .map(([ext]) => ext)
    .filter((ext) => PRIMARY_EXT_SET.has(ext));

  return {
    naming,
    test_patterns: uniqueTest,
    primary_extensions: primaryExtensions,
  };
}

/**
 * Walk the project tree recursively, top-down, skipping hidden/vendor/build
 * dirs and capping descent at depth 3 (mirrors Python `os.walk` + the inner
 * depth guard in `_scan_conventions`).
 *
 * Entries are sorted so traversal order is stable across platforms — this
 * keeps the Counter / list insertion order deterministic, which matters for
 * the `primary_extensions` tie-breaking and test-pattern dedup.
 */
function walkProject(root: string, visit: (dirpath: string, filename: string) => void): void {
  function visitDir(dirpath: string, depth: number): void {
    let entries: string[];
    try {
      entries = readdirSync(dirpath);
    } catch {
      return;
    }

    const files: string[] = [];
    const subdirs: string[] = [];
    for (const entry of [...entries].sort()) {
      const full = join(dirpath, entry);
      let isDirEntry = false;
      let isFileEntry = false;
      try {
        const st = statSync(full);
        isDirEntry = st.isDirectory();
        isFileEntry = st.isFile();
      } catch {
        continue;
      }
      if (isDirEntry) {
        subdirs.push(entry);
      } else if (isFileEntry) {
        files.push(entry);
      }
    }

    for (const fn of files) {
      if (fn.startsWith('.')) continue;
      // Skip tsc incremental-build artifacts. They're not source code and
      // their presence depends on whether the developer has run `tsc --build`
      // locally — counting them would make `primary_extensions` vary between
      // fresh-checkout CI and post-build local state.
      if (fn.endsWith('.tsbuildinfo')) continue;
      visit(dirpath, fn);
    }

    if (depth > 3) return;

    for (const sub of subdirs) {
      if (sub.startsWith('.')) continue;
      if (SKIP_DIRS.has(sub)) continue;
      visitDir(join(dirpath, sub), depth + 1);
    }
  }

  visitDir(root, 0);
}

export function detectNaming(filenames: string[]): string {
  if (filenames.length === 0) return 'unknown';

  let snake = 0;
  let kebab = 0;
  let camel = 0;
  let pascal = 0;

  for (const fn of filenames) {
    const name = stripExt(fn);
    if (name.length === 0) continue;
    const firstCh = name[0] ?? '';
    const isLower = name === name.toLowerCase();
    const hasUnderscore = name.includes('_');
    const hasDash = name.includes('-');
    const restUpper = [...name.slice(1)].some(isAsciiUpper);
    const firstLower = isAsciiLower(firstCh);
    const firstUpper = isAsciiUpper(firstCh);

    if (hasUnderscore && isLower) {
      snake++;
    } else if (hasDash && isLower) {
      kebab++;
    } else if (firstLower && restUpper) {
      camel++;
    } else if (firstUpper && restUpper) {
      pascal++;
    }
  }

  // Match Python `max(counts, key=counts.get)` — first key on ties (insertion order).
  const entries: ReadonlyArray<readonly [string, number]> = [
    ['snake_case', snake],
    ['kebab-case', kebab],
    ['camelCase', camel],
    ['PascalCase', pascal],
  ];
  let winner = 'snake_case';
  let winnerCount = snake;
  for (let i = 1; i < entries.length; i++) {
    const pair = entries[i];
    if (!pair) continue;
    if (pair[1] > winnerCount) {
      winner = pair[0];
      winnerCount = pair[1];
    }
  }
  if (winnerCount === 0) return 'unknown';
  return winner;
}

function stripExt(filename: string): string {
  const ext = extname(filename);
  return ext.length > 0 ? filename.slice(0, -ext.length) : filename;
}

function isAsciiUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

function isAsciiLower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}

// ---------------------------------------------------------------------------
// .claude/.prove.json
// ---------------------------------------------------------------------------

const EMPTY_PROVE_CONFIG: ProveConfigSummary = {
  exists: false,
  validators: [],
  has_index: false,
  references: [],
  tool_directives: [],
};

export function scanProveConfig(root: string, pluginDir: string | undefined): ProveConfigSummary {
  const configPath = join(root, '.claude', '.prove.json');
  if (!isFile(configPath)) {
    return { ...EMPTY_PROVE_CONFIG };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { ...EMPTY_PROVE_CONFIG };
  }

  const validators = Array.isArray(data.validators) ? (data.validators as unknown[]) : [];
  const claudeMd = (data.claude_md ?? {}) as Record<string, unknown>;
  const references = Array.isArray(claudeMd.references) ? (claudeMd.references as unknown[]) : [];

  const toolsSection = (data.tools ?? {}) as Record<string, unknown>;
  const toolDirectives = scanToolDirectives(toolsSection, pluginDir);

  return {
    exists: true,
    validators: validators.map((v) => {
      const vv = (v ?? {}) as Record<string, unknown>;
      return {
        name: typeof vv.name === 'string' ? vv.name : '',
        command: typeof vv.command === 'string' ? vv.command : '',
        phase: typeof vv.phase === 'string' ? vv.phase : '',
      };
    }),
    has_index: 'index' in data,
    references: references
      .map((r) => {
        const rr = (r ?? {}) as Record<string, unknown>;
        return {
          path: typeof rr.path === 'string' ? rr.path : '',
          label: typeof rr.label === 'string' ? rr.label : '',
        };
      })
      .filter((r) => r.path.length > 0),
    tool_directives: toolDirectives,
  };
}

/**
 * Collect directives from enabled tools by reading their tool.json manifests.
 * Entries are sorted by tool name to match Python's `sorted(tools_section.items())`.
 */
function scanToolDirectives(
  toolsSection: Record<string, unknown>,
  pluginDir: string | undefined,
): ToolDirective[] {
  if (!pluginDir) return [];

  const directives: ToolDirective[] = [];
  const toolsDir = join(pluginDir, 'tools');

  const names = Object.keys(toolsSection).sort();
  for (const name of names) {
    const entry = toolsSection[name];
    if (!isObject(entry) || entry.enabled !== true) continue;

    const manifestPath = join(toolsDir, name, 'tool.json');
    if (!isFile(manifestPath)) continue;

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }

    const directive = typeof manifest.directive === 'string' ? manifest.directive : '';
    if (directive) {
      directives.push({ name, directive });
    }
  }

  return directives;
}

// ---------------------------------------------------------------------------
// Plugin version + core commands
// ---------------------------------------------------------------------------

export function scanPluginVersion(pluginDir: string): string {
  const pluginJson = join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!isFile(pluginJson)) return 'unknown';
  try {
    const data = JSON.parse(readFileSync(pluginJson, 'utf8'));
    return typeof data.version === 'string' ? data.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function scanCoreCommands(pluginDir: string): CoreCommand[] {
  const commandsDir = join(pluginDir, 'commands');
  if (!isDir(commandsDir)) return [];

  let filenames: string[];
  try {
    filenames = readdirSync(commandsDir);
  } catch {
    return [];
  }

  const commands: CoreCommand[] = [];
  for (const filename of [...filenames].sort()) {
    if (!filename.endsWith('.md')) continue;

    const frontmatter = parseFrontmatter(join(commandsDir, filename));
    if (!frontmatter) continue;

    if (frontmatter.core === 'true') {
      const name = filename.slice(0, -'.md'.length);
      const summary = frontmatter.summary ?? frontmatter.description ?? '';
      commands.push({ name, summary });
    }
  }

  return commands;
}

/**
 * Extract flat `key: value` YAML frontmatter. Returns `null` if the file has
 * no leading `---` delimiter or no closing one. Mirrors `_parse_frontmatter`
 * in Python — simple key/value only, no nested parsing.
 */
export function parseFrontmatter(filepath: string): Record<string, string> | null {
  let content: string;
  try {
    content = readFileSync(filepath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  if (lines.length === 0) return null;

  // Python `f.readline().rstrip()` strips trailing whitespace, not leading.
  const firstLine = (lines[0] ?? '').replace(/\s+$/, '');
  if (firstLine !== '---') return null;

  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\s+$/, '');
    if (line === '---') return fields;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Python: value.strip().strip('"').strip("'") — strip any leading/trailing
    // double quotes, then any leading/trailing single quotes.
    value = stripChars(value, '"');
    value = stripChars(value, "'");
    if (key && value) {
      fields[key] = value;
    }
  }

  // Reached EOF without closing --- → Python returns None.
  return null;
}

function stripChars(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

// ---------------------------------------------------------------------------
// CAFI
// ---------------------------------------------------------------------------

export function scanCafi(root: string): CafiSummary {
  const cachePath = join(root, '.prove', 'file-index.json');
  const hasCache = isFile(cachePath);

  let fileCount = 0;
  if (hasCache) {
    try {
      const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
      const files = cache?.files;
      if (isObject(files)) {
        fileCount = Object.keys(files).length;
      }
    } catch {
      // leave file_count at 0
    }
  }

  return { available: hasCache, file_count: fileCount };
}

// ---------------------------------------------------------------------------
// Small FS helpers
// ---------------------------------------------------------------------------

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// sep is referenced by the walker depth calc indirectly via `join`; keep the
// import pinned so biome doesn't flag it as unused.
void sep;
