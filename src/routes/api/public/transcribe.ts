import { createFileRoute } from "@tanstack/react-router";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-role, x-chunk-index",
  "Access-Control-Max-Age": "86400",
};

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB per chunk

export const Route = createFileRoute("/api/public/transcribe")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, { status: 204, headers: CORS_HEADERS }),

      POST: async ({ request }) => {
        const apiKey = process.env.LOVABLE_API_KEY;
        if (!apiKey) {
          return jsonError(500, "LOVABLE_API_KEY is not configured on the server");
        }

        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("multipart/form-data")) {
          return jsonError(400, "Expected multipart/form-data with a 'file' field");
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return jsonError(400, "Malformed multipart body");
        }

        const file = form.get("file") as unknown;
        if (!(file instanceof File) && !(file instanceof Blob)) {
          return jsonError(400, "Missing audio 'file' part");
        }
        const audio = file as Blob;
        if (audio.size === 0) {
          return jsonError(400, "Audio file is empty");
        }
        if (audio.size > MAX_BYTES) {
          return jsonError(413, `Audio chunk too large (>${MAX_BYTES} bytes)`);
        }

        const language = (form.get("language") as string) || "ru";
        const model =
          (form.get("model") as string) || "openai/gpt-4o-transcribe";

        const upstream = new FormData();
        upstream.append("model", model);
        upstream.append("language", language);
        upstream.append(
          "file",
          audio,
          (audio as File).name || "chunk.wav",
        );

        let providerResponse: Response;
        try {
          providerResponse = await fetch(
            "https://ai.gateway.lovable.dev/v1/audio/transcriptions",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}` },
              body: upstream,
            },
          );
        } catch (err) {
          return jsonError(
            502,
            `Upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const bodyText = await providerResponse.text();

        if (!providerResponse.ok) {
          return new Response(
            JSON.stringify({
              error: "provider_error",
              status: providerResponse.status,
              detail: safeParse(bodyText),
            }),
            {
              status: providerResponse.status,
              headers: {
                ...CORS_HEADERS,
                "content-type": "application/json",
              },
            },
          );
        }

        const parsed = safeParse(bodyText);
        const text =
          (parsed && typeof parsed === "object" && "text" in parsed
            ? (parsed as { text?: unknown }).text
            : undefined) ?? "";

        return new Response(JSON.stringify({ text }), {
          status: 200,
          headers: { ...CORS_HEADERS, "content-type": "application/json" },
        });
      },
    },
  },
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}