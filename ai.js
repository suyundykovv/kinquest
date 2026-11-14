// Два вызова Claude: сюжет дня и текст отчёта. Оба с шаблоном на случай ошибки или отсутствия ключа.
// Приватность: в модель уходят только возрастная группа, интерес и цифры игры. Имя ребёнка — никогда:
// модель пишет метку {child}, а ник подставляется в браузере.
'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { ACTIVITIES, SKILLS } = require('./activities');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 20000);
const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
let client = null;
const getClient = () => (client ||= new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 }));

// ---------- регионы и шаблонные сюжеты ----------
const REGIONS = {
  ocean: {
    region: 'Подводное царство',
    cast: [
      { emoji: '🐙', name: 'Осьминог Окто' }, { emoji: '🦀', name: 'Краб Клешня' }, { emoji: '🐠', name: 'Рыбка Искра' },
      { emoji: '🐢', name: 'Черепаха Тиша' }, { emoji: '🐬', name: 'Дельфин Плюх' }, { emoji: '🦭', name: 'Тюлень Пузо' },
      { emoji: '🐡', name: 'Ёрш Колюч' }, { emoji: '🦑', name: 'Кальмар Чернил' }, { emoji: '🐳', name: 'Кит Бульк' },
    ],
    title: 'Затонувший храм осьминога',
    intro: 'Команда {child} ныряет к затонувшему храму. Кто-то стащил волшебную жемчужину осьминога Окто, и без неё вода вокруг храма мутнеет. Найдём вора, откроем двери храма и починим старый мост!',
    lock_names: ['Кто взял жемчужину?', 'Двери храма', 'Коралловый мост'],
    card: 'Как думаешь, зачем осьминогу целых три сердца?',
  },
  space: {
    region: 'Космическая станция',
    cast: [
      { emoji: '👽', name: 'Зелёный Зиг' }, { emoji: '🤖', name: 'Робот Болтик' }, { emoji: '🐶', name: 'Собака Белка' },
      { emoji: '🐱', name: 'Кот Комета' }, { emoji: '🦊', name: 'Лиса Орбита' }, { emoji: '🐼', name: 'Панда Луна' },
      { emoji: '🐧', name: 'Пингвин Ракета' }, { emoji: '🐹', name: 'Хомяк Метеор' }, { emoji: '🦉', name: 'Сова Звёздочка' },
    ],
    title: 'Пропавший звёздный ключ',
    intro: 'Команда {child} прилетает на станцию «Полярная». Кто-то утащил звёздный ключ, и станция не может включить свет. Найдём пропажу, разгадаем шифр шлюза и соберём антенну по чертежу!',
    lock_names: ['Кто унёс ключ?', 'Шлюз станции', 'Антенна связи'],
    card: 'Если бы ты жил на космической станции, по чему бы ты скучал больше всего?',
  },
  dinosaurs: {
    region: 'Долина динозавров',
    cast: [
      { emoji: '🦕', name: 'Диплодок Дима' }, { emoji: '🦖', name: 'Рекс Рык' }, { emoji: '🐊', name: 'Крок Хвост' },
      { emoji: '🦎', name: 'Ящерка Шустрик' }, { emoji: '🐢', name: 'Черепаха Панцирь' }, { emoji: '🦤', name: 'Птица Додо' },
      { emoji: '🐸', name: 'Лягушка Прыг' }, { emoji: '🦔', name: 'Ёж Иголкин' }, { emoji: '🐿️', name: 'Белка Орешек' },
    ],
    title: 'Тайна пропавшего яйца',
    intro: 'Команда {child} отправляется в Долину динозавров. Из гнезда пропало золотое яйцо! Найдём, кто его унёс, откроем ворота пещеры и построим мост через реку.',
    lock_names: ['Кто унёс яйцо?', 'Ворота пещеры', 'Мост через реку'],
    card: 'Какой динозавр тебе больше нравится и почему — большой и медленный или маленький и быстрый?',
  },
  animals: {
    region: 'Волшебный лес',
    cast: [
      { emoji: '🦊', name: 'Лиса Луша' }, { emoji: '🐰', name: 'Заяц Тим' }, { emoji: '🦉', name: 'Сова Фила' },
      { emoji: '🐻', name: 'Медвежонок Бо' }, { emoji: '🐿️', name: 'Белка Рыжик' }, { emoji: '🦔', name: 'Ёжик Колюч' },
      { emoji: '🐸', name: 'Лягушонок Ква' }, { emoji: '🐢', name: 'Черепаха Тиша' }, { emoji: '🦝', name: 'Енот Шмыг' },
    ],
    title: 'Пропавший жёлудь мудрости',
    intro: 'Команда {child} идёт в Волшебный лес. С вершины старого дуба исчез жёлудь мудрости! Найдём вора, разгадаем шифр на двери дупла и починим мостик через ручей.',
    lock_names: ['Кто взял жёлудь?', 'Дверь в дупло', 'Мостик через ручей'],
    card: 'Если бы ты мог поговорить с любым животным из леса, что бы ты у него спросил?',
  },
};
const regionFor = (interest) => REGIONS[interest] || REGIONS.animals;

function templateStory(interest) {
  const r = regionFor(interest);
  return { title: r.title, intro: r.intro, lock_names: r.lock_names, conversation_card: r.card, region: r.region, cast: r.cast, source: 'template' };
}

function textOf(resp) {
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callJson({ system, prompt, schema, maxTokens = 2000 }) {
  const resp = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  if (resp.stop_reason === 'refusal') throw new Error('refusal');
  if (resp.stop_reason === 'max_tokens') throw new Error('max_tokens');
  return JSON.parse(textOf(resp));
}

const shortStr = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;

// ---------- 1. сюжет дня ----------
async function generateStory({ ageBand, interest, suspects }) {
  const base = templateStory(interest);
  if (!hasKey()) return base;
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['title', 'intro', 'lock_names', 'suspect_names', 'conversation_card'],
    properties: {
      title: { type: 'string' },
      intro: { type: 'string' },
      lock_names: { type: 'array', items: { type: 'string' } },
      suspect_names: { type: 'array', items: { type: 'string' } },
      conversation_card: { type: 'string' },
    },
  };
  const prompt = `Семья: ребёнок {child} (${ageBand || '6–10'} лет, любит: ${base.region}) и взрослый. Регион недели: ${base.region}.
Замки дня по порядку: detective (найти, кто из ${suspects} жителей что-то стащил), cipher (шифр из светящихся знаков на двери), blueprint (собрать деталь из кубиков по чертежу, чтобы починить мост или механизм).
Персонажи-подозреваемые — это животные: ${base.cast.slice(0, suspects).map((c) => c.emoji).join(' ')} (ровно в этом порядке).
Верни JSON:
- title: название экспедиции (до 6 слов);
- intro: до 3 коротких предложений простыми словами, обращаясь к «команде {child}»; объясни, куда идём и зачем;
- lock_names: ровно 3 коротких названия замков в порядке detective, cipher, blueprint;
- suspect_names: ровно ${suspects} добрых имён для животных в том же порядке, формат «Вид Имя», до 20 символов каждое;
- conversation_card: один открытый вопрос по теме дня для разговора без экрана.
Без насилия, без страшных персонажей. Вор — не злодей, а проказник.`;
  try {
    const out = await callJson({
      system: 'Ты — автор добрых детских приключений для семейной игры. Пишешь по-русски, коротко и тепло.',
      prompt, schema,
    });
    if (!shortStr(out.title, 80) || !shortStr(out.intro, 450) || !shortStr(out.conversation_card, 220)) throw new Error('bad story fields');
    if (!Array.isArray(out.lock_names) || out.lock_names.length !== 3 || !out.lock_names.every((s) => shortStr(s, 40))) throw new Error('bad lock names');
    const names = Array.isArray(out.suspect_names) && out.suspect_names.length >= suspects && out.suspect_names.every((s) => shortStr(s, 24)) ? out.suspect_names : null;
    return {
      title: out.title, intro: out.intro, lock_names: out.lock_names, conversation_card: out.conversation_card,
      region: base.region,
      cast: base.cast.map((c, i) => ({ emoji: c.emoji, name: (names && i < suspects && names[i]) || c.name })),
      source: 'claude',
    };
  } catch (e) {
    console.warn('[ai] story fallback:', e.message);
    return base;
  }
}

// ---------- 2. текст отчёта ----------
// Винительный падеж для фраз «задачи на …».
const SKILL_ACC = { spatial: 'пространственное мышление', patterns: 'закономерности', logic: 'логику', critical: 'критическое мышление', communication: 'общение' };

function templateReport(m) {
  const h = m.highlights;
  const recs = [];
  const pickFor = (sk, n) => ACTIVITIES.filter((a) => a.skill === sk).slice(0, n);
  if (h.growth) recs.push(...pickFor(h.growth.skill, 2));
  else if (h.strength) recs.push(...pickFor(h.strength.skill, 1));
  recs.push(...pickFor('communication', 1));
  const t = m.team;
  return {
    headline: `${t.locks} замков за ${t.minutes} мин вместе — команда {child} растёт!`,
    strength: h.strength ? `Лучше всего у {child} получаются задачи на ${SKILL_ACC[h.strength.skill]} — вот что это показывает:` : 'Пока мало данных, чтобы назвать сильную сторону: нужно хотя бы 3 задачи одного типа.',
    growth: h.growth ? `Больше всего места для роста — задачи на ${SKILL_ACC[h.growth.skill]}. Это не слабость, а следующий шаг:` : 'Пока мало данных для зоны роста — сыграйте ещё пару экспедиций.',
    style: h.style.length ? h.style : ['Пока мало данных о стиле мышления.'],
    activity_ids: recs.map((a) => a.id),
    next_week: h.growth ? `Kinquest добавит больше задач на ${SKILL_ACC[h.growth.skill]} на комфортном уровне.` : 'Kinquest продолжит подбирать задачи так, чтобы {child} решал(а) примерно 3 из 4 сам(а).',
    team: t.firstTryLocks ? `С первой попытки открыто ${t.firstTryLocks} из ${t.locks} замков.${t.stuckOn ? ` Чаще всего задерживались на «${t.stuckOn}».` : ''}` : `Замков открыто: ${t.locks}.${t.stuckOn ? ` Больше всего обсуждали «${t.stuckOn}».` : ''}`,
    source: 'template',
  };
}

async function writeReport(metrics) {
  const base = templateReport(metrics);
  if (!hasKey()) return base;
  const ids = ACTIVITIES.map((a) => a.id);
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['headline', 'strength', 'growth', 'style', 'activity_ids', 'next_week', 'team'],
    properties: {
      headline: { type: 'string' }, strength: { type: 'string' }, growth: { type: 'string' },
      style: { type: 'array', items: { type: 'string' } },
      activity_ids: { type: 'array', items: { type: 'string', enum: ids } },
      next_week: { type: 'string' }, team: { type: 'string' },
    },
  };
  const safe = { ...metrics, subject: { ageBand: metrics.subject.ageBand, kind: metrics.subject.kind } }; // без ника
  const prompt = `Вот метрики ребёнка {child} из семейной игры Kinquest (JSON):\n${JSON.stringify(safe)}\n
Библиотека занятий без экрана (выбирай только отсюда, по id):\n${ACTIVITIES.map((a) => `${a.id} [${a.skill}]: ${a.text}`).join('\n')}\n
Навыки: ${Object.entries(SKILLS).map(([k, v]) => `${k}=${v}`).join(', ')}.
Напиши отчёт для родителя по-русски. Правила:
- каждый вывод опирается на цифру из метрик; цифр, которых нет в JSON, не придумывай;
- если у навыка enoughData=false, пиши «пока мало данных»;
- наблюдения, а не диагнозы; без IQ, «гениев» и сравнения с другими детьми;
- называй ребёнка только меткой {child};
- headline — одна фраза; strength и growth — 1–2 предложения с доказательством (используй highlights);
- style — 1–3 коротких наблюдения о поведении в игре;
- activity_ids — 2–3 id из библиотеки под зону роста;
- next_week — что Kinquest сам изменит на следующей неделе (одно предложение);
- team — одно предложение о том, как семья работала вместе.`;
  try {
    const out = await callJson({ system: 'Ты пишешь тёплые и честные отчёты для родителей о развитии навыков ребёнка в игре.', prompt, schema, maxTokens: 3000 });
    const activity_ids = (out.activity_ids || []).filter((id) => ids.includes(id)).slice(0, 3);
    if (!shortStr(out.headline, 200) || !shortStr(out.strength, 600) || !shortStr(out.growth, 600) || activity_ids.length < 1) throw new Error('bad report fields');
    return { ...out, style: (out.style || []).filter((s) => shortStr(s, 300)).slice(0, 3), activity_ids, source: 'claude' };
  } catch (e) {
    console.warn('[ai] report fallback:', e.message);
    return base;
  }
}

module.exports = { generateStory, writeReport, templateStory, templateReport, REGIONS, hasKey, MODEL };
