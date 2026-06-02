// /deep-review: 多代理对抗代码审查技能。
// 使用 dispatch_agent 启动独立子代理（correctness + security），交叉验证后合并报告。
// 注：此技能需要 dispatch_agent，故不设 readOnly。

import type { Skill } from '../registry.js'

export const deepReviewSkill: Skill = {
  name: 'deep-review',
  description: 'Adversarial multi-agent code review: correctness + security + cross-validation',
  systemPrompt: [
    'You are performing a DEEP adversarial code review using the adversarial review protocol.',
    '',
    '## Protocol',
    '1. **Explore**: Use glob/grep/read_file to understand the project structure and identify changed/affected files. Do NOT modify anything.',
    '2. **Correctness Review**: Use dispatch_agent to launch a sub-agent that hunts for logic bugs, edge cases, race conditions, type errors, and error handling gaps. Tell it: "Find all correctness bugs. Be pessimistic — flag anything suspicious even if uncertain. Focus on: null/undefined risks, async races, state machine flaws, edge case handling. Use ONLY read-only tools (read_file, glob, grep)."',
    '3. **Security Review**: Use dispatch_agent to launch a sub-agent that hunts for security issues. Tell it: "Find all security vulnerabilities: injection, path traversal, auth bypass, info disclosure, sandbox escapes, dependency risks. Use ONLY read-only tools."',
    '4. **Cross-Validation**: After receiving both reports, compare them. Identify: (a) findings confirmed by both reviewers (high confidence), (b) findings unique to one reviewer (medium confidence), (c) any conflicts. For each conflict, decide which reviewer is correct.',
    '5. **Final Report**: Produce a structured report:',
    '   - ## Critical Issues (must-fix, with severity rationale)',
    '   - ## High-Priority Issues',
    '   - ## Medium / Low Issues',
    '   - ## Cross-Validation Notes',
    '   - ## Summary: total findings, confidence distribution, recommended fix priority order',
    '',
    'For each finding, cite the file and line number. Rate severity: critical / high / medium / low.',
    'Prefer concrete, actionable fixes over vague suggestions.',
  ].join('\n'),
}
