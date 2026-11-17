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
    ├── contact.js           # Formulario de contacto con etiqueta VIP
    ├── mindai.js            # Proxy de Gemini con cuota diaria VIP
    ├── ai-health.js         # Diagnóstico de Gemini
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

## Protecciones anti-spam

El correo de aviso se dispara cuando el usuario envía el formulario, así que
`api/notify-yape.js` aplica tres límites antes de enviar nada:

| Protección | Cómo funciona |
|---|---|
| **Idempotencia** | Al enviar se escribe `payment_requests/<id>/notifiedAt`. Si ya existe, no se repite el correo (aunque se llame 100 veces). |
| **Límite por cuenta** | Máximo **3 solicitudes por día** y **1 minuto** entre cada una. Se guarda en `payment_attempts/<uid>/<día>/<id>`, que el cliente no puede borrar. |
| **Código único** | `payment_codes/<código>` se crea una sola vez. Un código de Yape no puede registrarse dos veces. |
| **Rate limit por IP** | 5 solicitudes cada 10 minutos (protección básica adicional). |

Resultado: reenviar la misma solicitud no genera correos, crear solicitudes en masa
se corta a las 3 por cuenta, y reutilizar códigos se rechaza con un mensaje claro.

> Después de actualizar el proyecto hay que **volver a publicar** `firebase-rules.json`,
> porque incluye los nodos nuevos `payment_codes`, `payment_attempts`, `contact_attempts` y `notifiedAt`.

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
| `CONTACT_NOTIFY_EMAIL` | `mindstackn7@gmail.com` | No (usa `PAYMENT_NOTIFY_EMAIL`) |
| `CONTACT_FROM_EMAIL` | `MindStack Soporte <onboarding@resend.dev>` | No (usa `PAYMENTS_FROM_EMAIL`) |
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

### Notas y watchlist por cuenta

Cada cuenta guarda sus notas y su watchlist en `users/<uid>` y en claves locales
propias (`mindstack_notes_<uid>` y `mindstack_watchlist_<uid>`). Al cerrar sesión
se borran esas claves locales y la interfaz vuelve a los valores por defecto, así
que una cuenta nueva nunca hereda los datos de la anterior (incluido el caso de
registrarse desde una sesión anónima, donde Firebase conserva el mismo UID).

El **fondo personalizado VIP** funciona igual: se guarda en `mindstack_bg_<uid>`.
Al cambiar de cuenta se carga el fondo de esa cuenta (o el original si no tiene),
y al cerrar sesión se borra la clave y se vuelve al fondo por defecto. Además se
añade un parámetro `v=<timestamp>` a la URL para que el navegador no muestre una
imagen vieja en caché.

### Estadísticas de visitas (VIP)

El widget **📊 Análisis Gráfico de tus Visitas** ya no usa porcentajes de ejemplo:
se calcula con actividad real de la cuenta, guardada en `mindstack_stats_<uid>`.

| Dato | Cómo se registra |
|---|---|
| **Visitas** | Cada carga de la web o regreso a la pestaña, con un máximo de 1 visita cada 10 minutos. |
| **Racha** | Días consecutivos con al menos una visita, sesión de enfoque o mensaje a MindAI. |
| **Enfoque** | Cada bloque de 25 minutos del pomodoro que termina mientras la app está abierta. |
| **MindAI** | Cada respuesta exitosa del chat. |
| **Bloques horarios** | Se agrupan las visitas, sesiones de enfoque y mensajes por madrugada, mañana, tarde y noche. |

Los eventos se conservan 90 días (máximo 400 visitas / 200 sesiones / 400 mensajes)
y cada cuenta solo ve los suyos. Las estadísticas son locales a ese navegador; si el
usuario entra desde otro dispositivo, empezará a acumular desde cero.

### Soporte VIP desde la página Equipo

La página **Equipo** incluye el formulario "Contáctate con MindStack". Al enviarlo,
`api/contact.js` manda el mensaje a `CONTACT_NOTIFY_EMAIL`:

- Si la cuenta tiene `isVip: true`, el asunto empieza con **`[VIP]`** y el correo
  muestra la etiqueta **Usuario VIP** para atenderlo primero.
- Aplica honeypot, 5 mensajes por IP cada 15 minutos y, cuando las reglas están
  publicadas, 5 mensajes por cuenta al día con 30 segundos entre cada uno
  (`contact_attempts/<uid>/<día>/<id>`).
- El botón de responder usa el correo que escribió el usuario (`reply_to`).
- Si el envío falla, la web ofrece un enlace `mailto:` con el mensaje ya redactado.

## MindAI (tutor con Gemini)

MindAI usa un proxy en `api/mindai.js`. La clave de Gemini **nunca** está en el HTML:
el navegador envía el mensaje + su ID token de Firebase y la función hace la llamada.

- **Solo usuarios VIP** (`users/<uid>/isVip === true`) pueden usar el chat.
- Cada usuario tiene `AI_DAILY_LIMIT` mensajes por día (30 por defecto).
- La cuota se guarda en `ai_usage/<uid>/<día>/<idMensaje>`; el cliente no puede borrarla
  ni reiniciarla, así que el límite no se puede saltar desde el navegador.
- La cuota se reinicia a medianoche de Perú (UTC-5).
- Las respuestas son **cortas** (máximo 60 palabras / 180 tokens) para que Gemini
  conteste rápido y no se corte por el límite de tiempo de Vercel.
- Si el modelo configurado ya no existe o está saturado, se prueba automáticamente
  con otro modelo Flash (ver `PRIMARY_MODEL` y `FALLBACK_MODEL` en `api/mindai.js`).

### Variables de entorno en Vercel

| Variable | Ejemplo | Obligatoria |
|---|---|---|
| `GEMINI_API_KEY` | `AIza...` | Sí |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | No |
| `AI_DAILY_LIMIT` | `30` | No |

Obtén la clave gratis en https://aistudio.google.com/apikey (activando facturación
tienes más cuota y Google no usa tus datos para entrenar). Si cambias
`AI_DAILY_LIMIT`, actualiza también `MINDAI_DAILY_LIMIT` en `index.html` para que
el contador de la interfaz coincida.

> El plan gratuito de Gemini tiene un límite bajo y compartido: con varios usuarios
> activos conviene activar facturación y poner una alerta de presupuesto en Google Cloud.

## Pruebas locales

Abre `index.html` con un servidor estático (Live Server, `npx serve`, etc.).
Las funciones `/api/notify-yape`, `/api/contact` y `/api/mindai` solo existen al
desplegar en Vercel; en local el pago y el contacto avisan que no se pudo enviar el
correo automático.

## Seguridad

- El VIP nunca se activa desde el navegador: solo el administrador en Firebase.
- Verifica siempre el código de operación en la app de Yape (las capturas se pueden editar).
- Un código de operación debe usarse una sola vez.
- No compartas tu PIN de Yape ni aceptes enlaces de terceros.
