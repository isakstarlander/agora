const HTML = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <title>Agora API — Dokumentation</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Interaktiv dokumentation för Agora API — svensk politisk data" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css" />
  <style>
    body { margin: 0; }
    .swagger-ui .topbar { background: #1a1a2e; }
    .swagger-ui .topbar-wrapper img { display: none; }
    .swagger-ui .topbar-wrapper::before {
      content: 'Agora API';
      color: white;
      font-size: 1.2rem;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/api/v1/openapi',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
        deepLinking: true,
        tryItOutEnabled: true,
        requestInterceptor: (req) => {
          req.headers['X-Source'] = 'swagger-ui'
          return req
        },
      })
    }
  </script>
</body>
</html>`

export function GET() {
  return new Response(HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
