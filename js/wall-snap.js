/**
 * WALL-SNAP.JS
 * Lógica de Snap Magnético a Muros con Offset Paramétrico (Sección 6.2).
 * 
 * Reglas:
 * 1. Calcula la distancia al segmento de muro más cercano.
 * 2. Si distancia < 0.60 m (y no se pulsa Ctrl o Shift):
 *    - Calcula pendiente del segmento.
 *    - Rota la máquina para que su arista 'offsetEdge' quede paralela al muro.
 *    - Posiciona la máquina para que 'offsetEdge' quede exactamente a 'wallOffset' metros.
 */

import { getWallSegments, pointToSegmentDistance, getMachineCorners, getMachineEdgeSegment } from './geometry.js';

export const SNAP_TRIGGER_DISTANCE = 0.60; // 0.60 m según especificación 6.2

/**
 * Obtiene el ángulo local y la distancia desde el centroide para una arista dada (0..3)
 * Aristas:
 * 0: Frontal  -> local normal apunta a -Y (270° o -90°), semieje H/2
 * 1: Derecho  -> local normal apunta a +X (0°),        semieje W/2
 * 2: Trasero  -> local normal apunta a +Y (90°),       semieje H/2
 * 3: Izquierdo-> local normal apunta a -X (180°),      semieje W/2
 */
export function getEdgeLocalMetrics(machine, edgeIndex) {
  const edge = (edgeIndex ?? 2) % 4;
  let localAngleDeg = 0;
  let halfDimension = 0;

  switch (edge) {
    case 0: // Frontal
      localAngleDeg = -90;
      halfDimension = machine.height / 2;
      break;
    case 1: // Derecho
      localAngleDeg = 0;
      halfDimension = machine.width / 2;
      break;
    case 2: // Trasero
      localAngleDeg = 90;
      halfDimension = machine.height / 2;
      break;
    case 3: // Izquierdo
      localAngleDeg = 180;
      halfDimension = machine.width / 2;
      break;
  }

  return { edge, localAngleDeg, halfDimension };
}

/**
 * Evalúa y aplica el snap magnético a muros si la máquina está a menos de 0.60 m
 * @param {Object} machine Entidad máquina con x, y, width, height, rotation, offsetEdge, wallOffset
 * @param {Object} options Opciones de entrada { disableSnap: boolean }
 * @returns {Object} { snapped: boolean, snappedMachine, wall, distance, snapGuide }
 */
export function evaluateWallSnap(machine, options = {}) {
  if (options.disableSnap) {
    return { snapped: false };
  }

  const walls = getWallSegments();
  const corners = getMachineCorners(machine);
  const offsetEdgeMetrics = getEdgeLocalMetrics(machine, machine.offsetEdge);
  const offsetEdgeSegment = getMachineEdgeSegment(machine, machine.offsetEdge);

  let closestWall = null;
  let minDistance = Infinity;
  let bestProjection = null;

  // Evaluamos distancia desde la arista de offset y las esquinas al muro
  const testPoints = [
    offsetEdgeSegment.midpoint,
    offsetEdgeSegment.start,
    offsetEdgeSegment.end,
    ...corners
  ];

  for (const wall of walls) {
    for (const pt of testPoints) {
      const res = pointToSegmentDistance(pt.x, pt.y, wall.start, wall.end);
      if (res.distance < minDistance) {
        minDistance = res.distance;
        closestWall = wall;
        bestProjection = res.closestPoint;
      }
    }
  }

  // Si la distancia mínima es menor a 0.60m, activamos el Snap Magnético
  if (closestWall && minDistance < SNAP_TRIGGER_DISTANCE) {
    const wall = closestWall;
    const wallOffset = machine.wallOffset !== undefined ? machine.wallOffset : 0.80;

    // Normal interior del muro (apunta al interior del taller)
    const nx = wall.normal.x;
    const ny = wall.normal.y;

    // Queremos que la arista de offset apunte hacia el muro (dirección opuesta a la normal interior)
    const targetOutwardAngleRad = Math.atan2(-ny, -nx);
    const targetOutwardAngleDeg = (targetOutwardAngleRad * 180 / Math.PI + 360) % 360;

    // Calculamos la rotación requerida para la máquina:
    // rotation + localAngleDeg = targetOutwardAngleDeg
    let newRotationDeg = (targetOutwardAngleDeg - offsetEdgeMetrics.localAngleDeg + 360) % 360;

    // Posición del centroide:
    // Proyección del centroide actual sobre el segmento de muro
    const projRes = pointToSegmentDistance(machine.x, machine.y, wall.start, wall.end);
    const basePt = projRes.closestPoint;

    // Distancia deseada desde la línea base del muro hasta el centroide
    const totalDistFromWall = offsetEdgeMetrics.halfDimension + wallOffset;

    // Nuevo centroide desplazado a lo largo de la normal interior del taller
    const newX = basePt.x + nx * totalDistFromWall;
    const newY = basePt.y + ny * totalDistFromWall;

    // Clon de máquina con snap aplicado
    const snappedMachine = {
      ...machine,
      x: Number(newX.toFixed(3)),
      y: Number(newY.toFixed(3)),
      rotation: Number(newRotationDeg.toFixed(1))
    };

    // Guía visual para dibujar cota de snap
    const snappedEdge = getMachineEdgeSegment(snappedMachine, machine.offsetEdge);
    const snapGuide = {
      wallStart: wall.start,
      wallEnd: wall.end,
      edgeMidpoint: snappedEdge.midpoint,
      wallPoint: basePt,
      offsetValue: wallOffset,
      wallName: wall.name
    };

    return {
      snapped: true,
      snappedMachine,
      wall,
      distance: minDistance,
      snapGuide
    };
  }

  return { snapped: false };
}
