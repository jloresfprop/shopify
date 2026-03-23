# El Estante CL — Guía rápida

## Comandos principales

| Comando | Qué hace |
|---|---|
| `npm start` | Producción — auto-sync cada 5 min, dejar corriendo siempre |
| `npm run dev` | Desarrollo — auto-sync + preview del tema en vivo (usar al hacer cambios con Claude) |
| `npm run theme:push` | Sube los cambios del tema al live — correr al terminar con Claude |
| `npm run sync` | Corre el sync una sola vez manualmente |
| `npm run sync:dry` | Simula el sync sin hacer cambios reales |

## Flujo de trabajo

### Cambios de diseño (con Claude)
1. Parar `npm start` (Ctrl+C)
2. Correr `npm run dev` — abre el preview del tema en el navegador
3. Hacer los cambios con Claude — se ven al instante en el preview
4. Al terminar: `npm run theme:push` para subir al tema live
5. Volver a `npm start`

### Todo lo demás (automático)
- `npm start` se encarga de todo cada 5 minutos
- Stock, precios y ML se sincronizan solos

## Ubicaciones importantes

| Archivo | Para qué sirve |
|---|---|
| `scripts/auto-sync.js` | Lógica principal del sync |
| `scripts/start.js` | Arranca el servidor |
| `sections/*.liquid` | Secciones del tema |
| `snippets/product-grid-item.liquid` | Tarjeta de producto |
| `.env` | Credenciales (nunca subir a GitHub) |
| `ml-mapping.json` | Mapeo Shopify ↔ MercadoLibre |

## Problemas conocidos

### Producto no aparece en tienda
- Verificar que tiene stock en Dropi
- Verificar que el producto está **Activo** en Shopify Admin
- Correr `npm run sync` para forzar actualización

### Precio inválido ($1 o similar)
- El sync lo detecta y lo marca como `⚠️ Precio pendiente` en Google Sheets
- Hay que corregir el precio en Dropi directamente

### Cambios de diseño no se ven
- Correr `npm run theme:push`
- Si sigue igual, hacer Ctrl+Shift+R en el navegador (limpiar caché)

## Tienda
- **URL:** https://el-estante-cl.myshopify.com
- **Tema live ID:** 133827002465
- **Google Sheets:** ver en Drive el archivo "El Estante CL"
