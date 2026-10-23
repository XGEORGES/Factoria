import { INITIAL_MACHINES_CATALOG, createFreshInventory } from './js/catalog.js';
import { PERIMETER_VERTICES, calculatePerimeterArea, checkMachineMachineCollision, isMachineFullyInsidePerimeter, getMachineClearanceOffsets, getMachineClearanceCorners, checkMachineBodyCollision, evaluateInterMachineSnap, isMachineInsideZone, getZoneInnerWallSegments } from './js/geometry.js';
import { evaluateWallSnap } from './js/wall-snap.js';
import { generateDXF } from './js/dxf-exporter.js';
import { validateLayoutData } from './js/storage.js';

console.log('--- TEST 1: CATALOG OF EXACTLY 29 MACHINES AND BASE GEOMETRY ---');
const catalog = createFreshInventory();
if (catalog.length !== 29) throw new Error(`Expected 29 machines, got ${catalog.length}`);
console.log('Catalog check passed: exactly 29 machines');

// Verify dimensions of requested machines
const findMach = (name) => catalog.find(m => m.name.toUpperCase().includes(name.toUpperCase()));

const rAsientos = findMach('RECTIFICADORA DE ASIENTOS');
if (!rAsientos || rAsientos.width !== 1.60 || rAsientos.height !== 0.80) {
  throw new Error(`RECTIFICADORA DE ASIENTOS dimensions mismatch: expected 1.6x0.8, got ${rAsientos?.width}x${rAsientos?.height}`);
}

const rCilindros = findMach('RECTIFICADORA DE CILINDROS');
if (!rCilindros || rCilindros.width !== 1.90 || rCilindros.height !== 1.50) {
  throw new Error(`RECTIFICADORA DE CILINDROS dimensions mismatch: expected 1.9x1.5, got ${rCilindros?.width}x${rCilindros?.height}`);
}

const cTornillo = findMach('COMPRESOR DE TORNILLO');
if (!cTornillo || cTornillo.width !== 1.00 || cTornillo.height !== 1.00) {
  throw new Error(`COMPRESOR DE TORNILLO dimensions mismatch: expected 1.0x1.0, got ${cTornillo?.width}x${cTornillo?.height}`);
}

const tornoConv = findMach('TORNO CONVENCIONAL');
if (!tornoConv || tornoConv.width !== 3.60 || tornoConv.height !== 1.30) {
  throw new Error(`TORNO CONVENCIONAL dimensions mismatch: expected 3.6x1.3, got ${tornoConv?.width}x${tornoConv?.height}`);
}

const gabiniete = findMach('GABINETE');
if (!gabiniete || gabiniete.width !== 1.30 || gabiniete.height !== 0.70) {
  throw new Error(`GABINETE dimensions mismatch: expected 1.3x0.7, got ${gabiniete?.width}x${gabiniete?.height}`);
}

const rValvulas = findMach('RECTIFICADORA DE VÁLVULAS');
if (!rValvulas || rValvulas.width !== 0.60 || rValvulas.height !== 0.50) {
  throw new Error(`RECTIFICADORA DE VÁLVULAS dimensions mismatch: expected 0.6x0.5, got ${rValvulas?.width}x${rValvulas?.height}`);
}

const pHidro = findMach('PRUEBAS HIDROSTÁTICAS');
if (!pHidro || pHidro.width !== 1.80 || pHidro.height !== 0.70) {
  throw new Error(`PRUEBAS HIDROSTÁTICAS dimensions mismatch: expected 1.8x0.7, got ${pHidro?.width}x${pHidro?.height}`);
}

const cLeadwell = findMach('CENTRO LEADWELL');
if (!cLeadwell || cLeadwell.width !== 2.40 || cLeadwell.height !== 2.90) {
  throw new Error(`CENTRO LEADWELL dimensions mismatch: expected 2.4x2.9, got ${cLeadwell?.width}x${cLeadwell?.height}`);
}

console.log('Specific machine dimensions verified: PASSED');

// Verify default clearance is 0.00 on all 4 faces
const nonZeroClearance = catalog.find(m => m.clearanceOffsets.some(v => v !== 0));
if (nonZeroClearance) {
  throw new Error(`Machine ${nonZeroClearance.name} has non-zero default clearance: ${JSON.stringify(nonZeroClearance.clearanceOffsets)}`);
}
// Verify fallback of getMachineClearanceOffsets is strictly [0, 0, 0, 0]
const fallbackClr = getMachineClearanceOffsets({});
if (fallbackClr.some(v => v !== 0)) {
  throw new Error(`Fallback clearance must be 0, got ${JSON.stringify(fallbackClr)}`);
}
console.log('Default clearance offsets are 0.00 across all catalog machines & fallbacks: PASSED');

const area = calculatePerimeterArea();
console.log(`Perimeter area: ${area.toFixed(2)} m2 (expected 1103.74)`);
if (Math.abs(area - 1103.74) > 0.05) throw new Error('Perimeter area mismatch');

console.log('--- TEST 2: MULTI-INSTANCE & QUANTITY MANAGEMENT ---');
// Simulating placing 2 Compressors and 2 Conventional Lathes
const comp1 = {
  id: 'inst_compresor_1',
  catalogId: cTornillo.id,
  name: 'COMPRESOR DE TORNILLO #1',
  width: cTornillo.width,
  height: cTornillo.height,
  x: 5.0,
  y: 10.0,
  rotation: 0,
  operatorEdge: 0,
  offsetEdge: 2,
  wallOffset: 0.80,
  clearanceOffsets: [0.5, 0.5, 0.5, 0.5],
  isPlaced: true
};

const comp2 = {
  id: 'inst_compresor_2',
  catalogId: cTornillo.id,
  name: 'COMPRESOR DE TORNILLO #2',
  width: cTornillo.width,
  height: cTornillo.height,
  x: 8.0,
  y: 10.0,
  rotation: 0,
  operatorEdge: 0,
  offsetEdge: 2,
  wallOffset: 0.80,
  clearanceOffsets: [0.5, 0.5, 0.5, 0.5],
  isPlaced: true
};

// Check no collision between distant copies
if (checkMachineMachineCollision(comp1, comp2)) throw new Error('Distant instances should not collide');
console.log('Multiple instances of same catalog machine: PASSED');

// Check collision when too close
const comp2_close = { ...comp2, x: 6.5 }; // distance 1.5m, but width 1.0 + clearance 1.0 = 2.0m required
if (!checkMachineMachineCollision(comp1, comp2_close)) throw new Error('Close instances must detect clearance collision');
console.log('Clearance collision between multiple instances: PASSED');

// Set labelRotation to 90 degrees for comp1 and 270 degrees for comp2
comp1.labelRotation = 90;
comp2.labelRotation = 270;

console.log('--- TEST 3: STORAGE VALIDATION & RESTORATION (VERSION 2) ---');
cTornillo.quantity = 3; // user set 3 compressors
const payload = {
  app: "Taller CNC 2D Layout Planner",
  version: "2.0-29-MACHINES-QTY",
  timestamp: new Date().toISOString(),
  catalog: catalog,
  constructionLines: [
    { id: 'guide_1', x1: 0, y1: 10, x2: 23.5, y2: 10, color: '#f59e0b' }
  ],
  machines: [comp1, comp2]
};

const validated = validateLayoutData(payload);
if (validated.catalog.length !== 29) throw new Error(`Expected 29 catalog items, got ${validated.catalog.length}`);
const restoredComp = validated.catalog.find(c => c.id === cTornillo.id);
if (!restoredComp || restoredComp.quantity !== 3) throw new Error('Quantity 3 was not restored for compressor');
if (validated.machines.length !== 2) throw new Error(`Expected 2 placed instances, got ${validated.machines.length}`);
if (validated.machines[0].labelRotation !== 90) throw new Error('labelRotation 90 was not preserved in storage');
if (validated.machines[1].labelRotation !== 270) throw new Error('labelRotation 270 was not preserved in storage');
console.log('Storage validation with 29 machines, quantities, and labelRotation (90°/270°): PASSED');

// Test legacy typo normalization
const legacyPayload = {
  machines: [
    { id: 'inst_old_1', name: 'RECTIFICADORA DE VAVULAS #1', isPlaced: true },
    { id: 'inst_old_2', name: 'TORNO CONVENCIOANL', isPlaced: true },
    { id: 'inst_old_3', name: 'CENTRO GRANDE', isPlaced: true }
  ]
};
const legacyValidated = validateLayoutData(legacyPayload);
if (legacyValidated.machines[0].name !== 'RECTIFICADORA DE VÁLVULAS #1') {
  throw new Error(`Normalization failed: ${legacyValidated.machines[0].name}`);
}
if (legacyValidated.machines[1].name !== 'TORNO CONVENCIONAL') {
  throw new Error(`Normalization failed: ${legacyValidated.machines[1].name}`);
}
if (legacyValidated.machines[2].name !== 'CENTRO LEADWELL') {
  throw new Error(`Normalization failed: ${legacyValidated.machines[2].name}`);
}
console.log('Legacy misspelled names auto-normalization: PASSED');

console.log('--- TEST 4: DXF EXPORT WITH MULTIPLE COPIES & CLEARANCE LAYER ---');
const dxfOutput = generateDXF(validated.machines, validated.constructionLines);
if (!dxfOutput.includes('COMPRESOR')) throw new Error('DXF missing COMPRESOR');
if (!dxfOutput.includes('DE TORNILLO')) throw new Error('DXF missing DE TORNILLO');
if (!dxfOutput.includes('#1')) throw new Error('DXF missing instance suffix #1');
if (!dxfOutput.includes('#2')) throw new Error('DXF missing instance suffix #2');
if (!dxfOutput.includes('50\n90.00\n')) throw new Error('DXF missing rotated text entity with angle 90.00');
if (!dxfOutput.includes('50\n270.00\n')) throw new Error('DXF missing rotated text entity with angle 270.00');
if (!dxfOutput.includes('MAQUINAS_OFFSET')) throw new Error('DXF missing MAQUINAS_OFFSET layer');
if (!dxfOutput.includes('LINEAS_GUIA')) throw new Error('DXF missing LINEAS_GUIA layer');
console.log('DXF generation with multi-instance labels and clearance layers: PASSED');

console.log('--- TEST 5: INTER-MACHINE MAGNETIC SNAPPING ---');
const snapResult = evaluateInterMachineSnap({ ...comp2, x: 7.1 }, [comp1], 0.3);
if (!snapResult.snapped) throw new Error('Inter-machine snap failed near boundary');
console.log('Inter-machine snap docking: PASSED (' + snapResult.snapGuide.text + ')');

console.log('--- TEST 6: ZONES & PARENT-CHILD ARCHITECTURE ---');
const testZone = {
  id: 'zone_metro',
  catalogId: 'cat_zone_metro',
  name: 'ÁREA METROLOGÍA',
  width: 6.0,
  height: 4.0,
  x: 10.0,
  y: 15.0,
  rotation: 0,
  labelRotation: 90,
  operatorEdge: 0,
  offsetEdge: 2,
  wallOffset: 0.80,
  clearanceOffsets: [0.5, 0.5, 0.5, 0.5],
  isPlaced: true,
  isZone: true,
  parentId: null
};

const childMesa1 = {
  id: 'mesa_in_1',
  catalogId: 'cat_mesa',
  name: 'MESA CALIBRACIÓN #1',
  width: 1.5,
  height: 0.8,
  x: 9.0,
  y: 14.0,
  rotation: 0,
  offsetEdge: 0,
  wallOffset: 0.20,
  clearanceOffsets: [0.0, 0.0, 0.0, 0.0],
  isPlaced: true,
  isZone: false,
  parentId: 'zone_metro'
};

const childMesa2 = {
  id: 'mesa_in_2',
  catalogId: 'cat_mesa',
  name: 'MESA CALIBRACIÓN #2',
  width: 1.5,
  height: 0.8,
  x: 12.0,
  y: 14.0,
  rotation: 0,
  offsetEdge: 0,
  wallOffset: 0.20,
  clearanceOffsets: [0.0, 0.0, 0.0, 0.0],
  isPlaced: true,
  isZone: false,
  parentId: 'zone_metro'
};

// 1. Verificación de contención de hijos dentro de zona
if (!isMachineInsideZone(childMesa1, testZone)) throw new Error('childMesa1 must be inside testZone');
if (!isMachineInsideZone(childMesa2, testZone)) throw new Error('childMesa2 must be inside testZone');

// Mesa que se sale de la zona
const outMesa = { ...childMesa1, y: 17.5 };
if (isMachineInsideZone(outMesa, testZone)) throw new Error('outMesa should NOT be inside testZone');
console.log('Zone containment verification: PASSED');

// 2. Snap magnético a paredes interiores del cuarto
const zoneInnerWalls = getZoneInnerWallSegments(testZone);
if (zoneInnerWalls.length !== 4) throw new Error('Zone must produce exactly 4 inner wall segments');
const innerSnapRes = evaluateWallSnap(childMesa1, { customWalls: zoneInnerWalls });
if (!innerSnapRes.snapped) throw new Error('Child table failed to snap to zone interior wall');
if (Math.abs(innerSnapRes.snappedMachine.y - 13.6) > 0.01) {
  throw new Error(`Inner snap Y expected 13.6, got ${innerSnapRes.snappedMachine.y}`);
}
console.log('Interior wall snap with custom offset: PASSED (y=' + innerSnapRes.snappedMachine.y + 'm)');

// 3. Persistencia en Storage con validación de Zonas y ParentId
const zonePayload = {
  app: 'Taller CNC 2D Layout Planner',
  version: '2.1-ZONES-PARENT-CHILD',
  catalog: [
    { id: 'cat_zone_metro', name: 'ÁREA METROLOGÍA', width: 6.0, height: 4.0, isZone: true, isCustom: true },
    { id: 'cat_mesa', name: 'MESA CALIBRACIÓN', width: 1.5, height: 0.8, isZone: false, isCustom: true }
  ],
  machines: [testZone, childMesa1, childMesa2],
  constructionLines: []
};
const restoredZoneData = validateLayoutData(zonePayload);
const rZone = restoredZoneData.machines.find(m => m.id === 'zone_metro');
const rChild = restoredZoneData.machines.find(m => m.id === 'mesa_in_1');
if (!rZone || !rZone.isZone) throw new Error('Restored zone lost isZone flag');
if (!rChild || rChild.parentId !== 'zone_metro') throw new Error('Restored child lost parentId link');
console.log('Storage validation of Zones and Parent-Child links: PASSED');

// 4. Generación DXF de Zonas en capa dedicada
const zoneDXF = generateDXF(restoredZoneData.machines, []);
if (!zoneDXF.includes('ZONAS_RECINTOS')) throw new Error('DXF missing dedicated ZONAS_RECINTOS layer');
if (!zoneDXF.includes('ÁREA METROLOGÍA') && !zoneDXF.includes('AREA METROLOGIA')) {
  throw new Error('DXF missing Zone title text');
}
console.log('DXF export with ZONAS_RECINTOS layer: PASSED');

console.log('ALL 6 TEST SUITES PASSED SUCCESSFULLY! ✓');
