# TG Analytics — Документация интеграции (API Contract)

Руководство для разработчиков сторонних Telegram-ботов (например, VPN-сервисов, платных подписок и SaaS-ботов) по интеграции с платформой аналитики `TG Analytics`.

---

## 1. Как получить `linkId` для отслеживания

1. **Создание ссылки**:
   - В Telegram-боте аналитики через команду `/menu` (или `/newlink`) выберите ваш проект с типом `bot_subscription`.
   - Бот выдаст готовый deep-link вида:
     `https://t.me/vpn_bot_username?start=payload` (где `payload` — это уникальный реферальный код кампании, например `ad_12_msgna49u`).

2. **Первое событие и Атрибуция по последнему касанию (Last-Touch)**:
   - При первом входе пользователя по deep-link передайте событие `lead` или `trial_start` с указанием `linkId`.
   - Для всех **последующих событий** этого пользователя (оплата `payment`, продление `renewal`, отмена `churn`) передавать `linkId` **необязательно**: система автоматически привяжет их к последней ссылке касания пользователя (`Last-Touch`).

---

## 2. Контракт `POST /api/events`

Все целевые события передаются в аналитику с помощью HTTP POST-запроса на `/api/events`.

### Заголовки (Headers)
| Заголовок | Значение | Описание |
| :--- | :--- | :--- |
| `Content-Type` | `application/json` | Формат тела запроса |
| `X-API-Key` | `secret_tg_analytics_key_...` | Секретный ключ авторизации (выдаётся администратором) |

### Параметры тела (JSON Body)
| Поле | Тип | Обязательность | Описание |
| :--- | :--- | :--- | :--- |
| `linkId` | `number` | *Частично опционально* | **Обязательно для первого события пользователя**, опционально для последующих (определится автоматически по Last-Touch) |
| `tgUserId` | `string` | **Обязательно** | Уникальный числовой Telegram User ID пользователя |
| `eventType` | `string` | **Обязательно** | Название типа события из словаря (см. ниже) |
| `amount` | `number` | *Опционально* | Сумма операции в USD (обязательно для финансовых событий) |

---

### Атрибуция по последнему касанию (Last-Touch Attribution)

1. **Первое касание нового пользователя**:
   - Запрос **ОБЯЗАТЕЛЬНО** должен содержать `linkId`.
   - Если отправить событие для нового `tgUserId` без `linkId`, сервер вернет ошибку `HTTP 422 Unprocessable Entity`:
     `{"error": "Cannot attribute event: no prior touch found for tgUserId <id>. First event for a new user must include linkId."}`.

2. **Последующие события без `linkId`**:
   - При отправке событий (`trial_start`, `payment`, `renewal`, `churn`) без поля `linkId`, система запрашивает последнее событие данного `tgUserId`, сортируя по `ts DESC LIMIT 1`, и автоматически связывает запись с последним `linkId`.

3. **Смена источника (Re-engagement / Повторный переход)**:
   - Если пользователь позже переходит по новой рекламной ссылке `linkId=B` (событие `lead`), все последующие целевые действия без `linkId` автоматически переключаются на кампанию `B`.

---

### Словарь типов событий (`eventType`)

| `eventType` | Описание | Обязательность `amount` | Влияние на метрики |
| :--- | :--- | :--- | :--- |
| `lead` | Пользователь запустил бота по deep-link (`/start`) | Нет | Вход в воронку (увеличивает `subs`) |
| `trial_start` | Активация бесплатного пробного периода (триала) | Нет | Вход в воронку (увеличивает `subs`) |
| `payment` | Первая успешная оплата подписки | **Да** (`amount > 0`) | Увеличивает выручку кампании (`revenue`) |
| `renewal` | Регулярное продление автоподписки | **Да** (`amount > 0`) | Увеличивает выручку кампании (`revenue`) |
| `churn` | Отмена подписки / отток | Нет | Учитывается в аналитике LTV / Churn |

---

### Примеры cURL для каждого типа события

#### 1. Первичный запуск / Лид с `linkId` (`lead`)
```bash
curl -X POST http://YOUR_SERVER_HOST:3000/api/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: secret_tg_analytics_key_9f8e7d6c5b4a3210" \
  -d '{
    "linkId": 6,
    "tgUserId": "777000123",
    "eventType": "lead"
  }'
```

#### 2. Активация триала без `linkId` (`trial_start`)
```bash
curl -X POST http://YOUR_SERVER_HOST:3000/api/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: secret_tg_analytics_key_9f8e7d6c5b4a3210" \
  -d '{
    "tgUserId": "777000123",
    "eventType": "trial_start"
  }'
```

#### 3. Первая оплата без `linkId` (`payment`)
```bash
curl -X POST http://YOUR_SERVER_HOST:3000/api/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: secret_tg_analytics_key_9f8e7d6c5b4a3210" \
  -d '{
    "tgUserId": "777000123",
    "eventType": "payment",
    "amount": 299
  }'
```

#### 4. Продление подписки без `linkId` (`renewal`)
```bash
curl -X POST http://YOUR_SERVER_HOST:3000/api/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: secret_tg_analytics_key_9f8e7d6c5b4a3210" \
  -d '{
    "tgUserId": "777000123",
    "eventType": "renewal",
    "amount": 299
  }'
```

#### 5. Отмена подписки без `linkId` (`churn`)
```bash
curl -X POST http://YOUR_SERVER_HOST:3000/api/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: secret_tg_analytics_key_9f8e7d6c5b4a3210" \
  -d '{
    "tgUserId": "777000123",
    "eventType": "churn"
  }'
```

---

## 3. Ограничения и особенности поведения

1. **Rate Limiting**:
   - На данный момент лимиты на количество запросов в секунду (Rate Limit) отсутствуют.

2. **Идемпотентность и защита от дублей**:
   - База данных содержит уникальный индекс по комбинации `(linkId, tgUserId, eventType, ts)`.
   - При повторной отправке идентичного запроса в рамках одной секунды сервер не задвоит запись и вернет корректную обработку.
