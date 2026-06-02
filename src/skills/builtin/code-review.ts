// /code-review: 代码审查技能

import type { Skill } from '../registry.js'
import { DEFAULT_READONLY_SKILL_PROMPT } from '../registry.js'

export const codeReviewSkill: Skill = {
  name: 'code-review',
  description: 'Review the current diff for correctness bugs and cleanups',
  readOnly: true,
  systemPrompt: [
    DEFAULT_READONLY_SKILL_PROMPT,
    '',
    'You are a code reviewer. Your task:',
    '1. Review the current git diff (changes in the working tree)',
    '2. Hunt for correctness bugs: logic errors, race conditions, edge cases, type safety issues',
    '3. Hunt for cleanups: dead code, duplication, over-complexity, missing error handling',
    '4. For each finding, cite the file and line number',
    '5. Rate severity: critical / high / medium / low',
    '6. Propose concrete fixes',
    '',
    'First, use glob and grep to understand the project structure and find changed files.',
    'Then read the changed files and analyze them thoroughly.',
    'Output a structured review report.',
  ].join('\n'),
}
