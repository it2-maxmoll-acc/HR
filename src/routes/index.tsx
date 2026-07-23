import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Realtime Transcriber — расшифровка HR-интервью на русском" },
      {
        name: "description",
        content:
          "Windows-приложение для реального времени: транскрибирует созвон с разделением по ролям HR / Кандидат. Работает с Яндекс Телемостом и любым другим приложением.",
      },
      { property: "og:title", content: "Realtime Transcriber для Windows" },
      {
        property: "og:description",
        content:
          "Онлайн-расшифровка HR-интервью на русском языке с разделением по ролям. Работает с любым десктопным видеозвонком.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm uppercase tracking-widest text-muted-foreground">
          Windows · Electron
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Realtime Transcriber
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Онлайн-расшифровка HR-интервью на русском языке. Одновременно
          захватывает микрофон и системный звук (Яндекс&nbsp;Телемост, Zoom,
          Google&nbsp;Meet — что угодно), показывает диалог в реальном времени с
          разделением на <strong>HR</strong> и <strong>Кандидата</strong> и
          сохраняет полный <code>.txt</code> с тайм-кодами.
        </p>

        <section className="mt-10 rounded-xl border border-border bg-card p-6">
          <h2 className="text-xl font-semibold">Как собрать под Windows</h2>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              На Windows-машине с установленным Node.js 20+ клонируйте этот
              проект.
            </li>
            <li>
              Выполните <code>npm install</code>.
            </li>
            <li>
              Запустите разработку:{" "}
              <code>npm run start:electron</code>.
            </li>
            <li>
              Соберите установщик <code>.exe</code>:{" "}
              <code>npm run dist:win</code>. Готовый файл появится в{" "}
              <code>dist_electron/</code>.
            </li>
          </ol>
        </section>

        <section className="mt-8 rounded-xl border border-border bg-card p-6">
          <h2 className="text-xl font-semibold">Что делает приложение</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>Выбор микрофона и источника системного звука.</li>
            <li>
              Кнопки <strong>Начать запись</strong> и{" "}
              <strong>Остановить</strong>.
            </li>
            <li>
              Реалтайм-лента: реплики HR и Кандидата с тайм-кодом{" "}
              <code>[MM:SS]</code>.
            </li>
            <li>
              Русская модель <code>gpt-4o-transcribe</code> с пунктуацией,
              числами, датами и именами.
            </li>
            <li>
              Автосохранение <code>.txt</code> в{" "}
              <code>%APPDATA%/RealtimeTranscriber</code> и ручной экспорт.
            </li>
          </ul>
        </section>

        <p className="mt-10 text-xs text-muted-foreground">
          Бэкенд-прокси к Lovable AI живёт по адресу{" "}
          <code>/api/public/transcribe</code> этого сайта.
        </p>
      </div>
    </main>
  );
}
