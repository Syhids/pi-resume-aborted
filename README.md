# pi-resume-aborted

Extensión para [pi](https://pi.dev) que hace amigable retomar el trabajo después de cancelar con `Escape`.

Al cancelar, pi aborta la tool en curso (o la respuesta del modelo) y no hay forma de "reanudarla". Lo habitual es escribir algo como `.` para que siga, pero el modelo tiene que adivinar si querías repetir, saltar ese paso o cambiar de enfoque. Esta extensión elimina esa ambigüedad.

## Qué hace

Tras cancelar, aparece un aviso encima del editor:

```
⏸ Cancelado: bash · npm run build
  "." reintentar  ·  alt+c seguir sin repetir  ·  alt+x corregir
```

| Acción | Cómo | Qué recibe el modelo |
|---|---|---|
| Reintentar | `.` o `/retry` | "Lo cancelé, pero no por el enfoque: repite la tool con los mismos argumentos y continúa" |
| Seguir sin repetir | `alt+c` o `/skip` | "Lo cancelé a propósito: no lo repitas y sigue con la tarea" |
| Corregir | `alt+x` o `/fix` | Rellena el editor con `No repitas … En su lugar, ` para que completes |

- Si cortas al modelo **mientras escribe o piensa** (sin tool en marcha), el aviso dice *Respuesta interrumpida* y `.` le pide continuar donde lo dejó.
- Con `write`, `edit` o comandos `bash` con efectos (`rm`, `git push`, `>`, `npm install`, migraciones…) avisa de que **puede haber quedado estado a medias**, y el modelo lo comprueba antes de repetir.
- Cualquier otra cosa que escribas descarta el aviso y se envía tal cual.
- La extensión **no re-ejecuta la tool por su cuenta**: envía un mensaje explícito al modelo, visible en la conversación, para que el resultado quede bien integrado.

## Instalación

```bash
pi install git:github.com/Syhids/pi-resume-aborted
```

O pruébala sin instalar:

```bash
pi -e git:github.com/Syhids/pi-resume-aborted
```

## Notas

- Los atajos `alt+…` requieren que el terminal envíe Option como Meta (ajuste del perfil en iTerm2 / Terminal.app). Si no, usa `/skip` y `/fix`.
- Los textos de la interfaz y los mensajes al modelo están en español.

## Licencia

MIT
