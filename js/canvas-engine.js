/**
 * CANVAS-ENGINE.JS
 * Motor de Renderizado HTML5 Canvas 2D Vectorial de Alta Precisión.
 * Soporta Pan afín, Zoom centrado en cursor, Rejilla métrica, Renderizado de Muros,
 * Gizmo de transformación, Gestión de aristas interactivas y Colisiones SAT.
 */

import {
  PERIMETER_VERTICES,
  WALL_THICKNESS,
  getWallSegments,
  getWorkshopBounds,
  getMachineCorners,
  getMachineEdgeSegment,
  isMachineFullyInsidePerimeter,
  checkMachineMachineCollision,
  getMachineClearanceCorners,
  getMachineClearanceOffsets,
  getMachineClearanceEdgeSegment,
  isMachineInsideZone,
  isPointInsideMachine
} from './geometry.js';

export class CanvasEngine {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');

    // Estado de la transformación de vista (World <-> Screen)
    // 1 unidad world = 1.0 metro
    this.scale = 20; // Píxeles por metro por defecto
    this.panX = 100;
    this.panY = 100;

    // Opciones de visualización
    this.showGrid = true;
    this.showDimensions = true;
    this.showOperatorZones = true;
    this.showClearanceZones = true; // Visualización de zonas de seguridad/offset entre máquinas

    // Estado de entidades
    this.machines = [];
    this.selectedMachineId = null;
    this.hoveredEdge = null; // { machineId, edgeIndex }
    this.snapGuide = null; // Guía visual de snap activo

    // Líneas constructivas / Guías de referencia
    this.constructionLines = [];
    this.selectedGuidelineId = null;
    this.tempGuideline = null;

    // Cache de colisiones
    this.collisionMap = new Map(); // id -> boolean (true si colisiona)

    // Gizmo properties
    this.gizmoHandleRadius = 7;
    this.gizmoDistanceMeters = 1.2; // Distancia de la manija de rotación sobre el centroide

    // Redraw flag
    this.needsRedraw = true;

    this.initResizeObserver();
  }

  initResizeObserver() {
    const resize = () => {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.width = rect.width;
      this.height = rect.height;
      this.canvas.width = Math.floor(rect.width * dpr);
      this.canvas.height = Math.floor(rect.height * dpr);
      this.canvas.style.width = `${rect.width}px`;
      this.canvas.style.height = `${rect.height}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.requestRender();
    };

    window.addEventListener('resize', resize);
    setTimeout(resize, 50);
  }

  requestRender() {
    this.needsRedraw = true;
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        if (this.needsRedraw) {
          this.render();
          this.needsRedraw = false;
        }
      });
    }
  }

  setMachines(machines) {
    this.machines = machines;
    this.updateCollisions();
    this.requestRender();
  }

  setSelectedMachineId(id) {
    this.selectedMachineId = id;
    this.requestRender();
  }

  setSnapGuide(guide) {
    this.snapGuide = guide;
    this.requestRender();
  }

  setHoveredEdge(hoverInfo) {
    this.hoveredEdge = hoverInfo;
    this.requestRender();
  }

  setConstructionLines(lines) {
    this.constructionLines = lines;
    this.requestRender();
  }

  setSelectedGuidelineId(id) {
    this.selectedGuidelineId = id;
    this.requestRender();
  }

  setTempGuideline(guide) {
    this.tempGuideline = guide;
    this.requestRender();
  }

  /**
   * Actualiza el cálculo continuo de colisiones (SAT y límites perimetrales)
   * Soporta jerarquía Padre-Hijo (Zonas/Recintos y objetos anidados).
   * Si hay solape entre dos máquinas, salida del taller o invasión indebida,
   * el elemento se registra en collisionMap y se alerta visualmente en rojo.
   */
  updateCollisions() {
    this.collisionMap.clear();
    const placed = this.machines.filter(m => m.isPlaced);

    for (let i = 0; i < placed.length; i++) {
      const m1 = placed[i];

      // Verificación de salida del polígono del taller para zonas y objetos sin contenedor
      if (!m1.parentId) {
        if (!isMachineFullyInsidePerimeter(m1)) {
          this.collisionMap.set(m1.id, true);
        }
      } else {
        // Objeto hijo: comprobar si sus límites sobrepasan la zona contenedora
        const parentZone = placed.find(z => z.id === m1.parentId && z.isPlaced);
        if (parentZone && !isMachineInsideZone(m1, parentZone)) {
          this.collisionMap.set(m1.id, true);
        }
      }

      // Verificación entre pares de entidades
      for (let j = i + 1; j < placed.length; j++) {
        const m2 = placed[j];

        // 1. Relación Padre-Hijo directa: no colisionan entre sí (el hijo vive dentro de su zona)
        if ((m1.isZone && m2.parentId === m1.id) || (m2.isZone && m1.parentId === m2.id)) {
          continue;
        }

        // 2. Dos objetos hijos dentro de la MISMA zona: SÍ colisionan si se superponen o invaden clearance
        if (m1.parentId && m2.parentId && m1.parentId === m2.parentId) {
          if (checkMachineMachineCollision(m1, m2)) {
            this.collisionMap.set(m1.id, true);
            this.collisionMap.set(m2.id, true);
          }
          continue;
        }

        // 3. Si uno o ambos son hijos de zonas diferentes o un hijo frente al exterior:
        // La zona contenedora actúa como barrera física. El hijo se valida con isMachineInsideZone.
        if (m1.parentId || m2.parentId) {
          continue;
        }

        // 4. Entidades principales de planta (Zona vs Zona, Zona vs Máquina externa, Máquina vs Máquina)
        if (checkMachineMachineCollision(m1, m2)) {
          this.collisionMap.set(m1.id, true);
          this.collisionMap.set(m2.id, true);
        }
      }
    }
  }

  // ==========================================
  // TRANSFORMACIONES COORDENADAS
  // ==========================================

  worldToScreen(wx, wy) {
    return {
      x: this.panX + wx * this.scale,
      y: this.panY - wy * this.scale
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.panX) / this.scale,
      y: (this.panY - sy) / this.scale
    };
  }

  /**
   * Zoom centrado exactamente en el cursor del mouse
   */
  zoomAtPoint(screenX, screenY, zoomFactor) {
    const worldBefore = this.screenToWorld(screenX, screenY);
    const newScale = Math.max(4, Math.min(150, this.scale * zoomFactor));
    if (newScale === this.scale) return;

    this.scale = newScale;
    this.panX = screenX - worldBefore.x * this.scale;
    this.panY = screenY + worldBefore.y * this.scale;
    this.requestRender();
  }

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.requestRender();
  }

  /**
   * Zoom Extents (Ajustar taller completo a pantalla con margen)
   */
  zoomExtents() {
    const bounds = getWorkshopBounds();
    const padding = 70;
    const availW = Math.max(100, this.width - padding * 2);
    const availH = Math.max(100, this.height - padding * 2);

    const scaleX = availW / bounds.width;
    const scaleY = availH / bounds.height;
    this.scale = Math.min(scaleX, scaleY);

    // Centrar
    const centerScreenX = this.width / 2;
    const centerScreenY = this.height / 2;
    this.panX = centerScreenX - bounds.centerX * this.scale;
    this.panY = centerScreenY + bounds.centerY * this.scale;

    this.requestRender();
  }

  // ==========================================
  // RENDERIZADO PRINCIPAL
  // ==========================================

  render() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // Fondo oscuro CAD profesional
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, w, h);

    // 1. Rejilla métrica (si está activa)
    if (this.showGrid) {
      this.drawMetricGrid();
    }

    // 2. Interior y Perímetro del Taller (Coordenadas fijas V0-V5)
    this.drawWorkshopPerimeter();

    // 2.5 Líneas constructivas / Guías de referencia
    this.drawConstructionLines();
    if (this.tempGuideline) {
      this.drawTempGuideline(this.tempGuideline);
    }

    // 3. Guía de Snap Magnético activa (si hay)
    if (this.snapGuide) {
      this.drawSnapGuide(this.snapGuide);
    }

    // 4. Máquinas colocadas
    this.drawMachines();

    // 5. Gizmo y resaltado de la máquina seleccionada
    if (this.selectedMachineId) {
      const selected = this.machines.find(m => m.id === this.selectedMachineId && m.isPlaced);
      if (selected) {
        this.drawMachineGizmo(selected);
      }
    }

    // 6. Ejes de coordenadas de origen (0,0)
    this.drawOriginAxes();
  }

  /**
   * Dibuja la rejilla métrica de fondo:
   * - Paso principal a 1.0 m
   * - Subdivisiones a 0.5 m
   */
  drawMetricGrid() {
    const ctx = this.ctx;
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.width, this.height);

    const minX = Math.floor(Math.min(topLeft.x, bottomRight.x) - 2);
    const maxX = Math.ceil(Math.max(topLeft.x, bottomRight.x) + 2);
    const minY = Math.floor(Math.min(topLeft.y, bottomRight.y) - 2);
    const maxY = Math.ceil(Math.max(topLeft.y, bottomRight.y) + 2);

    // Subdivisiones a 0.5 m (líneas muy sutiles si hay suficiente zoom)
    if (this.scale >= 12) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.lineWidth = 1;
      for (let x = minX; x <= maxX; x += 0.5) {
        if (Math.abs(x - Math.round(x)) > 0.01) {
          const s1 = this.worldToScreen(x, minY);
          const s2 = this.worldToScreen(x, maxY);
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
        }
      }
      for (let y = minY; y <= maxY; y += 0.5) {
        if (Math.abs(y - Math.round(y)) > 0.01) {
          const s1 = this.worldToScreen(minX, y);
          const s2 = this.worldToScreen(maxX, y);
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
        }
      }
      ctx.stroke();
    }

    // Paso mayor a 1.0 m
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let x = minX; x <= maxX; x += 1.0) {
      const s1 = this.worldToScreen(x, minY);
      const s2 = this.worldToScreen(x, maxY);
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
    }
    for (let y = minY; y <= maxY; y += 1.0) {
      const s1 = this.worldToScreen(minX, y);
      const s2 = this.worldToScreen(maxX, y);
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
    }
    ctx.stroke();

    // Marcadores métricos cada 5 metros
    if (this.scale >= 8) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let x = Math.ceil(minX / 5) * 5; x <= maxX; x += 5) {
        const s = this.worldToScreen(x, 0);
        if (s.x > 30 && s.x < this.width - 30) {
          ctx.fillText(`${x}m`, s.x + 3, s.y + 4);
        }
      }
    }
  }

  /**
   * Dibuja los ejes de coordenadas con origen en (0,0)
   */
  drawOriginAxes() {
    const ctx = this.ctx;
    const origin = this.worldToScreen(0, 0);

    // Eje X (Rojo CAD)
    ctx.beginPath();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(origin.x + 35, origin.y);
    ctx.stroke();

    // Eje Y (Verde CAD hacia arriba)
    ctx.beginPath();
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(origin.x, origin.y - 35);
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('X', origin.x + 38, origin.y + 3);
    ctx.fillText('Y', origin.x - 3, origin.y - 38);

    // Círculo en (0,0)
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
  }

  /**
   * Dibuja la geometría perimetral del taller (V0 a V5 y cierre a V0)
   */
  drawWorkshopPerimeter() {
    const ctx = this.ctx;
    const verts = PERIMETER_VERTICES;
    if (verts.length < 3) return;

    // 1. Relleno del suelo de la nave
    ctx.beginPath();
    const s0 = this.worldToScreen(verts[0].x, verts[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < verts.length; i++) {
      const s = this.worldToScreen(verts[i].x, verts[i].y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
    ctx.fillStyle = '#0f172a'; // Gris pizarra oscuro nave industrial
    ctx.fill();

    // 2. Trazo de muro continuo (Grosor visual 0.25 m en color gris oscuro / negro)
    const wallPx = Math.max(3, WALL_THICKNESS * this.scale);
    ctx.beginPath();
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < verts.length; i++) {
      const s = this.worldToScreen(verts[i].x, verts[i].y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
    ctx.strokeStyle = '#334155'; // Color muro industrial sólido
    ctx.lineWidth = wallPx;
    ctx.lineJoin = 'miter';
    ctx.stroke();

    // Línea interior nítida del muro
    ctx.beginPath();
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < verts.length; i++) {
      const s = this.worldToScreen(verts[i].x, verts[i].y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 3. Vértices y cotas perimetrales
    const segments = getWallSegments();
    ctx.font = '10px monospace';
    ctx.fillStyle = '#94a3b8';

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const p1 = this.worldToScreen(seg.start.x, seg.start.y);
      const p2 = this.worldToScreen(seg.end.x, seg.end.y);

      // Círculo en vértice
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();

      // Etiqueta del vértice
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(seg.start.name, p1.x + 5, p1.y - 5);

      // Cota del tramo (Longitud en metros y descripción técnica)
      if (this.showDimensions && this.scale >= 8) {
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const offsetPx = 16;
        const nx = -seg.normal.x * offsetPx;
        const ny = seg.normal.y * offsetPx;

        ctx.save();
        ctx.translate(midX + nx, midY + ny);
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        let label = `${seg.length.toFixed(2)} m`;
        if (i === 0) {
          label = `23.50 m (Frente · 90°)`;
        } else if (i === 1) {
          label = `33.51 m (Lateral Der. · 90°)`;
        } else if (i === 2) {
          label = `6.42 m (Inclinado 56.65°)`;
        } else if (i === 3) {
          label = `23.50 m (Muro Posterior)`;
        } else if (i === 4) {
          label = `13.46 m (Inclinado 56.65°)`;
        } else if (i === 5) {
          label = `40.55 m (Lateral Izq. · 90°)`;
        }

        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }

    // Indicadores visuales CAD de ángulo recto (90°) en las esquinas ortogonales V0 y V1
    if (this.scale >= 6) {
      const sqSize = Math.min(22, Math.max(10, 1.2 * this.scale));
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;

      // Esquina V0 (0,0): Frente y Lateral Izquierdo ortogonales a 90°
      const sv0 = this.worldToScreen(0, 0);
      ctx.beginPath();
      ctx.moveTo(sv0.x, sv0.y - sqSize);
      ctx.lineTo(sv0.x + sqSize, sv0.y - sqSize);
      ctx.lineTo(sv0.x + sqSize, sv0.y);
      ctx.stroke();

      // Esquina V1 (23.50, 0): Frente y Lateral Derecho ortogonales a 90°
      const sv1 = this.worldToScreen(23.50, 0);
      ctx.beginPath();
      ctx.moveTo(sv1.x, sv1.y - sqSize);
      ctx.lineTo(sv1.x - sqSize, sv1.y - sqSize);
      ctx.lineTo(sv1.x - sqSize, sv1.y);
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('90°', sv0.x + sqSize + 4, sv0.y - sqSize / 2);
      ctx.fillText('90°', sv1.x - sqSize - 22, sv1.y - sqSize / 2);
      ctx.restore();
    }

    // Marcador de Ingreso / Acceso en V0 -> V1 (23.50 m)
    const midV0V1 = this.worldToScreen(11.75, 0);
    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('▲ INGRESO PRINCIPAL (23.50 m) ▲', midV0V1.x, midV0V1.y + 20);
  }

  /**
   * Dibuja todas las máquinas colocadas en el lienzo.
   * Las zonas/recintos se renderizan primero en la capa de fondo (Z-Index inferior),
   * y los objetos/muebles se renderizan encima (Z-Index superior).
   */
  drawMachines() {
    const placed = this.machines.filter(m => m.isPlaced);
    const zones = placed.filter(m => m.isZone);
    const nonZones = placed.filter(m => !m.isZone);

    // 1. Capa de Fondo: Zonas y Recintos
    for (const z of zones) {
      const isSelected = z.id === this.selectedMachineId;
      const isColliding = this.collisionMap.get(z.id) === true;
      this.drawSingleZone(z, isSelected, isColliding);
    }

    // 2. Capa Superior: Máquinas, Mesas y Mobiliario
    for (const m of nonZones) {
      const isSelected = m.id === this.selectedMachineId;
      const isColliding = this.collisionMap.get(m.id) === true;
      this.drawSingleMachine(m, isSelected, isColliding);
    }
  }

  /**
   * Dibuja un recinto / zona contenedora con estilo arquitectónico CAD
   */
  drawSingleZone(z, isSelected, isColliding) {
    const ctx = this.ctx;
    const corners = getMachineCorners(z);
    const screenCorners = corners.map(c => this.worldToScreen(c.x, c.y));
    const centroid = this.worldToScreen(z.x, z.y);

    // 1. ZONA DE SEGURIDAD / CLEARANCE EXTERIOR DE LA ZONA (4 CARAS)
    const clearanceOffsets = getMachineClearanceOffsets(z);
    const hasClearance = clearanceOffsets.some(v => v > 0);
    const showClearance = (this.showClearanceZones || isSelected) && hasClearance;

    if (showClearance) {
      const clearanceCorners = getMachineClearanceCorners(z);
      const screenClearance = clearanceCorners.map(c => this.worldToScreen(c.x, c.y));

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(screenClearance[0].x, screenClearance[0].y);
      for (let i = 1; i < screenClearance.length; i++) {
        ctx.lineTo(screenClearance[i].x, screenClearance[i].y);
      }
      ctx.closePath();

      if (isColliding) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      } else if (isSelected) {
        ctx.fillStyle = 'rgba(99, 102, 241, 0.08)';
        ctx.strokeStyle = '#818cf8';
      } else {
        ctx.fillStyle = 'rgba(99, 102, 241, 0.03)';
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.35)';
      }
      ctx.lineWidth = isSelected ? 1.8 : 1.2;
      ctx.setLineDash([6, 4]);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (isSelected || (this.scale >= 22 && this.showClearanceZones)) {
        this.drawClearanceLabels(z, screenClearance, clearanceOffsets);
      }
    }

    // 2. CONTORNO Y FONDO ARQUITECTÓNICO DE LA ZONA
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(screenCorners[0].x, screenCorners[0].y);
    for (let i = 1; i < screenCorners.length; i++) {
      ctx.lineTo(screenCorners[i].x, screenCorners[i].y);
    }
    ctx.closePath();

    // Relleno suave translúcido
    if (isColliding) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';
    } else if (isSelected) {
      ctx.fillStyle = 'rgba(99, 102, 241, 0.16)';
    } else {
      ctx.fillStyle = z.color ? `${z.color}15` : 'rgba(99, 102, 241, 0.08)';
    }
    ctx.fill();

    // Borde de muro arquitectónico exterior
    const baseColor = z.color || '#6366f1';
    ctx.strokeStyle = isColliding ? '#ef4444' : (isSelected ? '#a5b4fc' : baseColor);
    ctx.lineWidth = isSelected ? 3.5 : 2.5;
    ctx.stroke();

    // Doble trazo interior tipo muro arquitectónico
    if (this.scale >= 15) {
      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = isColliding ? 'rgba(239, 68, 68, 0.5)' : (isSelected ? 'rgba(165, 180, 252, 0.6)' : 'rgba(255, 255, 255, 0.2)');
      ctx.lineWidth = 1.0;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // 3. ARISTA DE OPERADOR (LÍNEA VERDE DE ACCESO/PUERTA) Y ARISTA DE OFFSET
    const opEdgeIndex = (z.operatorEdge ?? 0) % 4;
    const offsetEdgeIndex = (z.offsetEdge ?? 2) % 4;

    const opP1 = screenCorners[opEdgeIndex];
    const opP2 = screenCorners[(opEdgeIndex + 1) % 4];

    const offP1 = screenCorners[offsetEdgeIndex];
    const offP2 = screenCorners[(offsetEdgeIndex + 1) % 4];

    if (opEdgeIndex === offsetEdgeIndex) {
      // Arista compartida: verde y cian
      ctx.beginPath();
      ctx.strokeStyle = '#00FF00';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.moveTo(opP1.x, opP1.y);
      ctx.lineTo(opP2.x, opP2.y);
      ctx.stroke();

      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#00F0FF';
      ctx.lineWidth = 5;
      ctx.moveTo(offP1.x, offP1.y);
      ctx.lineTo(offP2.x, offP2.y);
      ctx.stroke();
      ctx.restore();
    } else {
      // 3.1 Arista del Operador (Acceso/Entrada): Verde intenso #00FF00
      ctx.beginPath();
      ctx.strokeStyle = '#00FF00';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.moveTo(opP1.x, opP1.y);
      ctx.lineTo(opP2.x, opP2.y);
      ctx.stroke();

      // 3.2 Arista de Offset: Cian #00F0FF si está seleccionada
      if (isSelected) {
        ctx.beginPath();
        ctx.strokeStyle = '#00F0FF';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.moveTo(offP1.x, offP1.y);
        ctx.lineTo(offP2.x, offP2.y);
        ctx.stroke();
      }
    }

    // 4. BADGE FLOTANTE DE OFFSET
    if (isSelected || this.scale >= 20) {
      const offMidX = (offP1.x + offP2.x) / 2;
      const offMidY = (offP1.y + offP2.y) / 2;
      const dx = offP2.x - offP1.x;
      const dy = offP2.y - offP1.y;
      const len = Math.hypot(dx, dy);

      if (len > 0) {
        let nx = -dy / len;
        let ny = dx / len;
        const toCentroidX = centroid.x - offMidX;
        const toCentroidY = centroid.y - offMidY;
        if (nx * toCentroidX + ny * toCentroidY > 0) {
          nx = -nx;
          ny = -ny;
        }

        const badgeX = offMidX + nx * 14;
        const badgeY = offMidY + ny * 14;

        ctx.save();
        const badgeText = `MURO: ${(z.wallOffset ?? 0.80).toFixed(2)}m`;
        ctx.font = 'bold 9px monospace';
        const txtWidth = ctx.measureText(badgeText).width;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.strokeStyle = '#00F0FF';
        ctx.lineWidth = 1.2;

        const padX = 5, padY = 3;
        const boxX = badgeX - txtWidth / 2 - padX;
        const boxY = badgeY - 7 - padY;
        const boxW = txtWidth + padX * 2;
        const boxH = 14 + padY;

        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(boxX, boxY, boxW, boxH, 4);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(boxX, boxY, boxW, boxH);
          ctx.strokeRect(boxX, boxY, boxW, boxH);
        }

        ctx.fillStyle = '#00F0FF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, badgeX, badgeY - 1);
        ctx.restore();
      }
    }

    // 5. TEXTO DEL NOMBRE DE LA ZONA, DIMENSIONES Y SUPERFICIE EN M²
    this.drawZoneLabels(z, centroid, isColliding);
  }

  /**
   * Dibuja los textos y títulos de una Zona con orientación paramétrica
   */
  drawZoneLabels(z, centroid, isColliding) {
    const ctx = this.ctx;
    const labelRot = ((z.labelRotation || 0) % 360 + 360) % 360;
    const isPerpendicular = (labelRot % 180 !== 0);

    const screenW = z.width * this.scale;
    const screenH = z.height * this.scale;
    const availWidth = (isPerpendicular ? screenH : screenW) * 0.90;
    const availHeight = (isPerpendicular ? screenW : screenH) * 0.90;

    if (availWidth < 20 || availHeight < 15) return;

    ctx.save();
    ctx.translate(centroid.x, centroid.y);
    ctx.rotate(-((z.rotation + labelRot) * Math.PI) / 180);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const areaM2 = (z.width * z.height).toFixed(2);
    const dimsText = `${z.width.toFixed(2)} x ${z.height.toFixed(2)} m · ${areaM2} m²`;

    const titleSize = Math.min(22, Math.max(11, Math.floor(this.scale * 0.55)));
    const subSize = Math.max(9, Math.floor(titleSize * 0.72));

    // Cartela técnica semitransparente para legibilidad
    const titleText = (z.name || 'ZONA').toUpperCase();
    ctx.font = `bold ${titleSize}px sans-serif`;
    const titleWidth = ctx.measureText(titleText).width;
    ctx.font = `${subSize}px monospace`;
    const subWidth = ctx.measureText(dimsText).width;
    const bannerW = Math.max(titleWidth, subWidth) + 16;
    const bannerH = titleSize + subSize + 12;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.strokeStyle = isColliding ? '#ef4444' : (z.color || '#6366f1');
    ctx.lineWidth = 1;

    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(-bannerW / 2, -bannerH / 2, bannerW, bannerH, 4);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(-bannerW / 2, -bannerH / 2, bannerW, bannerH);
      ctx.strokeRect(-bannerW / 2, -bannerH / 2, bannerW, bannerH);
    }

    // Nombre de la zona
    ctx.fillStyle = isColliding ? '#fca5a5' : '#ffffff';
    ctx.font = `bold ${titleSize}px sans-serif`;
    ctx.fillText(titleText, 0, -subSize * 0.55);

    // Dimensiones y área en m²
    ctx.fillStyle = isColliding ? '#f87171' : '#a5b4fc';
    ctx.font = `bold ${subSize}px monospace`;
    ctx.fillText(dimsText, 0, titleSize * 0.55);

    ctx.restore();
  }

  /**
   * Dibuja una máquina individual con su cuerpo, zona de operador, aristas interactivas y etiquetas
   */
  drawSingleMachine(m, isSelected, isColliding) {
    const ctx = this.ctx;
    const corners = getMachineCorners(m);
    const screenCorners = corners.map(c => this.worldToScreen(c.x, c.y));
    const centroid = this.worldToScreen(m.x, m.y);

    // 1. ZONA DE SEGURIDAD / CLEARANCE ENTRE MÁQUINAS (4 CARAS)
    const clearanceOffsets = getMachineClearanceOffsets(m);
    const hasClearance = clearanceOffsets.some(v => v > 0);
    const showClearance = (this.showClearanceZones || isSelected) && hasClearance;

    if (showClearance) {
      const clearanceCorners = getMachineClearanceCorners(m);
      const screenClearance = clearanceCorners.map(c => this.worldToScreen(c.x, c.y));

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(screenClearance[0].x, screenClearance[0].y);
      for (let i = 1; i < screenClearance.length; i++) {
        ctx.lineTo(screenClearance[i].x, screenClearance[i].y);
      }
      ctx.closePath();

      if (isColliding) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      } else if (isSelected) {
        ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
        ctx.strokeStyle = '#06b6d4';
      } else {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.03)';
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      }
      ctx.lineWidth = isSelected ? 1.8 : 1.2;
      ctx.setLineDash([6, 4]);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Cotas métricas en las 4 caras cuando la máquina está seleccionada o con buen zoom
      if (isSelected || (this.scale >= 22 && this.showClearanceZones)) {
        this.drawClearanceLabels(m, screenClearance, clearanceOffsets);
      }
    }

    // 2. CUERPO DE LA MÁQUINA
    ctx.beginPath();
    ctx.moveTo(screenCorners[0].x, screenCorners[0].y);
    for (let i = 1; i < screenCorners.length; i++) {
      ctx.lineTo(screenCorners[i].x, screenCorners[i].y);
    }
    ctx.closePath();

    // Relleno según estado de colisión
    if (isColliding) {
      // Requerimiento 6.1: RGBA(255, 0, 0, 0.45)
      ctx.fillStyle = 'rgba(255, 0, 0, 0.45)';
    } else if (isSelected) {
      ctx.fillStyle = 'rgba(2, 132, 199, 0.35)'; // Azul CAD seleccionado
    } else {
      ctx.fillStyle = m.color ? `${m.color}33` : 'rgba(30, 41, 59, 0.85)';
    }
    ctx.fill();

    // Contorno del cuerpo (Cian si normal, Rojo si colisión)
    ctx.strokeStyle = isColliding ? '#ef4444' : (isSelected ? '#38bdf8' : '#0284c7');
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.stroke();

    // Detalle CAD interno decorativo (rejilla o cruz suave)
    if (this.scale >= 15) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.moveTo(screenCorners[0].x, screenCorners[0].y);
      ctx.lineTo(screenCorners[2].x, screenCorners[2].y);
      ctx.moveTo(screenCorners[1].x, screenCorners[1].y);
      ctx.lineTo(screenCorners[3].x, screenCorners[3].y);
      ctx.stroke();
    }

    // 3. ARISTA DEL OPERADOR Y ARISTA DE OFFSET (Sección 5.4 con indicador de color activo)
    const opEdgeIndex = (m.operatorEdge ?? 0) % 4;
    const offsetEdgeIndex = (m.offsetEdge ?? 2) % 4;

    const opIdx1 = opEdgeIndex;
    const opIdx2 = (opEdgeIndex + 1) % 4;
    const opP1 = screenCorners[opIdx1];
    const opP2 = screenCorners[opIdx2];

    const offIdx1 = offsetEdgeIndex;
    const offIdx2 = (offsetEdgeIndex + 1) % 4;
    const offP1 = screenCorners[offIdx1];
    const offP2 = screenCorners[offIdx2];

    if (opEdgeIndex === offsetEdgeIndex) {
      // Caso arista compartida (Operador + Offset): Trazo bicoloreado verde y cian
      ctx.beginPath();
      ctx.strokeStyle = '#00FF00';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.moveTo(opP1.x, opP1.y);
      ctx.lineTo(opP2.x, opP2.y);
      ctx.stroke();

      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#00F0FF'; // Cian brillante offset
      ctx.lineWidth = 5;
      ctx.moveTo(offP1.x, offP1.y);
      ctx.lineTo(offP2.x, offP2.y);
      ctx.stroke();
      ctx.restore();
    } else {
      // 3.1 Arista del Operador: Trazo continuo VERDE intenso #00FF00 de 4px
      ctx.beginPath();
      ctx.strokeStyle = '#00FF00';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.moveTo(opP1.x, opP1.y);
      ctx.lineTo(opP2.x, opP2.y);
      ctx.stroke();

      // 3.2 Arista de Offset ACTIVA: Trazo continuo CIAN ELÉCTRICO (#00F0FF) de 4px
      ctx.beginPath();
      ctx.strokeStyle = '#00F0FF';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.moveTo(offP1.x, offP1.y);
      ctx.lineTo(offP2.x, offP2.y);
      ctx.stroke();

      // Resalte central en blanco técnico para máxima visibilidad CAD
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.moveTo(offP1.x, offP1.y);
      ctx.lineTo(offP2.x, offP2.y);
      ctx.stroke();
      ctx.restore();
    }

    // 4. BADGE FLOTANTE DE ARISTA DE OFFSET ACTIVA (Si está seleccionada o con zoom)
    if (isSelected || this.scale >= 20) {
      const offMidX = (offP1.x + offP2.x) / 2;
      const offMidY = (offP1.y + offP2.y) / 2;

      // Calcular vector normal saliente (hacia el exterior de la máquina)
      const dx = offP2.x - offP1.x;
      const dy = offP2.y - offP1.y;
      const len = Math.hypot(dx, dy);

      if (len > 0) {
        let nx = -dy / len;
        let ny = dx / len;

        // Verificar que apunte hacia afuera del centroide
        const toCentroidX = centroid.x - offMidX;
        const toCentroidY = centroid.y - offMidY;
        if (nx * toCentroidX + ny * toCentroidY > 0) {
          nx = -nx;
          ny = -ny;
        }

        const badgeX = offMidX + nx * 14;
        const badgeY = offMidY + ny * 14;

        ctx.save();
        const badgeText = `OFFSET: ${(m.wallOffset ?? 0.80).toFixed(2)}m`;
        ctx.font = 'bold 9px monospace';
        const txtWidth = ctx.measureText(badgeText).width;

        ctx.fillStyle = 'rgba(8, 51, 68, 0.9)';
        ctx.strokeStyle = '#00F0FF';
        ctx.lineWidth = 1.2;

        const padX = 5, padY = 3;
        const boxX = badgeX - txtWidth / 2 - padX;
        const boxY = badgeY - 7 - padY;
        const boxW = txtWidth + padX * 2;
        const boxH = 14 + padY;

        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(boxX, boxY, boxW, boxH, 4);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(boxX, boxY, boxW, boxH);
          ctx.strokeRect(boxX, boxY, boxW, boxH);
        }

        ctx.fillStyle = '#00F0FF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, badgeX, badgeY - 1);
        ctx.restore();
      }
    }

    // 5. TEXTOS Y ETIQUETAS CON AUTO-AJUSTE MULTILÍNEA Y ROTACIÓN DINÁMICA (Opción 1)
    this.drawMachineLabels(m, centroid, isColliding);
  }

  /**
   * Dibuja los textos y etiquetas con auto-ajuste inteligente multilínea (Opción 1)
   * Se adapta al ancho/alto disponible según la orientación rotada (0°, 90°, 180°, 270°)
   */
  drawMachineLabels(m, centroid, isColliding) {
    const ctx = this.ctx;
    const labelRot = ((m.labelRotation || 0) % 360 + 360) % 360;
    const isPerpendicular = (labelRot % 180 !== 0); // 90° o 270°

    const screenW = m.width * this.scale;
    const screenH = m.height * this.scale;

    // Espacio útil disponible según la orientación de la etiqueta (con margen de seguridad del 12%)
    const availWidth = (isPerpendicular ? screenH : screenW) * 0.88;
    const availHeight = (isPerpendicular ? screenW : screenH) * 0.88;

    // Si el área visible en pantalla es demasiado pequeña (zoom panorámico extremo), no saturar el lienzo
    if (availWidth < 14 || availHeight < 10) {
      return;
    }

    ctx.save();
    ctx.translate(centroid.x, centroid.y);
    ctx.rotate(-((m.rotation + labelRot) * Math.PI) / 180);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const rawWords = (m.name || '').trim().split(/\s+/).filter(Boolean);
    const dimsText = `${m.width.toFixed(2)} x ${m.height.toFixed(2)} m`;

    // Rango de tamaño de fuente
    const maxFs = Math.max(8.5, Math.min(13.5, Math.round(this.scale * 0.42)));
    const minFs = 6.5;

    let bestConfig = null;

    // Buscamos el tamaño de fuente óptimo (desde maxFs hacia abajo)
    for (let fs = maxFs; fs >= minFs; fs -= 0.5) {
      ctx.font = `600 ${fs}px sans-serif`;

      // Intentamos agrupar las palabras en líneas respetando availWidth
      const lines = [];
      let curLine = rawWords[0] || '';
      let wordTooWide = false;

      // Verificamos si la primera palabra ya excede el ancho disponible
      if (ctx.measureText(curLine).width > availWidth) {
        wordTooWide = true;
      }

      if (!wordTooWide) {
        for (let i = 1; i < rawWords.length; i++) {
          const w = rawWords[i];
          const testLine = curLine + ' ' + w;
          if (ctx.measureText(testLine).width <= availWidth) {
            curLine = testLine;
          } else {
            lines.push(curLine);
            curLine = w;
            if (ctx.measureText(curLine).width > availWidth) {
              wordTooWide = true;
              break;
            }
          }
        }
        if (!wordTooWide) {
          lines.push(curLine);
        }
      }

      if (wordTooWide) {
        continue; // La palabra individual no cabe con este fs, probar menor tamaño
      }

      // Medir altura total requerida
      const dimFs = Math.max(5.5, Math.round(fs * 0.78));
      ctx.font = `${dimFs}px monospace`;
      const dimWidth = ctx.measureText(dimsText).width;
      const canFitDims = (dimWidth <= availWidth);

      const nameLineH = fs * 1.15;
      const dimLineH = dimFs * 1.15;
      const gap = Math.max(2, fs * 0.25);

      const totalHWithDims = (lines.length * nameLineH) + (canFitDims ? (gap + dimLineH) : 0);

      if (totalHWithDims <= availHeight) {
        bestConfig = {
          fs,
          dimFs,
          lines,
          showDims: canFitDims,
          nameLineH,
          dimLineH,
          gap,
          totalH: totalHWithDims
        };
        break;
      } else if ((lines.length * nameLineH) <= availHeight) {
        // Si no cabe la cota métrica, al menos cabe el nombre completo
        bestConfig = {
          fs,
          dimFs,
          lines,
          showDims: false,
          nameLineH,
          dimLineH: 0,
          gap: 0,
          totalH: lines.length * nameLineH
        };
        break;
      }
    }

    // Si aún con minFs excede, usamos minFs con distribución forzada de palabras
    if (!bestConfig) {
      const fs = minFs;
      ctx.font = `600 ${fs}px sans-serif`;
      const lines = [];
      let curLine = rawWords[0] || '';
      for (let i = 1; i < rawWords.length; i++) {
        const testLine = curLine + ' ' + rawWords[i];
        if (ctx.measureText(testLine).width <= availWidth) {
          curLine = testLine;
        } else {
          lines.push(curLine);
          curLine = rawWords[i];
        }
      }
      lines.push(curLine);

      const nameLineH = fs * 1.12;
      bestConfig = {
        fs,
        dimFs: 5.5,
        lines: lines.slice(0, 3), // Límite de 3 filas
        showDims: false,
        nameLineH,
        dimLineH: 0,
        gap: 0,
        totalH: Math.min(lines.length, 3) * nameLineH
      };
    }

    // Renderizar líneas centradas vertical y horizontalmente
    const { fs, dimFs, lines, showDims, nameLineH, dimLineH, gap, totalH } = bestConfig;
    let curY = -totalH / 2 + nameLineH / 2;

    ctx.fillStyle = isColliding ? '#fecaca' : '#f8fafc';
    ctx.font = `600 ${fs}px sans-serif`;

    for (const line of lines) {
      ctx.fillText(line, 0, curY);
      curY += nameLineH;
    }

    if (showDims) {
      curY += gap - nameLineH / 2 + dimLineH / 2;
      ctx.fillStyle = '#94a3b8';
      ctx.font = `${dimFs}px monospace`;
      ctx.fillText(dimsText, 0, curY);
    }

    ctx.restore();
  }

  /**
   * Dibuja la franja de despeje de seguridad del operario
   */
  drawOperatorClearanceZone(m) {
    const ctx = this.ctx;
    const opEdge = getMachineEdgeSegment(m, m.operatorEdge ?? 0);
    const rad = ((m.rotation || 0) * Math.PI) / 180;
    const depth = 0.80; // 0.80 m zona de acceso

    let outAngle = 0;
    switch ((m.operatorEdge ?? 0) % 4) {
      case 0: outAngle = rad - Math.PI / 2; break;
      case 1: outAngle = rad; break;
      case 2: outAngle = rad + Math.PI / 2; break;
      case 3: outAngle = rad + Math.PI; break;
    }

    const ox = Math.cos(outAngle) * depth;
    const oy = Math.sin(outAngle) * depth;

    const p1 = this.worldToScreen(opEdge.start.x, opEdge.start.y);
    const p2 = this.worldToScreen(opEdge.end.x, opEdge.end.y);
    const p3 = this.worldToScreen(opEdge.end.x + ox, opEdge.end.y + oy);
    const p4 = this.worldToScreen(opEdge.start.x + ox, opEdge.start.y + oy);

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 255, 0, 0.08)'; // Verde tenue operario
    ctx.fill();

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Dibuja el Gizmo de transformación interactivo sobre la máquina seleccionada
   * Sección 5.3: Clic simple: muestra Gizmo. Gizmo de Rotación: Manija circular exterior para giro libre.
   */
  drawMachineGizmo(m) {
    const ctx = this.ctx;
    const corners = getMachineCorners(m);
    const screenCorners = corners.map(c => this.worldToScreen(c.x, c.y));
    const centroid = this.worldToScreen(m.x, m.y);

    // 1. Manija circular exterior de rotación continua
    const rotRad = (m.rotation * Math.PI) / 180;
    // La manija se proyecta en la parte superior (+Y local) de la máquina
    const handleDistWorld = (m.height / 2) + this.gizmoDistanceMeters;
    const handleWorldX = m.x - Math.sin(rotRad) * handleDistWorld;
    const handleWorldY = m.y + Math.cos(rotRad) * handleDistWorld;
    const handleScreen = this.worldToScreen(handleWorldX, handleWorldY);

    // Guardamos la posición del handle en pantalla para hit-testing
    this.currentGizmoHandle = {
      x: handleScreen.x,
      y: handleScreen.y,
      radius: this.gizmoHandleRadius
    };

    // Tallo conector hacia la manija
    const topEdgeMidWorld = {
      x: m.x - Math.sin(rotRad) * (m.height / 2),
      y: m.y + Math.cos(rotRad) * (m.height / 2)
    };
    const topEdgeMidScreen = this.worldToScreen(topEdgeMidWorld.x, topEdgeMidWorld.y);

    ctx.beginPath();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 2]);
    ctx.moveTo(topEdgeMidScreen.x, topEdgeMidScreen.y);
    ctx.lineTo(handleScreen.x, handleScreen.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Círculo exterior de la manija de rotación
    ctx.beginPath();
    ctx.arc(handleScreen.x, handleScreen.y, this.gizmoHandleRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#0284c7';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Ícono de giro dentro de la manija
    ctx.beginPath();
    ctx.arc(handleScreen.x, handleScreen.y, this.gizmoHandleRadius - 3, 0, Math.PI * 1.5);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 2. Indicador de rotación actual en grados
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(m.rotation)}°`, handleScreen.x, handleScreen.y - 12);

    // 3. Indicadores en las 4 esquinas del gizmo
    for (const sc of screenCorners) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(sc.x - 3, sc.y - 3, 6, 6);
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1;
      ctx.strokeRect(sc.x - 3, sc.y - 3, 6, 6);
    }
  }

  /**
   * Dibuja los indicadores de cotas métricas del offset de separación en cada cara
   */
  drawClearanceLabels(m, screenClearance, offsets) {
    const ctx = this.ctx;

    for (let k = 0; k < 4; k++) {
      const offVal = offsets[k];
      if (offVal <= 0.001) continue;

      const p1 = screenClearance[k];
      const p2 = screenClearance[(k + 1) % 4];
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;

      ctx.save();
      const labelText = `+${offVal.toFixed(2)}m`;
      ctx.font = 'bold 8.5px monospace';
      const tw = ctx.measureText(labelText).width;
      const bw = tw + 8;
      const bh = 13;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
      ctx.lineWidth = 1;

      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(midX - bw / 2, midY - bh / 2, bw, bh, 3);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(midX - bw / 2, midY - bh / 2, bw, bh);
        ctx.strokeRect(midX - bw / 2, midY - bh / 2, bw, bh);
      }

      ctx.fillStyle = '#38bdf8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, midX, midY);
      ctx.restore();
    }
  }

  /**
   * Dibuja la guía visual de snap magnético (muro o máquina vecina)
   */
  drawSnapGuide(guide) {
    if (!guide) return;
    const ctx = this.ctx;

    // 1. Snap inter-máquinas con cota textual
    if (guide.text && guide.x1 !== undefined) {
      const p1 = this.worldToScreen(guide.x1, guide.y1);
      const p2 = this.worldToScreen(guide.x2, guide.y2);
      ctx.beginPath();
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#06b6d4'; // Cian snap
      ctx.lineWidth = 2.5;
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();

      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      ctx.fillStyle = '#06b6d4';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(guide.text, midX, midY - 4);
      return;
    }

    // 2. Snap magnético a muro
    if (!guide.wallPoint || !guide.edgeMidpoint) return;
    const pWall = this.worldToScreen(guide.wallPoint.x, guide.wallPoint.y);
    const pEdge = this.worldToScreen(guide.edgeMidpoint.x, guide.edgeMidpoint.y);

    ctx.beginPath();
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#22c55e'; // Verde snap
    ctx.lineWidth = 2;
    ctx.moveTo(pWall.x, pWall.y);
    ctx.lineTo(pEdge.x, pEdge.y);
    ctx.stroke();
    ctx.restore();

    // Texto de cota
    const midX = (pWall.x + pEdge.x) / 2;
    const midY = (pWall.y + pEdge.y) / 2;
    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`Offset: ${guide.offsetValue.toFixed(2)} m`, midX, midY - 4);
  }

  // ==========================================
  // HIT TESTING (INTERACCIÓN)
  // ==========================================

  /**
   * Detecta si se hizo clic sobre la manija circular del Gizmo
   */
  hitTestGizmoHandle(screenX, screenY) {
    if (!this.selectedMachineId || !this.currentGizmoHandle) return false;
    const dx = screenX - this.currentGizmoHandle.x;
    const dy = screenY - this.currentGizmoHandle.y;
    return Math.hypot(dx, dy) <= this.currentGizmoHandle.radius + 6;
  }

  /**
   * Detecta si se hizo clic sobre una entidad colocada.
   * Prioridad de Clic (Hit-Test):
   * 1. Primero evalúa máquinas y mobiliario sólido (hijos/objetos de primer plano).
   * 2. Si no se clicó ningún objeto sólido, evalúa si se tocó una zona/recinto de fondo.
   */
  hitTestMachine(screenX, screenY) {
    const worldPt = this.screenToWorld(screenX, screenY);
    const placed = this.machines.filter(m => m.isPlaced);

    // 1. Probar primero objetos sólidos (mesas, sillas, gabinetes, máquinas)
    for (let i = placed.length - 1; i >= 0; i--) {
      const m = placed[i];
      if (!m.isZone && this.isPointInsideMachine(worldPt.x, worldPt.y, m)) {
        return m;
      }
    }

    // 2. Probar zonas / recintos contenedores
    for (let i = placed.length - 1; i >= 0; i--) {
      const m = placed[i];
      if (m.isZone && this.isPointInsideMachine(worldPt.x, worldPt.y, m)) {
        return m;
      }
    }

    return null;
  }

  /**
   * Detecta si un punto World (wx, wy) cae dentro del rectángulo orientado de una máquina
   */
  isPointInsideMachine(wx, wy, machine) {
    const rad = (-machine.rotation * Math.PI) / 180;
    const dx = wx - machine.x;
    const dy = wy - machine.y;

    const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
    const localY = dx * Math.sin(rad) + dy * Math.cos(rad);

    const hw = machine.width / 2;
    const hh = machine.height / 2;

    return Math.abs(localX) <= hw && Math.abs(localY) <= hh;
  }

  /**
   * Detecta si se hizo clic en una arista específica (0..3) de la máquina seleccionada
   * Tolerancia en píxeles de pantalla: ~10px
   */
  hitTestMachineEdge(screenX, screenY, machine) {
    if (!machine) return null;
    const corners = getMachineCorners(machine);
    const screenCorners = corners.map(c => this.worldToScreen(c.x, c.y));

    let closestEdge = null;
    let minDistance = Infinity;
    const tolerancePx = 12;

    for (let i = 0; i < 4; i++) {
      const p1 = screenCorners[i];
      const p2 = screenCorners[(i + 1) % 4];

      // Distancia de punto a segmento en coordenadas de pantalla
      const vx = p2.x - p1.x;
      const vy = p2.y - p1.y;
      const wx = screenX - p1.x;
      const wy = screenY - p1.y;

      const c1 = vx * wx + vy * wy;
      const c2 = vx * vx + vy * vy;
      let d = Infinity;

      if (c1 <= 0) {
        d = Math.hypot(screenX - p1.x, screenY - p1.y);
      } else if (c2 <= c1) {
        d = Math.hypot(screenX - p2.x, screenY - p2.y);
      } else {
        const b = c1 / c2;
        const pb = { x: p1.x + b * vx, y: p1.y + b * vy };
        d = Math.hypot(screenX - pb.x, screenY - pb.y);
      }

      if (d <= tolerancePx && d < minDistance) {
        minDistance = d;
        closestEdge = i;
      }
    }

    return closestEdge;
  }

  // ==========================================
  // LÍNEAS CONSTRUCTIVAS / GUÍAS DE REFERENCIA
  // ==========================================

  drawConstructionLines() {
    const ctx = this.ctx;
    for (const line of this.constructionLines) {
      const p1 = this.worldToScreen(line.x1, line.y1);
      const p2 = this.worldToScreen(line.x2, line.y2);
      const isSelected = line.id === this.selectedGuidelineId;

      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([8, 5]);
      ctx.strokeStyle = isSelected ? '#ffffff' : (line.color || '#f59e0b'); // Naranja CAD
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // Extremos y punto medio
      ctx.setLineDash([]);
      ctx.fillStyle = isSelected ? '#ffffff' : (line.color || '#f59e0b');
      ctx.fillRect(p1.x - 3, p1.y - 3, 6, 6);
      ctx.fillRect(p2.x - 3, p2.y - 3, 6, 6);

      // Etiqueta de longitud métrica en el centro
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const lengthM = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
      const label = `${lengthM.toFixed(2)} m`;

      ctx.font = 'bold 9px monospace';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = isSelected ? '#b45309' : 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(midX - tw / 2 - 4, midY - 7, tw + 8, 14);
      ctx.strokeStyle = isSelected ? '#ffffff' : (line.color || '#f59e0b');
      ctx.lineWidth = 1;
      ctx.strokeRect(midX - tw / 2 - 4, midY - 7, tw + 8, 14);

      ctx.fillStyle = isSelected ? '#ffffff' : '#fbbf24';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, midX, midY);

      ctx.restore();
    }
  }

  drawTempGuideline(g) {
    const ctx = this.ctx;
    const p1 = this.worldToScreen(g.x1, g.y1);
    const p2 = this.worldToScreen(g.x2, g.y2);

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#38bdf8'; // Azul activo mientras dibuja
    ctx.lineWidth = 2;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(p1.x - 3, p1.y - 3, 6, 6);
    ctx.fillRect(p2.x - 3, p2.y - 3, 6, 6);

    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const lengthM = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
    const label = `${lengthM.toFixed(2)} m`;

    ctx.font = 'bold 10px monospace';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(midX - tw / 2 - 4, midY - 8, tw + 8, 16);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.strokeRect(midX - tw / 2 - 4, midY - 8, tw + 8, 16);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, midX, midY);

    ctx.restore();
  }

  hitTestConstructionLine(screenX, screenY, tolerancePx = 12) {
    for (let i = this.constructionLines.length - 1; i >= 0; i--) {
      const line = this.constructionLines[i];
      const p1 = this.worldToScreen(line.x1, line.y1);
      const p2 = this.worldToScreen(line.x2, line.y2);

      const vx = p2.x - p1.x;
      const vy = p2.y - p1.y;
      const wx = screenX - p1.x;
      const wy = screenY - p1.y;

      const c1 = vx * wx + vy * wy;
      const c2 = vx * vx + vy * vy;
      let d = Infinity;

      if (c1 <= 0) {
        d = Math.hypot(screenX - p1.x, screenY - p1.y);
      } else if (c2 <= c1) {
        d = Math.hypot(screenX - p2.x, screenY - p2.y);
      } else {
        const b = c1 / c2;
        const pb = { x: p1.x + b * vx, y: p1.y + b * vy };
        d = Math.hypot(screenX - pb.x, screenY - pb.y);
      }

      if (d <= tolerancePx) {
        return line;
      }
    }
    return null;
  }
}
