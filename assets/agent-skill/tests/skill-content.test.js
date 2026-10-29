'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')
const policy = fs.readFileSync(path.join(root, 'references', 'evidence-policy.md'), 'utf8')
const both = [['SKILL.md', skill], ['evidence-policy.md', policy]]

test('frontmatter names the skill', () => {
  assert.match(skill, /^---\nname: glitchtip-investigate\ndescription: .+\n---\n/)
})

test('SKILL.md pins required policy phrases', () => {
  for (const phrase of [
    'glitchtip-companion context --ref',
    'Do not modify code',
    'stop and report the exact failed step',
    'reproduction result',
    'confidence',
    'smallest safe fix options',
    'redact secrets and personal data',
  ]) assert.match(skill, new RegExp(phrase, 'i'), `missing: ${phrase}`)
})

test('SKILL.md pins helper contract', () => {
  for (const phrase of [
    'Library/Application Support/dev.ctimothe.glitchtip-onboarding/bin/glitchtip-companion',
    '--format json',
    'helper-not-installed',
    'gt:<application-id>:<issue-id>',
  ]) assert.ok(skill.includes(phrase), `missing: ${phrase}`)
  for (const [code, name] of [[0, 'success'], [2, 'configuration'], [3, 'credential'], [4, 'network'], [5, 'sanitization']])
    assert.match(skill, new RegExp(`\\b${code}\\b[^\\n]*${name}`, 'i'), `exit code ${code}`)
})

test('SKILL.md defines every state', () => {
  for (const heading of ['Error', 'Warning', 'Resolved', 'Test', 'Setup Failure'])
    assert.match(skill, new RegExp(`^##+ .*${heading}`, 'm'), `missing state: ${heading}`)
  assert.match(skill, /do not assume a fix/i)
  assert.match(skill, /do not inspect application code/i)
  assert.match(skill, /do not classify it as an application failure/i)
})

test('workflow steps appear in order', () => {
  const steps = ['Validate', 'Run the helper', 'repository instructions', 'safe frames', 'smallest existing test', 'failing release', 'Report', 'Stop']
  let at = -1
  for (const s of steps) {
    const i = skill.toLowerCase().indexOf(s.toLowerCase(), at + 1)
    assert.ok(i > at, `step out of order or missing: ${s}`)
    at = i
  }
})

test('references the evidence policy file', () => {
  assert.match(skill, /references\/evidence-policy\.md/)
})

test('forbidden content is absent', () => {
  for (const [name, text] of both) {
    for (const bad of ['git push', 'deploy', 'apply migration', 'auto-fix', 'paste your token'])
      assert.ok(!text.toLowerCase().includes(bad), `${name} contains forbidden: ${bad}`)
  }
})

test('no credential-like examples', () => {
  const patterns = [
    /\bglpat-[A-Za-z0-9_-]{8,}/, /\bghp_[A-Za-z0-9]{8,}/, /\bsk-[A-Za-z0-9]{16,}/,
    /\bAKIA[0-9A-Z]{12,}/, /\b\d{6,}:[A-Za-z0-9_-]{30,}/, /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
    /\beyJ[A-Za-z0-9_-]{10,}\./, /https?:\/\/[^\s/@]+:[^\s/@]+@/, /\b[0-9a-f]{32,}\b/i,
    /[\w.+-]+@[\w-]+\.[\w.]+/,
  ]
  for (const [name, text] of both)
    for (const p of patterns) assert.ok(!p.test(text), `${name} matches credential pattern ${p}`)
})
