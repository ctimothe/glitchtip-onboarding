'use strict'

const INTERNAL_CODES = new Set(['network-error', 'invalid-response', 'invalid-input', 'delivery-failed', 'telegram-error'])
const TELEGRAM_CODES = new Set([400, 401, 403, 404, 429, 500])

const normalizeFailureCode = (value) => {
  if (INTERNAL_CODES.has(value)) return value
  if (Number.isSafeInteger(value) && TELEGRAM_CODES.has(value)) return `telegram-${value}`
  if (typeof value === 'string' && /^telegram-(400|401|403|404|429|500)$/.test(value)) return value
  return 'delivery-failed'
}

const isFailureCode = (value) => normalizeFailureCode(value) === value

module.exports = { isFailureCode, normalizeFailureCode }
