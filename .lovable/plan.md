
# Real-time транскрипция созвонов (Windows, Electron + Lovable AI)

## Что получится

Windows-приложение (`.exe` установщик), которое:
- Одновременно захватывает **микрофон** (речь HR) и **системный звук** (речь Кандидата из Яндекс Телемоста или любого другого приложения).
- Разрезает оба потока на короткие аудио-окна (~2–3 с) и отправляет в бэкенд.
- Бэкенд проксирует чанки в Lovable AI (`openai/gpt-4o-transcribe`) с русским языком, пунктуацией, числами и именами.
- Показывает живую расшифровку в отдельном окне с ролями **HR** и **Кандидат**, тайм-кодами относительно старта записи.
- По кнопке «Остановить» сохраняет `.txt` файл с полной расшифровкой и тайм-кодами.

## Архитектура

```text
┌──────────────────────────── Electron .exe (Windows) ─────────────────────────┐
│  Main process (main.cjs)                                                     │
│    • создаёт окна, меню, IPC, диалог сохранения .txt                         │
│    • enum устройств через desktopCapturer                                    │
│                                                                              │
│  Renderer (index.html + app.js)                                              │
│    • UI: [▶ Начать] [■ Остановить] [Микрофон ▾] [Системный звук ▾]           │
│    • getUserMedia(mic) — поток HR                                            │
│    • getUserMedia({chromeMediaSource:'desktop'}) — loopback (Кандидат)       │
│    • AudioWorklet → 16 kHz mono PCM → окно 2.5 c → WAV blob                 │
│    • fetch POST /api/public/transcribe  (role, chunk_index, wav)             │
│    • читает JSON { text }, дописывает в живой лог по ролям                   │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │ HTTPS
                                    ▼
┌──────────── Lovable TanStack Start (этот проект, публично опубликован) ──────┐
│  src/routes/api/public/transcribe.ts (POST)                                  │
│    • CORS для Electron origin                                                │
│    • multipart: file (wav), role, chunk_index                                │
│    • переупаковывает в multipart и вызывает                                  │
│      POST https://ai.gateway.lovable.dev/v1/audio/transcriptions             │
│      model=openai/gpt-4o-transcribe, language=ru                             │
│    • возвращает { text }                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

Бэкенд-прокси нужен потому, что `LOVABLE_API_KEY` — серверный секрет и не может лежать внутри Electron сборки.

## Основные детали

### Захват аудио (внутри Chromium в Electron)
- **Микрофон:** `navigator.mediaDevices.getUserMedia({ audio: { deviceId } })`.
- **Системный звук (Windows loopback):** `desktopCapturer.getSources({ types: ['screen'] })` → `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } }, video: false })`. Работает в Electron с любым desktop-приложением, включая Яндекс Телемост.
- Оба потока идут в отдельные `AudioContext(16000)` → `AudioWorkletNode`, который копит Float32 → каждые ~2.5 с формируется WAV (16-bit PCM, mono, 16 kHz) с ~0.4 с перекрытием, чтобы не резать слова.
- Каждый чанк отправляется параллельно; порядок восстанавливается по `chunk_index`.

### Разделение ролей
- Микрофонный поток всегда помечается `role="HR"`, системный — `role="Кандидат"`. Роли не смешиваются, поэтому диаризация не нужна.
- На старте UI пересобирает live-лог как список сообщений `{ role, ts, text }`, отсортированных по времени старта чанка.

### Бэкенд-прокси (в этом Lovable проекте)
Файл `src/routes/api/public/transcribe.ts` — публичный `/api/public/*` роут (Electron origin получает CORS: `*`, метод POST + OPTIONS).
Внутри:
```ts
const upstream = new FormData();
upstream.append("model", "openai/gpt-4o-transcribe");
upstream.append("language", "ru");
upstream.append("file", audio, "chunk.wav");
const r = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.LOVABLE_API_KEY}` },
  body: upstream,
});
```
Проверка размера (<1 МБ на чанк), таймаут, аккуратная передача статуса/ошибки клиенту (402 → «Закончились кредиты», 429 → «Слишком часто, повтор»).

### UI (окно транскрипции)
- Верхняя панель: селект микрофона, селект системного источника, кнопки **Начать запись** / **Остановить**, индикатор состояния и таймер.
- Основная область: лента сообщений, слева бейдж `HR` (синий) или `Кандидат` (зелёный), тайм-код `[00:12]`, текст. Новые сообщения плавно доскроллены вниз.
- Индикатор ошибок сети/API вверху, кнопка «Сохранить сейчас» доступна и во время записи.

### Сохранение расшифровки
- По кнопке «Остановить» (и автоматически) main process открывает `dialog.showSaveDialog` со стандартным именем `Транскрипция_YYYY-MM-DD_HH-MM.txt`.
- Формат:
  ```
  Транскрипция встречи — 2026-07-23 14:05
  
  [00:00] HR: Здравствуйте, меня зовут ...
  [00:04] Кандидат: Добрый день, спасибо ...
  ```
- Копия автосохраняется в `%APPDATA%/RealtimeTranscriber/sessions/` после каждой остановки, чтобы ничего не терялось.

### Упаковка (.exe установщик)
- `electron` + `electron-builder` (NSIS target).
- `package.json` -> `build.win.target: nsis`, иконка приложения, product name «Realtime Transcriber».
- Отдельный скрипт `npm run dist:win` создаёт установщик в `dist_electron/`.
- Установщик кладёт ярлык в меню Пуск и на рабочий стол; приложение при первом запуске запрашивает разрешение на микрофон средствами Windows.

## Файловая структура (что добавится)

```
electron/
  main.cjs               # окно, IPC, save dialog, desktopCapturer перечисление
  preload.cjs            # contextBridge → безопасное API для renderer
  renderer/
    index.html
    styles.css
    app.js               # UI, стейт-машина записи, лог сообщений
    audio-capture.js     # AudioWorklet + WAV энкодер + отправка чанков
    worklet-processor.js
  build/
    icon.ico
package.json             # + electron, electron-builder, скрипты dist:win
electron-builder.yml

src/routes/api/public/transcribe.ts   # прокси в Lovable AI (в этом проекте)
```

Web-часть Lovable проекта (страница `/`) станет короткой landing-страницей с описанием приложения и кнопкой «Скачать для Windows» (ссылка на собранный `.exe`).

## Ограничения, о которых стоит знать заранее

- **Задержка**: gpt-4o-transcribe возвращает окно за ~0.5–1.5 с. При окне 2.5 с суммарная задержка «сказано → показано» ~3 с. Это самое быстрое, что даёт этот движок; если нужна «живая строка» с задержкой <1 с — понадобится другой STT (SpeechKit streaming или Deepgram Nova).
- **Сборка .exe**: инсталлятор собирается через `electron-builder` на локальной Windows-машине (или Windows CI). В песочнице Lovable собрать финальный `.exe` с подписью нельзя, но исходники и скрипт `npm run dist:win` будут готовы — вам достаточно запустить его на любой Windows-машине с Node.js.
- **Кредиты Lovable AI**: каждая минута разговора ≈ 2 запроса × 60 = ~48 запросов транскрипции в минуту (2 потока × 24 окна). Долгие интервью съедают заметно кредитов — стоит держать это в виду.

## Порядок реализации (шаги в build mode)

1. Добавить `src/routes/api/public/transcribe.ts` + CORS + прокси в Lovable AI, проверить `curl`-ом.
2. Обновить `src/routes/index.tsx` — простая страница «Скачать Realtime Transcriber для Windows».
3. Создать `electron/` со всем UI и захватом аудио, `preload.cjs` с безопасным IPC.
4. Настроить `package.json` (electron, electron-builder, скрипты `start:electron`, `dist:win`) и `electron-builder.yml` (NSIS, иконка).
5. Локальная проверка `npm run start:electron` в песочнице (headless, без звука) — только smoke-тест, что окна поднимаются и IPC работает.
6. Инструкция в `README.md`: как запустить `npm run dist:win` на Windows, где лежит `.exe`.
