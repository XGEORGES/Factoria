# Taller CNC 2D Layout Planner (REV FINAL)

Aplicación Web SPA (Single Page Application) frontend puro para el diseño y optimización de la distribución en planta (*layout*) de un taller de maquinado CNC de más de **1,100 m²**, con geometría perimetral paramétrica fija, catálogo físico estricto de 17 máquinas, zonas de seguridad y operario, snap magnético a muros con offset métrico, detección de colisiones SAT (Separating Axis Theorem) y exportación directa a AutoCAD en formato DXF.

---

## 🚀 Inicio Rápido

### Opción 1: Servidor Local Integrado (Recomendado)
Abre una terminal en esta carpeta y ejecuta:
```bash
npm start
# o directamente:
node serve.mjs
```
Luego abre tu navegador en: **[http://127.0.0.1:3000](http://127.0.0.1:3000)**

### Opción 2: Cualquier Servidor Web Estático
Puedes servir el directorio con cualquier herramienta como:
- `python -m http.server 3000`
- `npx serve .`
- La extensión Live Server de VS Code.

---

## 📐 Geometría Perimetral del Taller

Polígono cerrado inmutable con origen $(0,0)$ en la esquina inferior izquierda:

- **V0:** `(0.00, 0.00)` — Inicio frente
- **V1:** `(23.50, 0.00)` — Fin frente / Acceso principal (Tramo: 23.50 m)
- **V2:** `(23.50, 33.51)` — Lateral derecho recto (Tramo: 33.51 m)
- **V3:** `(27.03, 38.87)` — Quiebre derecho inclinado (Tramo: 6.42 m, ángulo 56.65°)
- **V4:** `(7.40, 51.79)` — Muro posterior (Tramo: 23.50 m, perpendicular a los inclinados)
- **V5:** `(0.00, 40.55)` — Tramo izquierdo inclinado (Tramo: 13.46 m, ángulo 56.65°)
- **Cierre a V0:** Lateral izquierdo recto (Tramo: 40.55 m)
- **Superficie Total Útil:** **1,103.74 m²**
- **Muro Continuo:** Grosor visual de 0.25 m.

---

## 🏭 Catálogo de Máquinas (17 Activos Físicos)

El lienzo inicia **completamente vacío**. Todos los equipos comienzan en el panel lateral (*Sidebar*):

1. **Centro CNC Grande:** 2.40 × 2.90 m
2. **Centro CNC Pequeño:** 2.00 × 3.00 m
3. **Torno CNC:** 1.50 × 3.30 m
4. **Torno Convencional:** 1.30 × 3.55 m
5. **Máquina Corte por Hilo:** 2.50 × 2.50 m
6. **Cepillo de Bancada:** 3.75 × 2.00 m
7. **Cepilladora / Rectif. Banco:** 1.30 × 4.00 m
8. **Taladro Radial:** 1.20 × 2.00 m
9. **Prensa de Motor:** 2.40 × 1.80 m
10. **Prensa Hidráulica:** 1.20 × 1.80 m
11. **Mesa de Trabajo:** 2.20 × 1.20 m
12. **Rectificadora de Cigüeñal:** 5.50 × 2.20 m
13. **Rectificadora de Asientos:** 1.60 × 1.05 m
14. **Rectificadora de Culatas:** 1.80 × 1.00 m
15. **Pulidora de Cilindros:** 1.50 × 1.00 m
16. **Taladro de Banco:** 1.00 × 1.00 m
17. **Compresor Principal:** 1.00 × 1.00 m

---

## ⌨️ Atajos de Teclado y Controles

| Control / Tecla | Acción |
| :--- | :--- |
| **Arrastrar desde Sidebar** | Coloca la máquina en el taller (descontándola del panel). |
| **Botón `+ Nuevo Objeto`** | Abre el formulario modal para crear máquinas personalizadas con nombre, dimensiones X/Y y color. |
| **Botón `📏` (Herramienta Guía)** | Activa el trazado de líneas constructivas (Clic inicio $\to$ Clic fin; `Shift` para ortogonal). |
| **Botón `🧹` (Limpiar Guías)** | Elimina todas las líneas constructivas de referencia del plano. |
| **Clic sobre Máquina** | La selecciona y activa el Gizmo de transformación. |
| **Arrastre de Manija Gizmo** | Rotación libre continua en 360°. |
| **Tecla `[R]`** | Rotación incremental rápida a **+90°**. |
| **Teclas `[Q]` / `[E]`** | Micro-rotación de ajuste fino a **-5° / +5°**. |
| **Tecla `[Supr]` o `[Delete]`** | Retira la máquina seleccionada o borra la línea constructiva seleccionada. |
| **Clic en Arista** | Asigna esa arista como **Línea del Operador** (**#00FF00 Verde 4px**). |
| **Shift + Clic (o Clic Derecho)** | Asigna esa arista como **Arista de Offset a Muro** (Cian eléctrico `#00F0FF`). |
| **Tecla `[Ctrl]` o `[Shift]` al arrastrar** | Desactiva temporalmente el snap magnético a muros. |
| **Arrastrar Fondo / Espacio + Arrastre** | Desplazamiento panorámico (*Pan*) del lienzo. |
| **Rueda del Mouse** | Zoom métrico centrado exactamente en el cursor. |

---

## 🧲 Snap Magnético a Muros con Offset Paramétrico

- Cuando una máquina se acerca a menos de **0.60 m** de cualquier segmento de pared:
  1. El sistema calcula la pendiente del muro.
  2. Rota automáticamente la máquina paralela al muro.
  3. Desplaza la máquina para que su arista `offsetEdge` quede exactamente a `wallOffset` (por defecto **0.80 m**) de la cara interior del muro.
  4. Muestra una línea de cota verde con el valor métrico exacto.

---

## ⚠️ Detección Continua de Colisiones (SAT)

- Utiliza el **Teorema de Ejes Separadores (SAT)** para Oriented Bounding Boxes (OBB).
- Si dos máquinas se solapan o cualquier esquina de una máquina sale del polígono perimetral del taller:
  * El relleno cambia inmediatamente a **`rgba(255, 0, 0, 0.45)`**.
  * El contorno se resalta en rojo de advertencia.

---

## 📐 Exportación DXF para AutoCAD

Genera archivos `.dxf` ASCII (AutoCAD R12 / 2000) en metros con capas organizadas:
- **`MUROS`** (Color 7 - Blanco): Polilínea cerrada del perímetro de la nave.
- **`MAQUINAS_CUERPO`** (Color 4 - Cyan): Polilíneas cerradas de los 4 vértices rotados de cada equipo.
- **`MAQUINAS_OPERADOR`** (Color 3 - Verde): Segmentos de línea correspondientes a la arista de trabajo del operario.
- **`ETIQUETAS`** (Color 7 - Blanco): Texto centrado con nombre y dimensiones en metros.

---

## 💾 Persistencia JSON

- **Guardar Sesión:** Descarga `taller_layout.json` con las posiciones, rotaciones y configuraciones de aristas.
- **Cargar Sesión:** Restaura el diseño completo y sincroniza el contador de pendientes.
- **LocalStorage:** Guarda automáticamente en segundo plano para que nunca pierdas tu trabajo si recargas la pestaña.
