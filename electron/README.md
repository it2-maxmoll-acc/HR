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

2. Заполните `password` в `electron/proxy.config.local.json`.
3. Приложение автоматически подхватит прокси при старте.

Приоритет загрузки конфига:

1. `RT_PROXY_CONFIG` (абсолютный путь к JSON-файлу),
2. `%APPDATA%\Realtime Transcriber\proxy.config.json` — **рекомендуется для установленного приложения**,
3. `electron/proxy.config.local.json` — только для разработки (не попадает в .exe).

> **Для установленного .exe** создайте файл
> `%APPDATA%\Realtime Transcriber\proxy.config.json`
> и скопируйте в него содержимое `proxy.config.example.json`,
> выставив `"enabled": true` и заполнив данные прокси.

Поддерживаются `http`, `https`, `socks5`, а также авторизация через
`username/password`.

### Диагностика, если без VPN всё равно 403

1. Откройте **Системные логи** в приложении.
2. Найдите строки `[proxy] ...`:
   - `selected=...` — какой файл конфига реально выбран;
   - `enabled=true/false` — включён ли прокси в выбранном файле;
   - `applySucceeded=true/false` — применился ли прокси;
   - `resolved=...` — маршрут до OpenAI (`DIRECT` означает, что запрос идёт без прокси).
3. Проверьте порядок приоритета конфига:
   1. `RT_PROXY_CONFIG`,
   2. `%APPDATA%/Realtime Transcriber/proxy.config.json`,
   3. `electron/proxy.config.local.json`,
   4. `electron/proxy.config.example.json`.
4. Если в более приоритетном файле прокси выключен, приложение покажет предупреждение
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