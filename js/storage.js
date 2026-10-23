/**
 * STORAGE.JS
 * Módulo de persistencia JSON y LocalStorage (Sección 8).
 * Permite exportar/importar 'taller_layout.json' y validar su compatibilidad.
 */

import { INITIAL_MACHINES_CATALOG } from './catalog.js';

const LOCAL_STORAGE_KEY = 'taller_cnc_2d_layout_state_v2';

const NAME_REPLACEMENTS = [
  [/RECTIFICADORA DE VAVULAS/gi, 'RECTIFICADORA DE VÁLVULAS'],
  [/PRUBAS HIDROSTATICAS/gi, 'PRUEBAS HIDROSTÁTICAS'],
  [/TORNO CONVENCIOANL/gi, 'TORNO CONVENCIONAL'],
  [/GABINIETE/gi, 'GABINETE'],
  [/RECTIFICADORA DE CIGUEÑALES/gi, 'RECTIFICADORA DE CIGÜEÑALES'],
  [/TUNEL DE BANCADA/gi, 'TÚNEL DE BANCADA'],
  [/BALANCEADOR DINAMICO/gi, 'BALANCEADOR DINÁMICO'],
  [/PIEDRAS DE CIGUEÑAL/gi, 'PIEDRAS DE CIGÜEÑAL'],
  [/CENTRO GRANDE/gi, 'CENTRO LEADWELL']
];

export function normalizeMachineName(name) {
  if (!name || typeof name !== 'string') return name;
  let fixed = name;
  for (const [regex, replacement] of NAME_REPLACEMENTS) {
    fixed = fixed.replace(regex, replacement);
  }
  return fixed;
}

/**
 * Serializa y exporta el estado a un archivo 'taller_layout.json'
 */
export function exportLayoutJSON(machines, constructionLines = [], viewTransform = null, catalog = [], filename = 'taller_layout.json') {
  let actualCatalog = catalog;
  let actualFilename = filename;
  if (typeof catalog === 'string') {
    actualFilename = catalog;
    actualCatalog = [];
  }

  const exportData = {
    app: "Taller CNC 2D Layout Planner",
    version: "2.1-ZONES-PARENT-CHILD",
    timestamp: new Date().toISOString(),
    totalAssets: machines.length,
    placedCount: machines.filter(m => m.isPlaced).length,
    viewTransform,
    catalog: (actualCatalog || []).map(c => ({
      id: c.id,
      name: c.name,
      width: Number(c.width.toFixed(2)),
      height: Number(c.height.toFixed(2)),
      quantity: Math.max(1, Number(c.quantity) || 1),
      category: c.category || "General",
      color: c.color || "#0284c7",
      wallOffset: Number((c.wallOffset ?? 0.80).toFixed(2)),
      clearanceOffsets: Array.isArray(c.clearanceOffsets) && c.clearanceOffsets.length === 4 
        ? c.clearanceOffsets.map(Number) 
        : [0.00, 0.00, 0.00, 0.00],
      isCustom: Boolean(c.isCustom),
      isUnique: Boolean(c.isUnique),
      isZone: Boolean(c.isZone)
    })),
    constructionLines: (constructionLines || []).map(l => ({
      id: l.id,
      x1: Number(l.x1.toFixed(3)),
      y1: Number(l.y1.toFixed(3)),
      x2: Number(l.x2.toFixed(3)),
      y2: Number(l.y2.toFixed(3)),
      color: l.color || '#f59e0b'
    })),
    machines: machines.map(m => ({
      id: m.id,
      catalogId: m.catalogId || m.templateId || m.id,
      name: m.name,
      width: Number(m.width.toFixed(2)),
      height: Number(m.height.toFixed(2)),
      x: Number(m.x.toFixed(3)),
      y: Number(m.y.toFixed(3)),
      rotation: Number(m.rotation.toFixed(1)),
      labelRotation: Number(m.labelRotation || 0),
      operatorEdge: m.operatorEdge ?? 0,
      offsetEdge: m.offsetEdge ?? 2,
      wallOffset: Number((m.wallOffset ?? 0.80).toFixed(2)),
      clearanceOffsets: Array.isArray(m.clearanceOffsets) && m.clearanceOffsets.length === 4 
        ? m.clearanceOffsets.map(Number) 
        : [0.00, 0.00, 0.00, 0.00],
      isPlaced: Boolean(m.isPlaced),
      category: m.category || "General",
      color: m.color || "#0284c7",
      isCustom: Boolean(m.isCustom),
      isZone: Boolean(m.isZone),
      parentId: m.parentId || null
    }))
  };

  const jsonStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = actualFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Valida un objeto parseado de JSON para verificar si es compatible con el taller
 */
export function validateLayoutData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('El archivo no contiene un objeto JSON válido.');
  }

  // 1. Reconciliar el catálogo oficial de 29 máquinas + ítems personalizados
  const savedCatalog = Array.isArray(data.catalog) ? data.catalog : (Array.isArray(data.customTemplates) ? data.customTemplates : []);
  const savedCatalogMap = new Map(savedCatalog.map(c => [c.id, c]));

  const restoredCatalog = INITIAL_MACHINES_CATALOG.map(base => {
    const saved = savedCatalogMap.get(base.id);
    return {
      ...base,
      quantity: saved && saved.quantity ? Math.max(1, Number(saved.quantity)) : (base.quantity || 1),
      wallOffset: saved && typeof saved.wallOffset === 'number' ? saved.wallOffset : base.wallOffset,
      clearanceOffsets: [0.00, 0.00, 0.00, 0.00]
    };
  });

  // Agregar cualquier ítem personalizado guardado que no esté en INITIAL_MACHINES_CATALOG
  for (const savedItem of savedCatalog) {
    if (!INITIAL_MACHINES_CATALOG.some(b => b.id === savedItem.id)) {
      restoredCatalog.push({
        id: savedItem.id,
        name: normalizeMachineName(savedItem.name) || 'Personalizado',
        width: Number(savedItem.width) || 1.0,
        height: Number(savedItem.height) || 1.0,
        quantity: Math.max(1, Number(savedItem.quantity) || 1),
        category: savedItem.category || 'Mobiliario',
        color: savedItem.color || '#0284c7',
        wallOffset: typeof savedItem.wallOffset === 'number' ? savedItem.wallOffset : (!isNaN(Number(savedItem?.wallOffset)) ? Number(savedItem.wallOffset) : 0.80),
        clearanceOffsets: Array.isArray(savedItem.clearanceOffsets) && savedItem.clearanceOffsets.length === 4
          ? savedItem.clearanceOffsets.map(Number)
          : [0.00, 0.00, 0.00, 0.00],
        isCustom: true,
        isUnique: Boolean(savedItem.isUnique),
        isZone: Boolean(savedItem.isZone)
      });
    }
  }

  const catalogLookup = new Map(restoredCatalog.map(c => [c.id, c]));

  // 2. Restaurar instancias de máquinas
  const rawMachines = Array.isArray(data.machines) ? data.machines : [];
  const restoredMachines = [];

  for (const raw of rawMachines) {
    if (!raw.id) continue;
    const catId = raw.catalogId || raw.templateId || raw.id;
    const base = catalogLookup.get(catId) || {
      id: catId,
      name: normalizeMachineName(raw.name) || "Máquina",
      width: Number(raw.width) || 1.0,
      height: Number(raw.height) || 1.0,
      category: "Personalizado",
      color: "#64748b",
      wallOffset: 0.80,
      clearanceOffsets: [0.00, 0.00, 0.00, 0.00],
      isZone: Boolean(raw.isZone)
    };

    restoredMachines.push({
      id: raw.id,
      catalogId: catId,
      name: normalizeMachineName(raw.name || base.name),
      width: Number(raw.width) || base.width,
      height: Number(raw.height) || base.height,
      category: raw.category || base.category,
      color: raw.color || base.color,
      isCustom: Boolean(raw.isCustom || !INITIAL_MACHINES_CATALOG.some(m => m.id === catId)),
      x: typeof raw.x === 'number' ? raw.x : 0,
      y: typeof raw.y === 'number' ? raw.y : 0,
      rotation: typeof raw.rotation === 'number' ? raw.rotation : 0,
      labelRotation: typeof raw.labelRotation === 'number' ? raw.labelRotation : 0,
      operatorEdge: typeof raw.operatorEdge === 'number' ? raw.operatorEdge : 0,
      offsetEdge: typeof raw.offsetEdge === 'number' ? raw.offsetEdge : 2,
      wallOffset: typeof raw.wallOffset === 'number' ? raw.wallOffset : (base.wallOffset !== undefined ? base.wallOffset : 0.80),
      clearanceOffsets: Array.isArray(raw.clearanceOffsets) && raw.clearanceOffsets.length === 4
        ? raw.clearanceOffsets.map(Number)
        : [...(base.clearanceOffsets || [0.00, 0.00, 0.00, 0.00])],
      isPlaced: Boolean(raw.isPlaced),
      isZone: Boolean(raw.isZone !== undefined ? raw.isZone : base.isZone),
      parentId: raw.parentId || null
    });
  }

  // 3. Restaurar líneas constructivas
  const rawLines = Array.isArray(data.constructionLines) ? data.constructionLines : [];
  const restoredLines = rawLines.map(l => ({
    id: l.id || `line_${Date.now()}_${Math.random()}`,
    x1: Number(l.x1) || 0,
    y1: Number(l.y1) || 0,
    x2: Number(l.x2) || 0,
    y2: Number(l.y2) || 0,
    color: l.color || '#f59e0b'
  }));

  return {
    catalog: restoredCatalog,
    machines: restoredMachines,
    constructionLines: restoredLines,
    viewTransform: data.viewTransform || null
  };
}

/**
 * Lee un archivo File subido por el usuario e importa el layout
 */
export function importLayoutFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No se seleccionó ningún archivo.'));
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        const result = validateLayoutData(parsed);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Error al leer el archivo.'));
    reader.readAsText(file);
  });
}

/**
 * Guardado automático en LocalStorage
 */
export function saveToLocalStorage(machines, constructionLines = [], viewTransform = null, catalog = []) {
  try {
    const data = {
      timestamp: Date.now(),
      catalog,
      machines,
      constructionLines,
      viewTransform
    };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('No se pudo guardar en LocalStorage:', e);
  }
}

/**
 * Carga automática desde LocalStorage
 */
export function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateLayoutData(parsed);
  } catch (e) {
    console.warn('Error al leer LocalStorage:', e);
    return null;
  }
}
