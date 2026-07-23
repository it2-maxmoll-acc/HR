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