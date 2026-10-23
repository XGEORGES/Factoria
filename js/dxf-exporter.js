/**
 * DXF-EXPORTER.JS
 * Generador de archivos DXF ASCII compatible con AutoCAD (Sección 7).
 * Unidades: Metros (1.0 = 1.0 m).
 * 
 * Capas (Layers):
 * - MUROS: Polilínea cerrada del perímetro (Color 7 - Blanco/Negro)
 * - MAQUINAS_CUERPO: Polilíneas cerradas de los 4 vértices rotados (Color 4 - Cyan)
 * - MAQUINAS_OPERADOR: Segmento de línea 2D de la arista verde de operación (Color 3 - Verde)
 * - ETIQUETAS: Texto centrado con el nombre y dimensiones (Color 7 - Blanco/Negro)
 */

import { PERIMETER_VERTICES, getMachineCorners, getMachineEdgeSegment, getMachineClearanceCorners, getMachineClearanceOffsets } from './geometry.js';

function wrapWordsForDXF(name, availMetricW, charWidth = 0.075) {
  const safeName = (name || '').trim();
  const words = safeName.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [safeName];

  const maxChars = Math.max(10, Math.floor(availMetricW / charWidth));
  const lines = [];
  let cur = words[0];

  for (let i = 1; i < words.length; i++) {
    const test = cur + ' ' + words[i];
    if (test.length <= maxChars) {
      cur = test;
    } else {
      lines.push(cur);
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines;
}

export function generateDXF(machines = [], constructionLines = []) {
  const placedMachines = machines.filter(m => m.isPlaced);

  let dxf = '';

  // HEADER SECTION
  dxf += '0\nSECTION\n';
  dxf += '2\nHEADER\n';
  dxf += '9\n$ACADVER\n1\nAC1009\n'; // AutoCAD R12 ASCII (máxima compatibilidad universal)
  dxf += '9\n$INSUNITS\n70\n6\n';     // 6 = Metros
  dxf += '0\nENDSEC\n';

  // TABLES SECTION (Layers con colores estándar)
  dxf += '0\nSECTION\n';
  dxf += '2\nTABLES\n';
  dxf += '0\nTABLE\n';
  dxf += '2\nLAYER\n';
  dxf += '70\n7\n';

  // Layer MUROS: Color 7 (Blanco/Negro)
  dxf += '0\nLAYER\n2\nMUROS\n70\n0\n62\n7\n6\nCONTINUOUS\n';
  // Layer ZONAS_RECINTOS: Color 6 (Magenta)
  dxf += '0\nLAYER\n2\nZONAS_RECINTOS\n70\n0\n62\n6\n6\nCONTINUOUS\n';
  // Layer MAQUINAS_CUERPO: Color 4 (Cyan)
  dxf += '0\nLAYER\n2\nMAQUINAS_CUERPO\n70\n0\n62\n4\n6\nCONTINUOUS\n';
  // Layer MAQUINAS_OPERADOR: Color 3 (Verde)
  dxf += '0\nLAYER\n2\nMAQUINAS_OPERADOR\n70\n0\n62\n3\n6\nCONTINUOUS\n';
  // Layer MAQUINAS_OFFSET: Color 8 (Gris de seguridad/clearance)
  dxf += '0\nLAYER\n2\nMAQUINAS_OFFSET\n70\n0\n62\n8\n6\nCONTINUOUS\n';
  // Layer ETIQUETAS: Color 7 (Blanco/Negro)
  dxf += '0\nLAYER\n2\nETIQUETAS\n70\n0\n62\n7\n6\nCONTINUOUS\n';
  // Layer LINEAS_GUIA: Color 2 (Amarillo)
  dxf += '0\nLAYER\n2\nLINEAS_GUIA\n70\n0\n62\n2\n6\nCONTINUOUS\n';

  dxf += '0\nENDTAB\n';
  dxf += '0\nENDSEC\n';

  // ENTITIES SECTION
  dxf += '0\nSECTION\n';
  dxf += '2\nENTITIES\n';

  // 1. Perímetro del Taller (Layer MUROS)
  dxf += '0\nPOLYLINE\n';
  dxf += '8\nMUROS\n';
  dxf += '66\n1\n'; // Siguen vértices
  dxf += '70\n1\n'; // Polilínea cerrada

  for (const v of PERIMETER_VERTICES) {
    dxf += '0\nVERTEX\n';
    dxf += '8\nMUROS\n';
    dxf += `10\n${v.x.toFixed(4)}\n`;
    dxf += `20\n${v.y.toFixed(4)}\n`;
    dxf += '30\n0.0\n';
  }
  dxf += '0\nSEQEND\n';

  // 2. Máquinas y Zonas colocadas
  for (const m of placedMachines) {
    const corners = getMachineCorners(m);
    const bodyLayer = m.isZone ? 'ZONAS_RECINTOS' : 'MAQUINAS_CUERPO';

    // 2.1 Contorno perimetral (Layer MAQUINAS_CUERPO o ZONAS_RECINTOS)
    dxf += '0\nPOLYLINE\n';
    dxf += `8\n${bodyLayer}\n`;
    dxf += '66\n1\n';
    dxf += '70\n1\n'; // Cerrada

    for (const c of corners) {
      dxf += '0\nVERTEX\n';
      dxf += `8\n${bodyLayer}\n`;
      dxf += `10\n${c.x.toFixed(4)}\n`;
      dxf += `20\n${c.y.toFixed(4)}\n`;
      dxf += '30\n0.0\n';
    }
    dxf += '0\nSEQEND\n';

    // 2.1.5 Buffer de Separación / Clearance entre Máquinas (Layer MAQUINAS_OFFSET)
    const clearanceOffsets = getMachineClearanceOffsets(m);
    if (clearanceOffsets.some(v => v > 0)) {
      const clearanceCorners = getMachineClearanceCorners(m);
      dxf += '0\nPOLYLINE\n';
      dxf += '8\nMAQUINAS_OFFSET\n';
      dxf += '66\n1\n';
      dxf += '70\n1\n'; // Cerrada
      for (const cc of clearanceCorners) {
        dxf += '0\nVERTEX\n';
        dxf += '8\nMAQUINAS_OFFSET\n';
        dxf += `10\n${cc.x.toFixed(4)}\n`;
        dxf += `20\n${cc.y.toFixed(4)}\n`;
        dxf += '30\n0.0\n';
      }
      dxf += '0\nSEQEND\n';
    }

    // 2.2 Arista de Operador (Layer MAQUINAS_OPERADOR) - Línea 2D
    const opEdge = getMachineEdgeSegment(m, m.operatorEdge ?? 0);
    dxf += '0\nLINE\n';
    dxf += '8\nMAQUINAS_OPERADOR\n';
    dxf += `10\n${opEdge.start.x.toFixed(4)}\n`;
    dxf += `20\n${opEdge.start.y.toFixed(4)}\n`;
    dxf += '30\n0.0\n';
    dxf += `11\n${opEdge.end.x.toFixed(4)}\n`;
    dxf += `21\n${opEdge.end.y.toFixed(4)}\n`;
    dxf += '31\n0.0\n';

    // 2.3 Etiquetas (Layer ETIQUETAS) - Texto centrado con auto-ajuste multilínea adaptado a la rotación
    const mRot = typeof m.rotation === 'number' && !isNaN(m.rotation) ? m.rotation : 0;
    const labelRot = typeof m.labelRotation === 'number' && !isNaN(m.labelRotation) ? ((m.labelRotation % 360 + 360) % 360) : 0;
    const textAngle = ((mRot + labelRot) % 360 + 360) % 360;
    const isPerpendicular = (labelRot % 180 !== 0);

    const availMetricW = (isPerpendicular ? m.height : m.width) * 0.88;
    const availMetricH = (isPerpendicular ? m.width : m.height) * 0.88;

    const nameLines = wrapWordsForDXF(m.name, availMetricW);
    const dimsText = `${m.width.toFixed(2)} x ${m.height.toFixed(2)} m`;

    // Vector unitario perpendicular a la dirección del texto (para apilar filas limpiamente)
    const textRad = (textAngle * Math.PI) / 180;
    const perpX = -Math.sin(textRad);
    const perpY = Math.cos(textRad);

    const textHeight = Math.min(0.20, Math.max(0.09, availMetricH / (nameLines.length + 1.8)));
    const dimTextHeight = Math.max(0.07, textHeight * 0.75);
    const lineSpacing = textHeight * 1.35;

    const allLines = [...nameLines.map(t => ({ text: t, h: textHeight }))];
    if (availMetricH >= (allLines.length + 1) * lineSpacing * 0.85) {
      allLines.push({ text: dimsText, h: dimTextHeight });
    }

    const totalLines = allLines.length;
    for (let k = 0; k < totalLines; k++) {
      const lineObj = allLines[k];
      const offsetDist = ((totalLines - 1) / 2 - k) * lineSpacing;
      const lx = m.x + perpX * offsetDist;
      const ly = m.y + perpY * offsetDist;

      dxf += '0\nTEXT\n';
      dxf += '8\nETIQUETAS\n';
      dxf += `10\n${lx.toFixed(4)}\n`;
      dxf += `20\n${ly.toFixed(4)}\n`;
      dxf += '30\n0.0\n';
      dxf += `40\n${lineObj.h.toFixed(3)}\n`;
      dxf += `50\n${textAngle.toFixed(2)}\n`;
      dxf += `1\n${lineObj.text}\n`;
      dxf += '72\n1\n'; // Centrado horizontal
      dxf += `11\n${lx.toFixed(4)}\n`;
      dxf += `21\n${ly.toFixed(4)}\n`;
      dxf += '31\n0.0\n';
      dxf += '73\n2\n'; // Centrado vertical
    }
  }

  // 3. Líneas constructivas / Guías de referencia (Layer LINEAS_GUIA)
  for (const line of constructionLines) {
    dxf += '0\nLINE\n';
    dxf += '8\nLINEAS_GUIA\n';
    dxf += `10\n${line.x1.toFixed(4)}\n`;
    dxf += `20\n${line.y1.toFixed(4)}\n`;
    dxf += '30\n0.0\n';
    dxf += `11\n${line.x2.toFixed(4)}\n`;
    dxf += `21\n${line.y2.toFixed(4)}\n`;
    dxf += '31\n0.0\n';
  }

  dxf += '0\nENDSEC\n';
  dxf += '0\nEOF\n';

  return dxf;
}

/**
 * Dispara la descarga del archivo DXF en el navegador
 */
export function downloadDXF(machines, constructionLines = [], filename = 'taller_cnc_layout.dxf') {
  const content = generateDXF(machines, constructionLines);
  const blob = new Blob([content], { type: 'application/dxf;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
