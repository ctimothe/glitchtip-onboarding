'use strict'

/** @typedef {'codex'|'claude'|'other'} AgentProvider */
/** @typedef {'error'|'warning'|'resolved'|'test'|'setup_failure'} PromptState */

const PROVIDERS = ['codex', 'claude', 'other']
const STATES = ['error', 'warning', 'resolved', 'test', 'setup_failure']
const LOCALES = ['uz', 'ru', 'en']

const TITLE_LIMIT = 160
const FIELD_LIMITS = {
  applicationName: 80,
  environment: 40,
  release: 80,
  impact: 120,
  classification: 80,
}
const REF_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/
const CALLBACK_KEY = /^[A-Za-z0-9_-]{1,40}$/
const FORBIDDEN_PROPERTIES = ['context', 'payload']
const MAX_PROMPT_LENGTH = 3000
const MAX_LINE_LENGTH = 400

const unsafe = () => {
  const error = new Error('unsafe-prompt')
  error.code = 'unsafe-prompt'
  return error
}

const PROMPTS = {
  en: {
    openerDefault: 'Investigate GlitchTip issue GT-{issue} for {application} in this repository.',
    openerTest: 'Check GlitchTip delivery test GT-{issue} for {application} in this repository.',
    openerSetupFailure: 'Diagnose the GlitchTip Companion setup for {application} in this repository.',
    providerCodex: 'Use $glitchtip-investigate. Fetch the latest private issue context using incident reference `{reference}`.',
    providerClaude: 'Use /glitchtip-investigate. Fetch the latest private issue context using incident reference `{reference}`.',
    providerOther: 'Run glitchtip-companion context --ref {reference} --format json, then follow the repository investigation policy.',
    goalError: 'Goal: reproduce and diagnose the {title}.',
    goalWarning: 'Goal: measure the trend, risk, and action threshold of the {title}.',
    goalResolved: 'Goal: confirm recovery and recurrence risk of the {title}. Do not assume a fix.',
    goalTest: 'Goal: verify delivery only for the {title}. Do not inspect application code.',
    goalSetupFailure: 'Goal: diagnose the Companion, GlitchTip, relay, or Telegram setup failure: {title}. Do not classify it as an application failure.',
    boundaryDefault: 'Do not modify code, dependencies, infrastructure, or production data unless I explicitly ask after reviewing your diagnosis.',
    boundaryTest: 'Do not modify code, dependencies, infrastructure, or production data.',
    signalHeading: 'Known signal:',
    signalEnvironment: '- Environment: {value}',
    signalRelease: '- Release: {value}',
    signalImpact: '- Impact: {value}',
    signalClassification: '- Classification: {value}',
    reportHeading: 'Report:',
    reportError: '1. Reproduction result and evidence\n2. Most likely root cause, with relevant code paths\n3. What changed near the first failing release\n4. Confidence, unknowns, and missing evidence\n5. Smallest safe fix options and verification plan',
    reportWarning: '1. Trend over the observed window, with evidence\n2. Risk if the trend continues\n3. Suggested action threshold\n4. Confidence, unknowns, and missing evidence\n5. Smallest safe next step and verification plan',
    reportResolved: '1. Evidence that the issue has recovered\n2. Likely reason for recovery, marked as unconfirmed if unproven\n3. Recurrence risk and what would signal it\n4. Confidence, unknowns, and missing evidence\n5. Monitoring to keep or add',
    reportTest: '1. Whether the test event reached GlitchTip, the relay, and Telegram\n2. Delay at each step\n3. Any step that failed, with its exact failure code',
    reportSetupFailure: '1. The setup step that failed, with its exact failure code\n2. Whether the cause is Companion, GlitchTip, relay, or Telegram\n3. Evidence for that cause\n4. Smallest safe fix and how to verify it',
    closing: 'Redact secrets and personal data. If private context cannot be fetched, stop and report the exact failed step. Do not guess.',
    buttonCodex: 'Codex',
    buttonClaude: 'Claude Code',
    buttonOther: 'Other',
  },
  ru: {
    openerDefault: 'Изучите проблему GlitchTip GT-{issue} в приложении {application} в этом репозитории.',
    openerTest: 'Проверьте тест доставки GlitchTip GT-{issue} для {application} в этом репозитории.',
    openerSetupFailure: 'Диагностируйте настройку GlitchTip Companion для {application} в этом репозитории.',
    providerCodex: 'Используйте $glitchtip-investigate. Получите свежий приватный контекст проблемы по ссылке на инцидент `{reference}`.',
    providerClaude: 'Используйте /glitchtip-investigate. Получите свежий приватный контекст проблемы по ссылке на инцидент `{reference}`.',
    providerOther: 'Выполните glitchtip-companion context --ref {reference} --format json, затем следуйте политике расследования репозитория.',
    goalError: 'Цель: воспроизвести и диагностировать: {title}.',
    goalWarning: 'Цель: оценить тренд, риск и порог действия: {title}.',
    goalResolved: 'Цель: подтвердить восстановление и риск повторения: {title}. Не предполагайте, что исправление было сделано.',
    goalTest: 'Цель: проверить только доставку: {title}. Не изучайте код приложения.',
    goalSetupFailure: 'Цель: диагностировать сбой настройки Companion, GlitchTip, релея или Telegram: {title}. Не считайте это сбоем приложения.',
    boundaryDefault: 'Не изменяйте код, зависимости, инфраструктуру и производственные данные, пока я явно не попрошу после изучения вашего диагноза.',
    boundaryTest: 'Не изменяйте код, зависимости, инфраструктуру и производственные данные.',
    signalHeading: 'Известный сигнал:',
    signalEnvironment: '- Окружение: {value}',
    signalRelease: '- Релиз: {value}',
    signalImpact: '- Влияние: {value}',
    signalClassification: '- Классификация: {value}',
    reportHeading: 'Отчёт:',
    reportError: '1. Результат воспроизведения и доказательства\n2. Наиболее вероятная первопричина с релевантными путями в коде\n3. Что изменилось рядом с первым сбойным релизом\n4. Уверенность, неизвестное и недостающие доказательства\n5. Наименьшие безопасные варианты исправления и план проверки',
    reportWarning: '1. Тренд за наблюдаемое окно с доказательствами\n2. Риск, если тренд продолжится\n3. Предлагаемый порог действия\n4. Уверенность, неизвестное и недостающие доказательства\n5. Наименьший безопасный следующий шаг и план проверки',
    reportResolved: '1. Доказательства того, что проблема исчезла\n2. Вероятная причина восстановления; если не доказана, отметьте как неподтверждённую\n3. Риск повторения и что на него укажет\n4. Уверенность, неизвестное и недостающие доказательства\n5. Какой мониторинг оставить или добавить',
    reportTest: '1. Дошло ли тестовое событие до GlitchTip, релея и Telegram\n2. Задержка на каждом шаге\n3. Шаг, который не удался, с точным кодом сбоя',
    reportSetupFailure: '1. Шаг настройки, который не удался, с точным кодом сбоя\n2. Причина в Companion, GlitchTip, релее или Telegram\n3. Доказательства этой причины\n4. Наименьшее безопасное исправление и как его проверить',
    closing: 'Скройте секреты и персональные данные. Если приватный контекст получить нельзя, остановитесь и сообщите точный неудавшийся шаг. Не гадайте.',
    buttonCodex: 'Codex',
    buttonClaude: 'Claude Code',
    buttonOther: 'Другой',
  },
  uz: {
    openerDefault: 'Ushbu repozitoriyda {application} uchun GlitchTip GT-{issue} muammosini tekshiring.',
    openerTest: 'Ushbu repozitoriyda {application} uchun GlitchTip GT-{issue} yetkazib berish testini tekshiring.',
    openerSetupFailure: 'Ushbu repozitoriyda {application} uchun GlitchTip Companion sozlamasini diagnostika qiling.',
    providerCodex: 'Foydalaning: $glitchtip-investigate. Hodisa havolasi `{reference}` bo‘yicha eng so‘nggi maxfiy muammo kontekstini oling.',
    providerClaude: 'Foydalaning: /glitchtip-investigate. Hodisa havolasi `{reference}` bo‘yicha eng so‘nggi maxfiy muammo kontekstini oling.',
    providerOther: 'glitchtip-companion context --ref {reference} --format json buyrug‘ini ishga tushiring, so‘ng repozitoriyning tekshiruv siyosatiga amal qiling.',
    goalError: 'Maqsad: qayta yaratish va diagnostika qilish: {title}.',
    goalWarning: 'Maqsad: tendensiya, xavf va harakat chegarasini baholash: {title}.',
    goalResolved: 'Maqsad: tiklanish va qaytalanish xavfini tasdiqlash: {title}. Tuzatish qilingan deb o‘ylamang.',
    goalTest: 'Maqsad: faqat yetkazib berishni tekshirish: {title}. Ilova kodini tekshirmang.',
    goalSetupFailure: 'Maqsad: Companion, GlitchTip, relay yoki Telegram sozlamasidagi nosozlikni diagnostika qilish: {title}. Buni ilova nosozligi deb hisoblamang.',
    boundaryDefault: 'Diagnozingizni ko‘rib chiqqanimdan keyin aniq so‘ramasam, kod, bog‘liqliklar, infratuzilma va ishlab chiqarish ma’lumotlarini o‘zgartirmang.',
    boundaryTest: 'Kod, bog‘liqliklar, infratuzilma va ishlab chiqarish ma’lumotlarini o‘zgartirmang.',
    signalHeading: 'Ma’lum signal:',
    signalEnvironment: '- Muhit: {value}',
    signalRelease: '- Reliz: {value}',
    signalImpact: '- Ta’sir: {value}',
    signalClassification: '- Tasnif: {value}',
    reportHeading: 'Hisobot:',
    reportError: '1. Qayta yaratish natijasi va dalillar\n2. Eng ehtimolli ildiz sabab, tegishli kod yo‘llari bilan\n3. Birinchi nosoz reliz yaqinida nima o‘zgargan\n4. Ishonch darajasi, noma’lumlar va yetishmayotgan dalillar\n5. Eng kichik xavfsiz tuzatish variantlari va tekshiruv rejasi',
    reportWarning: '1. Kuzatilgan oynadagi tendensiya, dalillar bilan\n2. Tendensiya davom etsa xavf\n3. Taklif etilgan harakat chegarasi\n4. Ishonch darajasi, noma’lumlar va yetishmayotgan dalillar\n5. Eng kichik xavfsiz keyingi qadam va tekshiruv rejasi',
    reportResolved: '1. Muammo tiklanganini ko‘rsatuvchi dalillar\n2. Tiklanishning ehtimoliy sababi; isbotlanmasa, tasdiqlanmagan deb belgilang\n3. Qaytalanish xavfi va unga nima ishora qiladi\n4. Ishonch darajasi, noma’lumlar va yetishmayotgan dalillar\n5. Saqlash yoki qo‘shish kerak bo‘lgan monitoring',
    reportTest: '1. Test hodisasi GlitchTip, relay va Telegram’ga yetib bordimi\n2. Har bir qadamdagi kechikish\n3. Muvaffaqiyatsiz qadam, aniq nosozlik kodi bilan',
    reportSetupFailure: '1. Muvaffaqiyatsiz sozlash qadami, aniq nosozlik kodi bilan\n2. Sabab Companion, GlitchTip, relay yoki Telegram’dami\n3. Shu sababning dalillari\n4. Eng kichik xavfsiz tuzatish va uni qanday tekshirish',
    closing: 'Sirlar va shaxsiy ma’lumotlarni yashiring. Maxfiy kontekstni olib bo‘lmasa, to‘xtang va muvaffaqiyatsiz qadamni aniq xabar qiling. Taxmin qilmang.',
    buttonCodex: 'Codex',
    buttonClaude: 'Claude Code',
    buttonOther: 'Boshqa',
  },
}

const STATE_KEYS = {
  error: { goal: 'goalError', report: 'reportError' },
  warning: { goal: 'goalWarning', report: 'reportWarning' },
  resolved: { goal: 'goalResolved', report: 'reportResolved' },
  test: { goal: 'goalTest', report: 'reportTest' },
  setup_failure: { goal: 'goalSetupFailure', report: 'reportSetupFailure' },
}

const PROVIDER_KEYS = { codex: 'providerCodex', claude: 'providerClaude', other: 'providerOther' }

const interpolate = (template, values) => String(template).replace(
  /\{([a-zA-Z]+)\}/g,
  (_, key) => values[key] == null ? '' : String(values[key]),
)

const normalize = (value, limit) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text
}

const buildPrompt = ({ provider, incident, locale } = {}) => {
  if (!PROVIDERS.includes(provider)) throw unsafe()
  if (!LOCALES.includes(locale)) throw unsafe()
  if (!incident || typeof incident !== 'object') throw unsafe()
  for (const key of FORBIDDEN_PROPERTIES) {
    if (Object.prototype.hasOwnProperty.call(incident, key)) throw unsafe()
  }
  const state = incident.state
  if (!STATES.includes(state)) throw unsafe()
  const reference = String(incident.incidentRef == null ? '' : incident.incidentRef)
  if (!REF_PATTERN.test(reference)) throw unsafe()

  const messages = PROMPTS[locale]
  const keys = STATE_KEYS[state]
  const field = (name) => normalize(incident[name], FIELD_LIMITS[name])
  const title = normalize(incident.title, TITLE_LIMIT)
  const values = {
    application: field('applicationName'),
    issue: reference.split(':').pop(),
    reference,
    title,
  }
  const opener = state === 'test'
    ? messages.openerTest
    : state === 'setup_failure' ? messages.openerSetupFailure : messages.openerDefault
  const signals = [
    ['signalEnvironment', field('environment')],
    ['signalRelease', field('release')],
    ['signalImpact', field('impact')],
    ['signalClassification', field('classification')],
  ].filter(([, value]) => value)
    .map(([key, value]) => interpolate(messages[key], { value }))

  const blocks = [
    interpolate(opener, values),
    interpolate(messages[PROVIDER_KEYS[provider]], values),
    interpolate(messages[keys.goal], values) + ' ' +
      (state === 'test' ? messages.boundaryTest : messages.boundaryDefault),
  ]
  if (signals.length) blocks.push([messages.signalHeading, ...signals].join('\n'))
  blocks.push(`${messages.reportHeading}\n${messages[keys.report]}`)
  blocks.push(messages.closing)
  return blocks.join('\n\n')
}

const providerKeyboard = (callbackKey) => {
  const key = String(callbackKey == null ? '' : callbackKey)
  if (!CALLBACK_KEY.test(key)) throw unsafe()
  const messages = PROMPTS.en
  const button = (text, code) => ({ text, callback_data: `provider:${key}:${code}` })
  return {
    inline_keyboard: [[
      button(messages.buttonCodex, 'c'),
      button(messages.buttonClaude, 'h'),
      button(messages.buttonOther, 'o'),
    ]],
  }
}

const UNSAFE_PATTERNS = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}/,
  /[A-Za-z0-9_+/=-]{48,}/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /(?:\+|\b)\d[\d\s().-]{8,}\d\b/,
  /\bauthorization\s*[:=]/i,
  /\b(?:set-)?cookie\s*[:=]/i,
  /\bat\s+(?:\S+\s+)?\(?[^\s()]*[/\\][^\s()]*:\d+(?::\d+)?\)?/,
  /\.(?:js|ts|py|rb|go|java|php|cs):\d+(?::\d+)?\b/,
  /\bTraceback \(most recent call last\)/,
  /```/,
]

const assertPromptSafe = (prompt, secretCanaries = []) => {
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) throw unsafe()
  if (prompt.split('\n').some((line) => line.length > MAX_LINE_LENGTH)) throw unsafe()
  for (const canary of secretCanaries || []) {
    if (canary && prompt.includes(String(canary))) throw unsafe()
  }
  if (UNSAFE_PATTERNS.some((pattern) => pattern.test(prompt))) throw unsafe()
}

// Callback provider codes: one character each so callback_data stays under Telegram's 64-byte cap.
const PROVIDER_CODES = { c: 'codex', h: 'claude', o: 'other' }

module.exports = { PROVIDER_CODES,
  PROMPTS,
  PROMPT_STATES: STATES,
  assertPromptSafe,
  buildPrompt,
  providerKeyboard,
}
