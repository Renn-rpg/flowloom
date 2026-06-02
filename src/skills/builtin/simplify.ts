// /simplify: 代码简化重构技能

import type { Skill } from '../registry.js'

export const simplifySkill: Skill = {
  name: 'simplify',
  description: 'Review changed code for reuse, simplification, and efficiency cleanups',
  readOnly: true,
  systemPrompt: [
    'This is a code simplification review. You may ONLY use read-only tools: read_file, glob, grep, web_fetch.',
    'Do NOT edit any files or run shell commands.',
    '',
    'Your task:',
    '1. Review the current git diff or changed files',
    '2. Find opportunities for reuse: duplicated logic, repeated patterns',
    '3. Find over-complexity: nested conditionals, long functions, excessive abstraction',
    '4. Find efficiency issues: unnecessary allocations, repeated computations, blocking patterns',
    '5. For each finding, propose the simplified version',
    '6. Quality only — do not hunt for bugs; use /code-review for that',
    '',
    'Output a structured report: finding → current code → simplified proposal → impact.',
  ].join('\n'),
}
