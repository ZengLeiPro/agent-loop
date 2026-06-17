import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const checkedPaths = ['prompts', 'src', 'templates', 'README.md', 'web', 'package.json'];
const requiredStrings = new Map([
  ['prompts/ralph-compound/planner.md', ['.agent-loop/spec.md', '.agent-loop/prd.json']],
  ['prompts/ralph-compound/worker.md', ['.agent-loop/progress.txt', '.agent-loop/prd.json', '.agent-loop/AGENTS.md']],
  ['prompts/ralph-compound/judge.md', ['.agent-loop/judge-{round}.md']],
  ['templates/ralph-compound.json', ['.agent-loop/progress.txt', '.agent-loop/judge-{{round}}.md']]
]);

async function collectFiles(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!entries) return [path];

  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    if (entry.isFile()) files.push(child);
  }
  return files;
}

async function main() {
  const files = (await Promise.all(checkedPaths.map(collectFiles))).flat();
  if (files.length === 0) {
    console.error('State protocol check did not scan any files. Check the script working directory.');
    process.exit(1);
  }

  const legacyViolations = [];
  const contents = new Map();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    contents.set(file, text);
    if (text.includes('.harness')) legacyViolations.push(file);
  }

  const missingRequired = [];
  for (const [file, requiredValues] of requiredStrings) {
    const text = contents.get(file) ?? await readFile(file, 'utf8');
    for (const value of requiredValues) {
      if (!text.includes(value)) missingRequired.push(`${file}: ${value}`);
    }
  }

  if (legacyViolations.length > 0 || missingRequired.length > 0) {
    if (legacyViolations.length > 0) {
      console.error('Found legacy .harness references in runtime protocol files:');
      for (const file of legacyViolations) console.error(`- ${file}`);
    }
    if (missingRequired.length > 0) {
      console.error('Missing required .agent-loop protocol references:');
      for (const item of missingRequired) console.error(`- ${item}`);
    }
    process.exit(1);
  }

  console.log(`State protocol check passed: ${files.length} runtime protocol files use .agent-loop.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
