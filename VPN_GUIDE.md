# Методичка: подключение VPN-бота к аналитике

Пошаговая инструкция, как научить VPN-бот отправлять события в аналитику, чтобы на дашборде появились его пользователи, выручка и источники трафика.

Формальный контракт API — все поля, порядок атрибуции, коды ответов — в [INTEGRATION.md](INTEGRATION.md). Здесь — что и где сделать.

Готовая рабочая реализация того же самого есть в боте приватки: `private/src/analytics/client.ts`. Если VPN-бот на Node.js, её можно взять за основу.

---

## Что получится

```
/start по UTM-ссылке ──▶ /api/utm/hit ──┐
/start без ссылки ─────▶ /api/events ───┤
пробный период ────────▶ /api/events ───┼──▶ аналитика ──▶ дашборд: выбрать «VPN»
оплата / продление ────▶ /api/events ───┤                  в шапке → пользователи,
отписка ───────────────▶ /api/events ───┘                  выручка, UTM / без метки
```

У VPN-бота нет канала — он «бот без канала». Все его цифры считаются от `/start`, а не от подписки на канал.

Главное, ради чего это делается: **покупка без метки не теряется.** Она записывается как «без метки» и видна на дашборде отдельной долей выручки.

---

## Шаг 1. Завести проект в дашборде

Дашборд → **Проекты** → «Добавить проект»:

| Поле | Что вписать |
| :--- | :--- |
| Название | например, `VPN` |
| Chat ID канала | **пусто** — канала нет |
| Username бота | username VPN-бота, без `@` или с ним — неважно |

Тип определится сам: **«Бот без канала»**. Username — это то, по чему аналитика узнаёт события VPN-бота, поэтому он должен совпадать с настоящим. Регистр не важен.

---

## Шаг 2. Адрес и ключ

VPN-боту в `.env` нужны две переменные:

```
ANALYTICS_API_URL=http://127.0.0.1:30000
ANALYTICS_API_KEY=
```

- **Адрес** — тот же, что `ANALYTICS_API_URL` у бота приватки. На сервере аналитика слушает `127.0.0.1:30000`.
- **Ключ** — значение `API_SECRET` из `.env` аналитики. Он один на все серверные интеграции и даёт полный доступ к API: в браузер и в клиентский код его не отдавать.

Если VPN-бот в Docker — ему нужен `network_mode: host`, как у приватки и аналитики. В обычной сети Docker `127.0.0.1` внутри контейнера — это сам контейнер, и до аналитики он не достучится.

Проверка на сервере:

```bash
curl -s http://127.0.0.1:30000/api/projects -H "X-API-Key: ваш-ключ"
```

В ответе должен быть проект из шага 1 с `"type":"bot_direct"` и вашим `botUsername`. Ответ `{"error":"Unauthorized"}` — ключ не тот.

---

## Шаг 3. Модуль отправки событий

Три правила, общие для любой платформы:

1. **Никогда не ждите аналитику в ответе пользователю.** Отправка — в фоне, с таймаутом. Аналитика упала — бот продолжает продавать.
2. **Называйте проект в каждом событии** — полем `botUsername`. Без него событие от нового человека некуда отнести, и оно не будет записано.
3. **Логируйте отказы.** Особенно `422`: это единственный случай, когда событие действительно потеряно.

Username бот узнаёт сам, у Telegram, — прописывать его руками не нужно.

### Node.js

```js
// analytics.js
const API_URL = (process.env.ANALYTICS_API_URL || '').replace(/\/$/, '');
const API_KEY = process.env.ANALYTICS_API_KEY || '';
const TIMEOUT_MS = 5000;

let botUsername; // заполняется при старте из getMe()

export function setBotUsername(username) {
  botUsername = username;
}

async function post(path, body) {
  try {
    const res = await fetch(API_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404 от /api/utm/hit — это просто «такой метки нет», его разбирает trackStart.
    if (!res.ok && !(path === '/api/utm/hit' && res.status === 404)) {
      console.error(`[analytics] ${path} → ${res.status}: ${await res.text()}`);
    }
    return res.status;
  } catch (err) {
    console.error(`[analytics] ${path} failed:`, err.message);
    return 0;
  }
}

/** Любое событие, кроме старта: trial_start, payment, renewal, churn. */
export function track(tgUserId, eventType, extra = {}) {
  return post('/api/events', { botUsername, tgUserId: String(tgUserId), eventType, ...extra });
}

/**
 * /start. С payload сначала пробуем UTM-метку; если такой метки нет —
 * записываем обычный старт без метки. Второе не шлём, если первое прошло:
 * /api/utm/hit сам записывает старт.
 */
export async function trackStart(tgUserId, payload, languageCode) {
  if (payload) {
    const status = await post('/api/utm/hit', { slug: payload, tgUserId: String(tgUserId), languageCode });
    if (status === 201) return;
  }
  await post('/api/events', { botUsername, tgUserId: String(tgUserId), eventType: 'lead', languageCode });
}
```

Подключение в Telegraf:

```js
import { setBotUsername, trackStart, track } from './analytics.js';

// при запуске
const me = await bot.telegram.getMe();
setBotUsername(me.username);

bot.start((ctx) => {
  // без await: пользователь не должен ждать аналитику
  trackStart(ctx.from.id, ctx.startPayload?.trim(), ctx.from.language_code);
  // ... ваш обычный /start ...
});
```

### Python (aiogram 3)

```python
# analytics.py
import logging
import os

import aiohttp

API_URL = os.environ.get("ANALYTICS_API_URL", "").rstrip("/")
API_KEY = os.environ.get("ANALYTICS_API_KEY", "")
TIMEOUT = aiohttp.ClientTimeout(total=5)
log = logging.getLogger("analytics")

bot_username: str | None = None  # заполняется при старте из get_me()


def set_bot_username(username: str) -> None:
    global bot_username
    bot_username = username


async def _post(path: str, body: dict) -> int:
    try:
        async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
            async with session.post(
                API_URL + path, json=body, headers={"X-API-Key": API_KEY}
            ) as res:
                # 404 от /api/utm/hit — «такой метки нет», его разбирает track_start.
                if res.status >= 400 and not (path == "/api/utm/hit" and res.status == 404):
                    log.error("%s → %s: %s", path, res.status, await res.text())
                return res.status
    except Exception as err:
        log.error("%s failed: %s", path, err)
        return 0


async def track(tg_user_id: int, event_type: str, **extra) -> None:
    """Любое событие, кроме старта: trial_start, payment, renewal, churn."""
    await _post("/api/events", {
        "botUsername": bot_username, "tgUserId": str(tg_user_id), "eventType": event_type, **extra,
    })


async def track_start(tg_user_id: int, payload: str | None, language_code: str | None) -> None:
    """С payload сначала пробуем UTM-метку, иначе — обычный старт без метки."""
    if payload:
        status = await _post("/api/utm/hit", {
            "slug": payload, "tgUserId": str(tg_user_id), "languageCode": language_code,
        })
        if status == 201:
            return
    await _post("/api/events", {
        "botUsername": bot_username, "tgUserId": str(tg_user_id),
        "eventType": "lead", "languageCode": language_code,
    })
```

Подключение:

```python
import asyncio

from aiogram.filters import CommandObject, CommandStart
from aiogram.types import Message

import analytics


@dp.message(CommandStart())
async def start(message: Message, command: CommandObject):
    # create_task: пользователь не должен ждать аналитику
    asyncio.create_task(analytics.track_start(
        message.from_user.id, (command.args or "").strip() or None, message.from_user.language_code,
    ))
    # ... ваш обычный /start ...


async def main():
    me = await bot.get_me()
    analytics.set_bot_username(me.username)
    await dp.start_polling(bot)
```

---

## Шаг 4. Какие события и где их слать

| Событие | Когда | Что передать |
| :--- | :--- | :--- |
| старт | пользователь нажал `/start` | `trackStart(id, payload, язык)` |
| `trial_start` | включился пробный период | `track(id, 'trial_start')` |
| `payment` | **первая** успешная оплата пользователя | `track(id, 'payment', { amount })` |
| `renewal` | каждая следующая оплата | `track(id, 'renewal', { amount })` |
| `churn` | подписка закончилась или отменена | `track(id, 'churn')` |

Где именно в коде:

- **`payment` и `renewal`** — там, где бот окончательно убеждается, что деньги пришли: в обработчике вебхука платёжки, после записи оплаты в свою базу. Не в момент, когда пользователь нажал «Оплатить». Первая это оплата или нет — решает ваша база: есть ли у человека уже оплаченные заказы.
- **`churn`** — там, где у вас истекает или отменяется подписка.

Про сумму:

- `amount` — **фактически полученные деньги, в рублях.** Со скидкой — уже за вычетом скидки.
- Был промокод — добавьте `promoCode` и `discountAmount`, чтобы на вкладке «Промокоды» было видно, какие коды работают. На выручку они не влияют.
- Оплата в другой валюте — переведите в рубли у себя.

Пример оплаты:

```js
track(user.tgId, isFirstPayment ? 'payment' : 'renewal', {
  amount: 299,
  promoCode: 'SEPT20',   // если был
  discountAmount: 75,    // если был
});
```

Метку в оплату передавать не нужно. Аналитика сама найдёт, с какой UTM-ссылки пришёл человек, по его старту.

---

## Шаг 5. UTM-ссылки

Дашборд → **UTM-метки** → форма создания:

1. **Проект** — выберите VPN. Это обязательно: без проекта трафик метки не попадёт в статистику VPN.
2. Источник, канал, кампания — как вам удобно (`vk` / `cpc` / `sept`).
3. **Бот** — VPN-бот, чтобы дашборд собрал готовую ссылку.

Дашборд выдаст ссылку вида `https://t.me/ваш_vpn_bot?start=abc12345`. Именно её и размещайте в рекламе. Когда человек по ней заходит, бот получает `abc12345` в `/start` — модуль из шага 3 сам отправит его в `/api/utm/hit`.

Payload в `/start`, который не является меткой (реферальный код и т. п.), модуль тоже обработает: аналитика ответит `404`, и старт запишется без метки.

---

## Шаг 6. Проверить

**Лучше до создания UTM-меток и до запуска рекламы** — тестовые события попадут в статистику.

Отправить пробное событие на сервере:

```bash
curl -s -X POST http://127.0.0.1:30000/api/events \
  -H 'Content-Type: application/json' -H "X-API-Key: ваш-ключ" \
  -d '{"botUsername":"ваш_vpn_bot","tgUserId":"1","eventType":"lead"}'
```

Ответ `{"success":true,"event":{…,"projectId":…,"source":"organic"}}` — событие записано. `projectId` должен совпадать с проектом VPN.

Потом — живьём: нажмите `/start` у VPN-бота, пройдите пробный период, оплатите. На дашборде:

1. В шапке выберите **VPN**.
2. **Пользователи** и **Выручка** должны вырасти.
3. В **Последних событиях** появятся ваши действия, с пометкой проекта «VPN».
4. В **Источниках трафика** покупка без UTM-ссылки ляжет в долю «Без метки», по ссылке — в «По UTM».

Начать с чистого листа после проверки: в боте аналитики **🔒 Приватки** → VPN → **🗑️ Удалить бота**, затем завести проект заново (шаг 1). Удаляются и все его события и UTM-метки — поэтому метки создавайте уже после.

---

## Как читать дашборд для бота без канала

| Что | Что значит для VPN |
| :--- | :--- |
| Пользователи | все, кто хоть что-то сделал в боте |
| Входов в воронку | нажали `/start` или начали пробный период |
| Конверсия | покупатели ÷ все пользователи |
| По ссылкам | всегда 0 — у VPN нет рекламных ссылок канала |
| По UTM | пришли по UTM-ссылке |
| Без метки | пришли сами, по пересланной ссылке или по payload, который не метка |
| Топ-5 | лучшие UTM-метки по выручке |

Два блока к VPN не относятся:

- **Удержание 24/48 ч** на карточке качества считается по кампаниям канала;
- **экран «Приватки»** показывает только проекты с каналом.

Доля **«Без метки»** — главный индикатор. Если она внезапно выросла, а трафик по-прежнему идёт по UTM, — где-то перестала передаваться метка: проверьте ссылки в рекламе.

---

## Неполадки

| Что видно | Причина | Что делать |
| :--- | :--- | :--- |
| `401 Unauthorized` | неверный `ANALYTICS_API_KEY` | сверить с `API_SECRET` аналитики |
| `422 Cannot place event` | нет `botUsername` или он не совпадает с проектом | проверить шаг 1; вызван ли `setBotUsername` при старте |
| события попали в другой проект | тот же username записан у другого проекта | в реестре проектов у каждого бота — свой username |
| `ECONNREFUSED` / таймаут | бот не видит аналитику | `network_mode: host`; проверка из шага 2 |
| UTM-заход записан «без метки» | метки нет или она в другом проекте | ссылку брать из дашборда; при создании выбрать проект VPN |
| конверсия выглядит завышенной | бот не шлёт старт | `trackStart` в обработчике `/start` |
| второе событие не записалось | то же событие, тот же человек, та же секунда | это защита от дублей, так и задумано |
| на дашборде пусто | в шапке выбран другой проект или период | выбрать VPN, период «Все» |

---

## Чек-лист запуска

- [ ] В дашборде есть проект VPN с типом «Бот без канала» и верным username
- [ ] В `.env` VPN-бота заполнены `ANALYTICS_API_URL` и `ANALYTICS_API_KEY`
- [ ] Проверка `curl …/api/projects` из шага 2 показывает проект
- [ ] Бот при старте вызывает `setBotUsername` из `getMe`
- [ ] Старт, пробный период, оплата, продление, отписка — каждое отправляет своё событие
- [ ] Пробная покупка видна на дашборде с выбранным VPN
- [ ] Тестовые данные удалены, проект заведён заново
- [ ] UTM-метки созданы уже для чистого проекта, в рекламе — ссылки из дашборда
