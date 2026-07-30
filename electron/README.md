# Realtime Transcriber — Windows desktop client

Electron-приложение, которое одновременно захватывает микрофон (HR) и
системный звук ПК (Кандидат), гоняет чанки через бэкенд-прокси этого
Lovable-проекта (`/api/public/transcribe` → Lovable AI
`openai/gpt-4o-transcribe`) и выводит живую расшифровку с ролями и
тайм-кодами. По остановке предлагает сохранить `.txt` и делает
автосохранение в `%APPDATA%/Realtime Transcriber/sessions/`.

## Разработка (нужен Node.js 20+)

```bash
npm install
npm run start:electron
```

## Прокси (без хардкода в коде)

1. Скопируйте шаблон:

```bash
cp electron/proxy.config.example.json electron/proxy.config.local.json
```

2. Впишите `host`, `port`, `username` и `password` в `electron/proxy.config.local.json`.
   Установите `"enabled": true` для активации прокси.
3. Приложение автоматически подхватит прокси при старте.

Приоритет загрузки конфига:

1. `RT_PROXY_CONFIG` (абсолютный путь к JSON-файлу),
2. `%APPDATA%\Realtime Transcriber\proxy.config.json` — **рекомендуется для установленного приложения**,
3. `electron/proxy.config.local.json` — только для разработки (не попадает в .exe).

> **Для установленного .exe** приложение больше **не читает** `proxy.config.example.json` из `app.asar`.
> Оно использует только `%APPDATA%\Realtime Transcriber\proxy.config.json`
> (или `RT_PROXY_CONFIG`). Если файла нет, приложение создаст шаблон в `%APPDATA%`.
> Откройте этот файл и заполните `username/password`.
> По умолчанию шаблон содержит placeholder-значения. Заполните `host`, `port`, `username`, `password` и установите `"enabled": true`.

Поддерживаются `http`, `https`, `socks5`, `socks5h`, а также авторизация через `username/password`:

- **SOCKS5/SOCKS4**: учётные данные **встраиваются** в URL прокси (`******host:port`).
  Это единственный способ передать авторизацию на уровне SOCKS-протокола — обработчик `login`-события
  Electron/Chromium для SOCKS не срабатывает.
- **HTTP/HTTPS**: учётные данные передаются через внутренний `app.on('login')` обработчик (ответ на 407).
  Встраивать их в URL **нельзя** — Chromium отвергает такие правила с ошибкой `ERR_NO_SUPPORTED_PROXIES`.

### socks5 vs socks5h

Если при `"protocol": "socks5"` возникает ошибка `net::ERR_NO_SUPPORTED_PROXIES`, попробуйте:

```json
{ "protocol": "socks5h" }
```

Разница:
- `socks5://` — hostname разрешается **локально** (на машине), затем IP передаётся прокси.
- `socks5h://` — hostname разрешается **на стороне прокси** (remote DNS).

Chromium в некоторых конфигурациях отвергает `socks5://` с `ERR_NO_SUPPORTED_PROXIES`, когда прокси требует
авторизацию или когда локальный DNS недоступен. Переключение на `socks5h://` решает эту проблему.

Приложение **автоматически** пробует `socks5h://` при `ERR_NO_SUPPORTED_PROXIES` в момент запуска,
чтобы не падать сразу — но лучше прописать нужный протокол в конфиге явно.

### Авто-режим (VPN) — `autoDirectFallback`

Параметр `"autoDirectFallback": true` включает следующую логику:

- Если прокси не работает (даёт `ERR_NO_SUPPORTED_PROXIES` / `ERR_PROXY_...`) →
  приложение переключается на **прямое подключение** (DIRECT), даже если пробный запрос вернул 403.
- Это полезно когда:
  - У вас есть **системный VPN** (WireGuard, OpenVPN, Windscribe, Mullvad и т.д.), который
    направляет трафик в обход гео-блокировки;
  - Прокси сервер недоступен, но VPN обеспечивает доступ к OpenAI напрямую.
  - При запуске приложение пробирует прямое соединение **до** того, как VPN успевает поднять маршрут —
    поэтому проба может вернуть 403, но реальные запросы во время записи уже пойдут через VPN.

В UI это переключается чекбоксом **«Авто (VPN)»** рядом с тогглом прокси. Настройка сохраняется в конфиге.

> **Если вы используете только системный VPN** (без отдельного прокси-сервера),
> рекомендуется выключить встроенный прокси (`"enabled": false`) и включить `autoDirectFallback` не нужно —
> просто оставьте прокси выключенным.

### Диагностика, если без VPN всё равно 403

1. Откройте **Системные логи** в приложении.
2. Найдите строки `[proxy] ...`:
   - `selected=...` — какой файл конфига реально выбран;
   - `enabled=true/false` — включён ли прокси в выбранном файле;
   - `applySucceeded=true/false` — применился ли прокси;
   - `resolved=...` — маршрут до OpenAI (`DIRECT` означает, что запрос идёт без прокси).
   - `rawSocketTest success=...` — прямая TCP-проверка до `host:port` прокси **в обход** Chromium
     (через Node `net`, как это делает `curl`/системные утилиты). Если `success=false`,
     а `curl -x ******host:port ...` с той же машины работает — значит именно
     процесс приложения (исполняемый файл `Realtime Transcriber`, на Windows — `.exe`)
     блокируется файрволом/антивирусом (частая практика — разрешать сеть по имени
     процесса), и его нужно добавить в исключения.
3. Если ошибки `[proxy] Network error for https://api.openai.com/...: net::ERR_...` —
   это точная причина от Chromium. Распространённые случаи:
   - `ERR_NO_SUPPORTED_PROXIES` — Chromium не поддерживает текущую конфигурацию прокси.
     Решение: смените `"protocol": "socks5"` на `"protocol": "socks5h"` (удалённый DNS),
     или проверьте, что учётные данные указаны верно. Приложение автоматически пробует
     `socks5h://` при запуске и сообщит об этом в логах.
   - `ERR_TUNNEL_CONNECTION_FAILED` — прокси доступен, но не пропустил CONNECT-тоннель;
     чаще всего неверный пароль или прокси не поддерживает HTTPS через CONNECT.
   - `ERR_PROXY_CONNECTION_FAILED` — прокси недоступен (неверный host/port, или закрыт).
4. Проверьте порядок приоритета конфига:
   1. `RT_PROXY_CONFIG`,
   2. `%APPDATA%/Realtime Transcriber/proxy.config.json`,
   3. `electron/proxy.config.local.json`,
   4. `electron/proxy.config.example.json`.
5. Если в более приоритетном файле прокси выключен, приложение покажет предупреждение
   в `[proxy]` логах и переключится на следующий валидный `enabled=true` конфиг.

В открывшемся окне:

1. Выберите микрофон (это будет **HR**).
2. Системный звук берётся автоматически (Windows loopback / любой аудиовыход,
   куда играет Яндекс Телемост).
3. При необходимости замените Backend URL (по умолчанию — опубликованный
   Lovable-проект).
4. **▶ Начать запись** → говорите → **■ Остановить** → сохраняете `.txt`.

## Сборка `.exe` под Windows

На Windows-машине:

```bash
npm install
npm run dist:win
```

Инсталлятор появится в `dist_electron/RealtimeTranscriber-Setup-<версия>.exe`.
Он создаёт ярлыки в меню Пуск и на рабочем столе.

> `electron-builder` умеет собирать Windows-таргет и из Linux/macOS, но самый
> надёжный вариант — сборка на Windows (не нужен wine).

## Как работает захват системного звука

Main-процесс регистрирует `setDisplayMediaRequestHandler` и отдаёт
`{ audio: "loopback" }`, поэтому `navigator.mediaDevices.getDisplayMedia`
в renderer сразу возвращает loopback-поток без выбора окна.
На старых Electron падает fallback через `desktopCapturer`.

## Требования

- Windows 10/11
- Стабильный интернет (запросы к Lovable AI)
- В Lovable-проекте настроен `LOVABLE_API_KEY` (делается автоматически)