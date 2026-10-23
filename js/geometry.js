/**
 * GEOMETRY.JS
 * Geometría perimetral del taller CNC y matemáticas 2D vectoriales.
 * Sistema de coordenadas: 1 unidad interna = 1.0 metro.
 * Origen (0,0) en la esquina inferior izquierda.
 */

// Vértices perimetrales fijos (Sentido horario / antihorario según especificación)
export const PERIMETER_VERTICES = [
  { x: 0.00,  y: 0.00,  name: 'V0', desc: 'Inicio frente (Esquina a 90° con Lateral Izq)' },
  { x: 23.50, y: 0.00,  name: 'V1', desc: 'Fin frente / Ingreso (23.50 m, Esquina a 90° con Lateral Der)' },
  { x: 23.50, y: 33.51, name: 'V2', desc: 'Fin lateral derecho recto a 90° (Tramo 33.51 m)' },
  { x: 27.03, y: 38.87, name: 'V3', desc: 'Quiebre derecho inclinado (Tramo 6.42 m, ángulo 56.65°)' },
  { x: 7.40,  y: 51.79, name: 'V4', desc: 'Muro posterior (Tramo 23.50 m, perpendicular a los inclinados)' },
  { x: 0.00,  y: 40.55, name: 'V5', desc: 'Fin tramo izquierdo inclinado (13.46 m, 56.65°) e inicio lateral izq recto a 90°' }
  // Cierre a V0: Lateral izquierdo recto (Tramo 40.55 m, perpendicular a 90° con el frente)
];

export const WALL_THICKNESS = 0.25; // 0.25 m grosor visual de muro

/**
 * Segmentos de muro que conforman el perímetro
 */
export function getWallSegments() {
  const segments = [];
  const n = PERIMETER_VERTICES.length;
  for (let i = 0; i < n; i++) {
    const p1 = PERIMETER_VERTICES[i];
    const p2 = PERIMETER_VERTICES[(i + 1) % n];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.hypot(dx, dy);
    const angleRad = Math.atan2(dy, dx);
    const angleDeg = (angleRad * 180 / Math.PI + 360) % 360;
    
    // Normal interna del segmento (apuntando al interior del taller)
    // El perímetro recorre en sentido antihorario:
    // normal a la izquierda = (-dy/length, dx/length)
    const nx = -dy / length;
    const ny = dx / length;

    segments.push({
      index: i,
      start: p1,
      end: p2,
      dx,
      dy,
      length,
      angleRad,
      angleDeg,
      normal: { x: nx, y: ny },
      name: `${p1.name} → ${p2.name}`
    });
  }
  return segments;
}

/**
 * Cálculo del área total del polígono usando la fórmula Shoelace (Gauss)
 */
export function calculatePerimeterArea() {
  const n = PERIMETER_VERTICES.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p1 = PERIMETER_VERTICES[i];
    const p2 = PERIMETER_VERTICES[(i + 1) % n];
    sum += (p1.x * p2.y) - (p1.y * p2.x);
  }
  return Math.abs(sum) / 2;
}

/**
 * Bounding Box del taller en metros
 */
export function getWorkshopBounds() {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const v of PERIMETER_VERTICES) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

/**
 * Comprueba si un punto (x, y) en metros está dentro del polígono del taller (Ray Casting)
 */
export function isPointInsidePerimeter(px, py) {
  const vertices = PERIMETER_VERTICES;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Obtiene los 4 vértices en coordenadas World de una máquina dada su posición, tamaño y rotación
 * operatorEdge: 0 = Frontal (-Y local), 1 = Derecho (+X local), 2 = Trasero (+Y local), 3 = Izquierdo (-X local)
 */
export function getMachineCorners(machine) {
  const { x, y, width, height, rotation = 0 } = machine;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const hw = width / 2;
  const hh = height / 2;

  // 4 esquinas relativas al centroide (sentido horario):
  // 0: Abajo-Izquierda (-hw, -hh)
  // 1: Abajo-Derecha   (+hw, -hh)
  // 2: Arriba-Derecha  (+hw, +hh)
  // 3: Arriba-Izquierda(-hw, +hh)
  const localCorners = [
    { x: -hw, y: -hh },
    { x:  hw, y: -hh },
    { x:  hw, y:  hh },
    { x: -hw, y:  hh }
  ];

  return localCorners.map(pt => ({
    x: x + (pt.x * cos - pt.y * sin),
    y: y + (pt.x * sin + pt.y * cos)
  }));
}

/**
 * Obtiene el segmento de una arista específica de la máquina (0..3)
 * Aristas:
 * 0: Frontal  (Corner 0 -> Corner 1, lado inferior en rotación 0)
 * 1: Derecho  (Corner 1 -> Corner 2, lado derecho en rotación 0)
 * 2: Trasero  (Corner 2 -> Corner 3, lado superior en rotación 0)
 * 3: Izquierdo(Corner 3 -> Corner 0, lado izquierdo en rotación 0)
 */
export function getMachineEdgeSegment(machine, edgeIndex) {
  const corners = getMachineCorners(machine);
  const idx1 = (((edgeIndex ?? 0) % 4) + 4) % 4;
  const idx2 = (idx1 + 1) % 4;
  const p1 = corners[idx1];
  const p2 = corners[idx2];
  return {
    start: p1,
    end: p2,
    midpoint: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  };
}

/**
 * Obtiene los offsets métricos de separación de las 4 caras [Frontal, Derecho, Trasero, Izquierdo]
 */
export function getMachineClearanceOffsets(machine) {
  if (Array.isArray(machine?.clearanceOffsets) && machine.clearanceOffsets.length === 4) {
    return machine.clearanceOffsets.map(v => Math.max(0, Number(v) || 0));
  }
  return [0.00, 0.00, 0.00, 0.00]; // Default estrictamente 0.00 m si no está definido
}

/**
 * Calcula los 4 vértices del contorno expandido de clearance en metros (Buffer de seguridad)
 * 0: Frontal  (-Y local)
 * 1: Derecho  (+X local)
 * 2: Trasero  (+Y local)
 * 3: Izquierdo(-X local)
 */
export function getMachineClearanceCorners(machine) {
  const { x, y, width, height, rotation = 0 } = machine;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const hw = width / 2;
  const hh = height / 2;
  const [front, right, back, left] = getMachineClearanceOffsets(machine);

  const localCorners = [
    { x: -hw - left,  y: -hh - front },
    { x:  hw + right, y: -hh - front },
    { x:  hw + right, y:  hh + back  },
    { x: -hw - left,  y:  hh + back  }
  ];

  return localCorners.map(pt => ({
    x: x + (pt.x * cos - pt.y * sin),
    y: y + (pt.x * sin + pt.y * cos)
  }));
}

/**
 * Obtiene el segmento de una arista del contorno de clearance de la máquina (0..3)
 */
export function getMachineClearanceEdgeSegment(machine, edgeIndex) {
  const corners = getMachineClearanceCorners(machine);
  const idx1 = (((edgeIndex ?? 0) % 4) + 4) % 4;
  const idx2 = (idx1 + 1) % 4;
  const p1 = corners[idx1];
  const p2 = corners[idx2];
  return {
    start: p1,
    end: p2,
    midpoint: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  };
}

/**
 * Obtiene el polígono de la zona del operador (profundidad configurable, default 0.80 m)
 */
export function getOperatorZonePolygon(machine, depth = 0.80) {
  const edge = getMachineEdgeSegment(machine, machine.operatorEdge ?? 0);
  const dx = edge.end.x - edge.start.x;
  const dy = edge.end.y - edge.start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];

  // Normal saliente hacia afuera de la máquina
  // El contorno es en sentido antihorario/horario:
  // Normal hacia afuera para arista i:
  const rad = ((machine.rotation || 0) * Math.PI) / 180;
  // Ángulo de la arista hacia el exterior
  let outAngle = 0;
  switch (machine.operatorEdge % 4) {
    case 0: outAngle = rad - Math.PI / 2; break; // Frontal hacia -Y local
    case 1: outAngle = rad; break;                // Derecho hacia +X local
    case 2: outAngle = rad + Math.PI / 2; break; // Trasero hacia +Y local
    case 3: outAngle = rad + Math.PI; break;     // Izquierdo hacia -X local
  }

  const ox = Math.cos(outAngle) * depth;
  const oy = Math.sin(outAngle) * depth;

  return [
    edge.start,
    edge.end,
    { x: edge.end.x + ox, y: edge.end.y + oy },
    { x: edge.start.x + ox, y: edge.start.y + oy }
  ];
}

/**
 * Distancia mínima y punto más cercano de un punto a un segmento de línea
 */
export function pointToSegmentDistance(px, py, segStart, segEnd) {
  const vx = segEnd.x - segStart.x;
  const vy = segEnd.y - segStart.y;
  const wx = px - segStart.x;
  const wy = py - segStart.y;

  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) {
    const d = Math.hypot(px - segStart.x, py - segStart.y);
    return { distance: d, closestPoint: { x: segStart.x, y: segStart.y } };
  }

  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) {
    const d = Math.hypot(px - segEnd.x, py - segEnd.y);
    return { distance: d, closestPoint: { x: segEnd.x, y: segEnd.y } };
  }

  const b = c1 / c2;
  const pb = { x: segStart.x + b * vx, y: segStart.y + b * vy };
  const d = Math.hypot(px - pb.x, py - pb.y);
  return { distance: d, closestPoint: pb };
}

/**
 * Detección de colisión entre dos polígonos convexos orientados usando SAT (Teorema de Ejes Separadores)
 */
export function checkPolygonPolygonCollision(poly1, poly2) {
  const getAxes = (corners) => {
    const axes = [];
    for (let i = 0; i < corners.length; i++) {
      const p1 = corners[i];
      const p2 = corners[(i + 1) % corners.length];
      const edge = { x: p2.x - p1.x, y: p2.y - p1.y };
      const normal = { x: -edge.y, y: edge.x };
      const len = Math.hypot(normal.x, normal.y);
      if (len > 0.0001) {
        axes.push({ x: normal.x / len, y: normal.y / len });
      }
    }
    return axes;
  };

  const project = (corners, axis) => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of corners) {
      const dot = p.x * axis.x + p.y * axis.y;
      if (dot < min) min = dot;
      if (dot > max) max = dot;
    }
    return { min, max };
  };

  const axes = [...getAxes(poly1), ...getAxes(poly2)];
  const EPS = 0.001; // Tolerancia milimétrica para evitar falsos positivos en contacto exacto / snap
  for (const axis of axes) {
    const proj1 = project(poly1, axis);
    const proj2 = project(poly2, axis);
    if (proj1.max < proj2.min + EPS || proj2.max < proj1.min + EPS) {
      return false; // Existe un eje de separación
    }
  }
  return true; // Hay solapamiento en todos los ejes
}

/**
 * Detección de colisión entre dos máquinas usando el Teorema de Ejes Separadores (SAT)
 * Comprueba tanto el solape físico como la invasión de las zonas de clearance/offset configuradas.
 */
export function checkMachineMachineCollision(m1, m2) {
  const clearance1 = getMachineClearanceCorners(m1);
  const clearance2 = getMachineClearanceCorners(m2);
  return checkPolygonPolygonCollision(clearance1, clearance2);
}

/**
 * Detección de colisión estricta entre cuerpos físicos (sin considerar offsets de seguridad)
 */
export function checkMachineBodyCollision(m1, m2) {
  const corners1 = getMachineCorners(m1);
  const corners2 = getMachineCorners(m2);
  return checkPolygonPolygonCollision(corners1, corners2);
}

/**
 * Comprueba si todas las esquinas de una máquina están completamente dentro del perímetro del taller
 */
export function isMachineFullyInsidePerimeter(machine) {
  const corners = getMachineCorners(machine);
  for (const c of corners) {
    if (!isPointInsidePerimeter(c.x, c.y)) {
      return false;
    }
  }
  return true;
}

/**
 * Comprueba si el contorno de clearance de una máquina está completamente dentro del taller
 */
export function isMachineClearanceInsidePerimeter(machine) {
  const corners = getMachineClearanceCorners(machine);
  for (const c of corners) {
    if (!isPointInsidePerimeter(c.x, c.y)) {
      return false;
    }
  }
  return true;
}

/**
 * Evalúa el acoplamiento magnético (snap) entre la máquina en movimiento y otras máquinas colocadas,
 * respetando los offsets métricos configurados en cada cara.
 */
export function evaluateInterMachineSnap(movingMachine, otherMachines = [], options = {}) {
  if (options.disableSnap) return { snapped: false };

  const SNAP_DIST = 0.35; // Umbral de atracción magnética en metros
  let bestSnap = null;
  let minGap = Infinity;

  const movingClearanceCorners = getMachineClearanceCorners(movingMachine);
  const movingClearanceOffsets = getMachineClearanceOffsets(movingMachine);

  for (const other of otherMachines) {
    if (!other.isPlaced || other.id === movingMachine.id) continue;

    // Pre-filtro rápido por distancia entre centroides
    const distCentroids = Math.hypot(movingMachine.x - other.x, movingMachine.y - other.y);
    const maxRadius = (movingMachine.width + movingMachine.height + other.width + other.height) * 0.75 + 1.5;
    if (distCentroids > maxRadius) continue;

    const otherClearanceCorners = getMachineClearanceCorners(other);
    const otherClearanceOffsets = getMachineClearanceOffsets(other);

    // Iteramos por las 4 aristas de clearance de la otra máquina
    for (let j = 0; j < 4; j++) {
      const oP1 = otherClearanceCorners[j];
      const oP2 = otherClearanceCorners[(j + 1) % 4];
      const oDx = oP2.x - oP1.x;
      const oDy = oP2.y - oP1.y;
      const oLen = Math.hypot(oDx, oDy);
      if (oLen < 0.001) continue;

      const nx = -oDy / oLen;
      const ny = oDx / oLen;

      const toMidX = (oP1.x + oP2.x) / 2 - other.x;
      const toMidY = (oP1.y + oP2.y) / 2 - other.y;
      let outNx = nx;
      let outNy = ny;
      if (outNx * toMidX + outNy * toMidY < 0) {
        outNx = -outNx;
        outNy = -outNy;
      }

      // Verificamos la distancia desde cada vértice de clearance de movingMachine a esta cara de 'other'
      for (const mPt of movingClearanceCorners) {
        const signedDist = (mPt.x - (oP1.x + oP2.x) / 2) * outNx + (mPt.y - (oP1.y + oP2.y) / 2) * outNy;
        
        const tx = -outNy;
        const ty = outNx;
        const projT = (mPt.x - oP1.x) * tx + (mPt.y - oP1.y) * ty;

        if (projT >= -0.25 && projT <= oLen + 0.25) {
          if (signedDist > -0.15 && signedDist < SNAP_DIST) {
            const gap = Math.abs(signedDist);
            if (gap < minGap) {
              minGap = gap;
              const corrX = -signedDist * outNx;
              const corrY = -signedDist * outNy;

              bestSnap = {
                snapped: true,
                snappedMachine: {
                  ...movingMachine,
                  x: Number((movingMachine.x + corrX).toFixed(2)),
                  y: Number((movingMachine.y + corrY).toFixed(2))
                },
                otherMachine: other,
                snapGuide: {
                  x1: (oP1.x + oP2.x) / 2,
                  y1: (oP1.y + oP2.y) / 2,
                  x2: (oP1.x + oP2.x) / 2 + outNx * 0.8,
                  y2: (oP1.y + oP2.y) / 2 + outNy * 0.8,
                  text: `SNAP OFFSET: ${(otherClearanceOffsets[j] + movingClearanceOffsets[(j + 2) % 4]).toFixed(2)}m`
                }
              };
            }
          }
        }
      }
    }
  }

  return bestSnap || { snapped: false };
}

/**
 * Encuentra el muro más cercano a una posición o arista
 */
export function findClosestWall(px, py) {
  const walls = getWallSegments();
  let closest = null;
  let minDistance = Infinity;

  for (const wall of walls) {
    const res = pointToSegmentDistance(px, py, wall.start, wall.end);
    if (res.distance < minDistance) {
      minDistance = res.distance;
      closest = {
        wall,
        distance: res.distance,
        closestPoint: res.closestPoint
      };
    }
  }
  return closest;
}
