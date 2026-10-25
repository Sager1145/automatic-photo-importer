import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {builtinModules} from 'node:module';

// The window bundle runs in the browser: a Node built-in anywhere in its import graph crashes it at start-up
// ("availableParallelism is not a function"), so the boot splash never goes away.
const desktop = path.resolve(new URL('..', import.meta.url).pathname);
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const resolve = (from: string, spec: string) => {
  const base = path.resolve(path.dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
};
const imports = (file: string) => [...fs.readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1]!);

test('nothing the window imports reaches a Node built-in', () => {
  const seen = new Map<string, string>(), queue = [path.join(desktop, 'renderer', 'main.tsx')];
  const problems: string[] = [];
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of imports(file)) {
      if (builtins.has(spec)) { problems.push(`${path.relative(desktop, file)} imports ${spec} (via ${seen.get(file) ?? 'entry'})`); continue; }
      if (!spec.startsWith('.')) continue;
      const next = resolve(file, spec);
      if (next && !seen.has(next)) { seen.set(next, path.relative(desktop, file)); queue.push(next); }
    }
  }
  assert.deepEqual(problems, []);
});
