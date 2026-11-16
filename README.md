# Proyecto MindStack

Web de bienestar y productividad para estudiantes del COAR.
Ahora incluye **MindStack Premium** con pago manual por **Yape**.

## Estructura

```
.
├── index.html               # Web completa (SPA)
├── images/                  # Imágenes y QR de Yape
├── firebase-rules.json      # Reglas de seguridad para Realtime Database
└── api/
    ├── notify-yape.js       # Función serverless que avisa el pago por correo
    └── package.json
```

## Cómo funciona el pago con Yape

1. El usuario (con cuenta registrada) abre **Obtener Premium → Pagar S/5 con Yape**.
2. Yapea el monto exacto y copia su **código de operación**.
3. Envía el formulario. La web guarda la solicitud en `payment_requests` y llama a `/api/notify-yape`.
4. Llega un correo de aviso a `mindstackn7@gmail.com`.
5. El equipo verifica el pago en la app de Yape.
6. En Firebase se activa manualmente el VIP (`isVip: true`).
7. La web lo detecta en tiempo real y desbloquea los beneficios.

> Yape no tiene API ni webhooks públicos: el correo se envía cuando el usuario registra su pago, no en el instante en que entra el dinero. La validación siempre es manual.

## Configuración pendiente (importante)

### 1. Datos de Yape (ya configurados)

En `index.html`, dentro del `<script>`:

```js
const YAPE_NUMBER = "962 123 947"; // número real de Yape
const YAPE_AMOUNT = 5;             // S/ 5.00
```

Si `YAPE_NUMBER` queda vacío, el modal oculta el número y solo muestra el QR
(así nunca se muestra un número de ejemplo por error).

El QR está en:

```
images/yape-qr.png   (640x640, cuadrado)
```

Para cambiarlo, reemplaza ese archivo manteniendo el nombre. Si falta, el modal
muestra un recuadro de aviso en lugar de una imagen rota.

### 2. Reglas de Firebase

Copia el contenido de `firebase-rules.json` en:

**Firebase Console → Realtime Database → Reglas → Publicar**

Esto impide que un usuario se active el VIP por su cuenta y limita `payment_requests`
a creaciones propias. El administrador sí puede editar `isVip` desde la consola.

### 3. Correo con Resend

1. Crea una cuenta en https://resend.com
2. Genera una **API Key**.
3. En Vercel → Project → Settings → Environment Variables agrega:

| Variable | Ejemplo | Obligatoria |
|---|---|---|
| `RESEND_API_KEY` | `re_xxxxxxxxx` | Sí |
| `PAYMENT_NOTIFY_EMAIL` | `mindstackn7@gmail.com` | Sí |
| `PAYMENTS_FROM_EMAIL` | `MindStack Pagos <onboarding@resend.dev>` | Sí |
| `FIREBASE_DB_URL` | `https://mindstack-6749c-default-rtdb.firebaseio.com` | No |
| `ALLOWED_ORIGIN` | `https://mindstackcoar.vercel.app` | Recomendada |

Sin un dominio verificado en Resend, usa `onboarding@resend.dev` como remitente:
solo podrá enviar al correo dueño de la cuenta Resend (tu Gmail).

### 4. Activar el VIP manualmente en Firebase

En `users/<uid>`:

```
isVip: true
vipPlan: "yape"
vipSince: 1730000000000
lastYapeCode: "12345678"
```

`vipExpiresAt` no se usa porque el VIP es permanente.

## MindAI (tutor con Gemini)

MindAI usa un proxy en `api/mindai.js`. La clave de Gemini **nunca** está en el HTML:
el navegador envía el mensaje + su ID token de Firebase y la función hace la llamada.

- **Solo usuarios VIP** (`users/<uid>/isVip === true`) pueden usar el chat.
- Cada usuario tiene `AI_DAILY_LIMIT` mensajes por día (30 por defecto).
- La cuota se guarda en `ai_usage/<uid>/<día>/<idMensaje>`; el cliente no puede borrarla
  ni reiniciarla, así que el límite no se puede saltar desde el navegador.
- La cuota se reinicia a medianoche de Perú (UTC-5).

### Variables de entorno en Vercel

| Variable | Ejemplo | Obligatoria |
|---|---|---|
| `GEMINI_API_KEY` | `AIza...` | Sí |
| `GEMINI_MODEL` | `gemini-2.5-flash` | No |
| `AI_DAILY_LIMIT` | `30` | No |

Obtén la clave gratis en https://aistudio.google.com/apikey (activando facturación
tienes más cuota y Google no usa tus datos para entrenar). Si cambias
`AI_DAILY_LIMIT`, actualiza también `MINDAI_DAILY_LIMIT` en `index.html` para que
el contador de la interfaz coincida.

> El plan gratuito de Gemini tiene un límite bajo y compartido: con varios usuarios
> activos conviene activar facturación y poner una alerta de presupuesto en Google Cloud.

## Pruebas locales

Abre `index.html` con un servidor estático (Live Server, `npx serve`, etc.).
La función `/api/notify-yape` solo existe al desplegar en Vercel; en local el pago
se guarda en Firebase y la web avisa que no se pudo enviar el correo automático.

## Seguridad

- El VIP nunca se activa desde el navegador: solo el administrador en Firebase.
- Verifica siempre el código de operación en la app de Yape (las capturas se pueden editar).
- Un código de operación debe usarse una sola vez.
- No compartas tu PIN de Yape ni aceptes enlaces de terceros.
