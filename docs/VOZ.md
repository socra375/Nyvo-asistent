# Voz y orbe de Nyvo

La pantalla principal es **solo el orbe**: un grafo de red en 3D que gira sobre sí mismo y respira, cuyos cuatro clústeres son los hemisferios del cerebro de Nyvo (diseñado a partir de la referencia que dio el dueño: borde naranja denso a la izquierda, nodos azules a la derecha, rosa en el centro, núcleo turquesa con anillo). El panel completo (clientes, Drive, Notion, trabajos, chat) está a un toque en «Panel».

## El cerebro vive dentro de Nyvo
- `brain/nyvo_core_system.md` es el documento del cerebro (copia exacta del que entregó el dueño). Se incrusta al compilar (`npm run build:brain` → `server/agents/brain.generated.ts`), así que no depende de archivos en tiempo de ejecución. Una prueba falla si el `.md` y la copia generada difieren.
- El prompt del agente principal es: **cerebro + reglas de la plataforma + especialistas + estilo + seguridad**. Las reglas de la plataforma (`server/agents/brain.ts`) van *después* y prevalecen si el documento las contradice.
- **Dónde el código prevalece sobre el documento (decisión de seguridad, revisable):**
  1. *Rose no responde sola a clientes*: prepara la respuesta y el dueño la confirma en tarjeta (el documento dice «automático»).
  2. *Sin «asimilar» habilidades en el prompt base*: las habilidades llegarán en la fase 2 como datos no confiables, fijadas a un commit y con tarjeta de aprobación.
  3. Notas con correo o teléfono de un cliente en Notion piden tarjeta (`datos_personales`, además de una detección por patrón en el código).
- Hemisferios ↔ herramientas reales: Rose = conversaciones de AINova; Johan = clientes, proyectos, cobros y facturas; Mia = agenda y formularios (Google Calendar/Forms llegan en la fase 3: la sección existe, aún sin herramientas); Nyvo = Notion, Drive y memoria.

## Las cuatro secciones
Cada hemisferio es un clúster con su color: **Johan** naranja (casquete denso en filas curvas, a la izquierda), **Mia** azul (derecha), **Rose** rosa (centro) y **Nyvo** amarillo, turquesa y lavanda (los hubs). Los *hubs* grandes llevan el nombre de lo que conectan (Clientes, Cobros, Agenda, Notion, Drive, Memoria…): son la estructura, no datos del negocio. El orbe **gira 360° de forma continua** (una vuelta en unos 20 s en reposo): el casquete naranja y el azul se cruzan de lado a lado y las etiquetas se desvanecen al pasar por detrás. Una sección se enciende (sus nodos y aristas internas brillan y sus señales viajan por la red) cuando su hemisferio trabaja: el servidor emite eventos por `POST /api/chat/stream` (NDJSON: `pensando`, `hemisferio {id, estado}`, `fin`/`error`). Pensando sin herramienta, el brillo recorre los cuatro clústeres.

Estados: **reposo** (giro lento), **escuchando** (el orbe «inhala»: se recoge un poco con tu voz, entran anillos lentos hacia el núcleo y el tono es frío), **pensando** (giro más rápido, muchas señales por las aristas), **hablando** (el orbe «exhala»: se expande suavemente con la voz de Nyvo, salen anillos lentos del núcleo y el tono se vuelve cálido). En ambos casos el nivel de audio se suaviza mucho (sube en ~0,2 s y baja en ~0,5 s) y mueve al orbe entero como un cuerpo, nunca nodo por nodo, para que no «tiemble». Con `prefers-reduced-motion` el movimiento, las señales y las ondas se atenúan; en pantallas pequeñas hay menos nodos. Un dibujo no es una captura: parecerse «exactamente» a la referencia es una aproximación, no una copia píxel a píxel.

## Una sola voz, sin nombrar las partes
Nyvo habla como una persona: no dice «Johan me informa que…», ni «en la sección de clientes», ni de qué sistema salió el dato, salvo que se lo preguntes o haga falta para actuar (por ejemplo, dónde guardó una nota). Se aplica en tres sitios: una regla explícita con ejemplos «Mal/Bien» en las reglas de la plataforma, una instrucción a los especialistas para que devuelvan el dato sin presentarlo, y un filtro (`server/agents/persona.ts`) que quita etiquetas `[JOHAN]:`, rótulos de línea y los giros «X me informa que» / «Según X,». El filtro cubre lo evidente; la prosa libre depende del modelo, así que **no se puede garantizar al 100 %**.

## Mientras trabaja, y cuando responde
- El estado «pensando» muestra lo que hace, sin nombres internos: «Consultando tus clientes y cobros…», «Revisando tu agenda…».
- Si la espera pasa de ~0,9 s con una herramienta en marcha y la voz está activada, dice una frase corta («Un momento, lo reviso.»); si la respuesta llega mientras suena, espera a que termine (máx. 2,5 s) antes de leerla.
- **Voz:** interruptor en la esquina (se recuerda). Con la voz activada, la respuesta se lee **también cuando la pides por teclado**; antes solo salía el texto. Si falla la síntesis, el error aparece en pantalla en vez de quedarse en silencio.

## Conversación por voz (manos libres)
```
inactivo ─tocar→ escuchando ─frase→ pensando ─respuesta→ hablando ─fin→ escuchando
                     ▲                 │                      │
                     └──── el usuario habla encima: se corta la voz ◀┘
```
- **Captura:** `getUserMedia` con cancelación de eco, ruido y ganancia; AudioWorklet (`web/public/capture-worklet.js`, mismo origen por la CSP). Un anillo de pre-grabación de 0,5 s evita perder el inicio de la frase.
- **VAD** (`web/src/voice/vad.ts`): energía con suelo de ruido adaptativo, histéresis y 0,75 s de silencio para cerrar. Calibra 0,4 s al abrir el micrófono; un zumbido constante no cuenta como voz.
- **Interrupción (barge-in):** mientras Nyvo habla, el umbral sube ×2,4 y la voz debe sostenerse 170 ms; entonces se corta lo que suena **y** las síntesis en camino, y se empieza a grabar la nueva frase.
- **STT:** WAV de 16 kHz mono a `/api/voice/stt` (Gemini).
- **Respuesta:** `voice: true` pide respuestas de 2–3 frases cortas, sin markdown ni cifras con símbolos. Se trocea en frases (la primera corta) y se sintetizan por adelantado mientras suena la anterior (`/api/voice/tts`, 90 peticiones/min).
- **Confirmaciones solo con toque**: nunca por voz (una frase captada del ambiente no puede aprobar un cambio).
- Teclado y subtítulos son controles de esquina. El texto escrito solo se lee en voz alta si la conversación por voz está activa.

## Latencia: lo que se promete y lo que no
Este diseño es por turnos (STT → texto → TTS por frases). La latencia hasta el primer sonido es la suma de: cierre de frase (0,75 s) + transcripción + el modelo + primera síntesis. **No está medida con servicios reales** (la sesión de desarrollo no llega a Gemini), y lo normal será de 2 a 4 s, no menos de 1 s. Para bajar de 1 s de verdad hace falta la **API Live de Gemini** por WebSocket (audio en ambos sentidos con VAD del lado del servidor); es una fase aparte porque exige un canal persistente que las funciones de Vercel (60 s) no ofrecen y un token efímero por sesión para no exponer la clave.

## Lo probado y lo no probado
- **Pruebas unitarias** (VAD con señales sintéticas, WAV, pre-roll, troceado, cola con prefetch y corte inmediato, máquina de estados, grafo, geometría y dinámica del orbe) y de servidor (cerebro sincronizado, prompt, hemisferios, NDJSON, datos personales).
- **Chromium real** con un WAV como micrófono falso (dos frases; la segunda cae sobre la voz de Nyvo): escucha → transcribe → responde con datos → habla → se deja interrumpir → vuelve a responder. También: el canvas se pinta con los colores naranja, azul y rosa, se mueve, las cuatro secciones, una acción con tarjeta sin ejecutarse hasta confirmar, y móvil sin desplazamiento.
- **No probado:** micrófono y altavoces reales, el eco real (el micrófono falso no oye la voz de Nyvo, así que la cancelación de eco y los umbrales de interrupción hay que afinarlos en un equipo real), Gemini real, rendimiento del canvas en móviles reales.

## Cuando algo falla: Nyvo no se queda mudo ni sordo
- **Voz del servidor → voz del navegador.** Si `/api/voice/tts` falla (cuota de Gemini o ElevenLabs agotada, clave, caída, red), esa frase se lee con la síntesis del navegador y, si el fallo es del proveedor, se deja de insistir con el servidor durante 1 min (no se gasta un viaje por frase ni se mezclan dos voces). Una frase que el proveedor rechaza por sí misma (400, 413…) se lee con el navegador pero no apaga el servidor. El aviso («La voz de Nyvo no respondió: uso la del navegador por un momento») sale una vez por sesión y el error crudo del proveedor no se muestra. Una interrupción del usuario (barge-in) no cuenta como fallo.
- **Errores en claro.** El servidor traduce el fallo del proveedor: Gemini TTS (429 cuota, 401/403 clave o modelo, 404 modelo inexistente, 5xx caída) y ElevenLabs (créditos, clave, plan de pago, voz inexistente, límite). Antes, un fallo de Gemini TTS salía como «motores de IA caídos» con el detalle crudo.
- **Reintentos solo de lo pasajero.** Una caída 5xx, un fallo de red o un modelo de voz que contesta texto en vez de audio se reintentan una vez; una cuota o una clave mala no (no se arreglan en un segundo). Cada llamada tiene un plazo de 20 s para no quedarse colgada hasta el corte de 60 s de Vercel.
- **ElevenLabs:** modelo `eleven_flash_v2_5` por defecto (español, el más rápido y la mitad de créditos que Multilingual v2; `ELEVENLABS_MODEL_ID` lo cambia), pista de idioma `es` (si el modelo no la admite se repite sin ella) y entonación menos plana (`stability 0.45`, `similarity_boost 0.8`, `style 0.15`).
- **Transcripción con respaldo.** Groq (Whisper) y Gemini se respaldan entre sí: si el elegido falla (cuota, caída, red, o un audio que su decodificador no acepta) se prueba el otro si tiene clave. Con `STT_PROVIDER` fijado no hay segundo intento. La transcripción de Gemini también pide el «pensar» mínimo (era lo más lento de la escucha). Si fallan los dos, el error dice cuál y por qué, sin detalles crudos.

**Probado:** pruebas unitarias de todo lo anterior con servidores simulados, y en Chromium real que con el servidor respondiendo «cuota agotada» la respuesta suena con la voz del navegador y se avisa una vez (la prueba falla con el cliente anterior). **No probado:** los servicios reales de Gemini TTS, ElevenLabs, Groq Whisper y Gemini (la red de desarrollo no llega a ellos); en especial, qué versión de Gemini hay detrás de `gemini-flash-lite-latest` y qué ajuste de «pensar» acepta, que la escalera descubre en uso.

## Tarjeta «Voces» y lectura limpia

- La tarjeta **Voces** (barra superior del orbe) lista las voces del servicio (Gemini: catálogo o `GEMINI_TTS_VOICES`; ElevenLabs: `ELEVENLABS_VOICES` = `Nombre:id`) y todas las voces de la PC y del navegador (primero las de español). Se elige motor, voz, velocidad y volumen; se recuerda en ese navegador. El servidor solo acepta voces de su lista.
- Lo que se lee en voz alta nunca incluye asteriscos, almohadillas, enlaces, código ni emojis (`web/src/voice/speechText.ts`; el servidor también limpia en `cleanReply`). Los subtítulos conservan viñetas y saltos de línea.
- Si el agente tarda, Nyvo dice una frase corta; al llegar la respuesta se corta esa frase (si sigue sonando) y se lee la respuesta. Si la voz del navegador no puede leerla, se muestra el error en vez de callar.
- Cada turno muestra cuánto tardó y cuánto tardó cada parte (Rose, Johan, Mia, Nyvo).
