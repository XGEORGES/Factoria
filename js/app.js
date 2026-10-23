/**
 * APP.JS
 * Orquestador principal de la aplicación Taller CNC 2D Layout Planner.
 * Gestiona el estado reactivo, eventos del Canvas, Drag & Drop desde el Sidebar,
 * atajos de teclado [R, Q, E, Supr], panel de pendientes y exportación/importación.
 */

import { INITIAL_MACHINES_CATALOG, createFreshInventory, EDGE_NAMES } from './catalog.js';
import { CanvasEngine } from './canvas-engine.js';
import { evaluateWallSnap } from './wall-snap.js';
import { downloadDXF } from './dxf-exporter.js';
import { exportLayoutJSON, importLayoutFromFile, saveToLocalStorage, loadFromLocalStorage } from './storage.js';
import { getWorkshopBounds, findClosestWall, evaluateInterMachineSnap, isPointInsideMachine, isMachineInsideZone, getZoneInnerWallSegments, getWallSegments, pointToSegmentDistance } from './geometry.js';

class LayoutPlannerApp {
  constructor() {
    this.catalog = createFreshInventory();
    this.machines = [];
    this.selectedMachineId = null;
    this.searchQuery = '';

    // Herramientas y Guías Constructivas
    this.constructionLines = [];
    this.selectedGuidelineId = null;
    this.toolMode = 'select'; // 'select' | 'guideline'
    this.guidelineStart = null;

    // Modos de interacción con el puntero
    this.dragMode = 'none'; // 'pan' | 'drag-machine' | 'rotate-gizmo'
    this.dragStart = { x: 0, y: 0 };
    this.machineStartPos = { x: 0, y: 0, rotation: 0 };
    this.machineStartAngle = 0;
    this.childrenStartPos = [];
    this.isSpacePressed = false;
    this.isCtrlPressed = false;
    this.isShiftPressed = false;

    this.initElements();
    this.initCanvasEngine();
    this.initDragAndDrop();
    this.initPointerEvents();
    this.initKeyboardEvents();
    this.initUIControls();
    this.initInspectorControls();
    this.initCustomObjectModal();

    // Intentar restaurar sesión previa si existe
    const saved = loadFromLocalStorage();
    if (saved) {
      if (saved.catalog && saved.catalog.length > 0) this.catalog = saved.catalog;
      if (saved.machines) this.machines = saved.machines;
      if (saved.constructionLines) this.constructionLines = saved.constructionLines;
    }

    this.engine.setConstructionLines(this.constructionLines);
    this.updateAllUI();

    // Centrar automáticamente la vista en la nave del taller
    setTimeout(() => {
      this.engine.zoomExtents();
    }, 100);
  }

  initElements() {
    this.canvas = document.getElementById('cad-canvas');
    this.sidebarList = document.getElementById('sidebar-machine-list');
    this.placedCounter = document.getElementById('placed-counter');
    this.totalTargetCounter = document.getElementById('total-target-counter');
    this.unplacedCounter = document.getElementById('unplaced-counter');
    this.pendingDropdown = document.getElementById('pending-dropdown');
    this.pendingDropdownBtn = document.getElementById('btn-toggle-pending');
    this.pendingListContainer = document.getElementById('pending-machines-list');
    this.cursorCoords = document.getElementById('cursor-coords');
    this.inspectorPanel = document.getElementById('inspector-panel');

    // Elementos del Inspector
    this.inspName = document.getElementById('insp-name');
    this.inspDims = document.getElementById('insp-dims');
    this.inspX = document.getElementById('insp-x');
    this.inspY = document.getElementById('insp-y');
    this.inspRot = document.getElementById('insp-rotation');
    this.inspRotSlider = document.getElementById('insp-rotation-slider');
    this.inspWallOffset = document.getElementById('insp-wall-offset');
    this.inspOffsetBadge = document.getElementById('insp-offset-badge');
    this.inspOpEdgeBtns = document.querySelectorAll('.btn-op-edge');
    this.inspOffEdgeBtns = document.querySelectorAll('.btn-off-edge');
    this.inspLabelRotBtns = document.querySelectorAll('.btn-label-rot');
    this.btnInspSnap = document.getElementById('btn-insp-snap');
    this.btnInspDuplicate = document.getElementById('btn-insp-duplicate');
    this.btnInspRemove = document.getElementById('btn-insp-remove');
    this.btnInspClose = document.getElementById('btn-insp-close');
    this.inspZoneTag = document.getElementById('insp-zone-tag');
    this.btnDetachZone = document.getElementById('btn-detach-zone');

    // Elementos de Offset / Clearance entre Máquinas
    this.inspClearanceInputs = [0, 1, 2, 3].map(i => document.getElementById(`insp-clearance-${i}`));
    this.btnClearancePresets = document.querySelectorAll('.btn-clearance-preset[data-preset]');
    this.btnClearanceApplyAll = document.getElementById('btn-clearance-apply-all');
    this.btnToggleClearance = document.getElementById('btn-toggle-clearance');
  }

  initCanvasEngine() {
    this.engine = new CanvasEngine(this.canvas);
    this.engine.setMachines(this.machines);
  }

  // ==========================================================
  // DRAG & DROP DESDE SIDEBAR HACIA EL CANVASS (Sección 5.2)
  // ==========================================================
  initDragAndDrop() {
    // Canvas Drop Target
    this.canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    this.canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const rawData = e.dataTransfer.getData('text/plain');
      if (!rawData) return;

      const rect = this.canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const worldPt = this.engine.screenToWorld(screenX, screenY);

      let catId = rawData;
      if (catId.startsWith('catalog:')) catId = catId.replace('catalog:', '');
      if (catId.startsWith('template:')) catId = catId.replace('template:', '');

      this.placeCatalogInstance(catId, worldPt.x, worldPt.y);
    });
  }

  /**
   * Coloca una nueva instancia independiente a partir de un elemento del catálogo
   */
  placeCatalogInstance(catalogId, wx, wy) {
    const catItem = this.catalog.find(c => c.id === catalogId);
    if (!catItem) return;

    const placedCount = this.machines.filter(m => m.catalogId === catalogId && m.isPlaced).length;

    if (catItem.isUnique && placedCount >= 1) {
      this.showToast(`"${catItem.name}" es un activo único y ya se encuentra ubicado en el taller.`);
      return;
    }

    // Si ya se colocaron todas las unidades asignadas, incrementamos automáticamente la cantidad
    if (placedCount >= (catItem.quantity || 1)) {
      catItem.quantity = placedCount + 1;
    }

    const instanceNum = placedCount + 1;
    const name = (catItem.quantity > 1 || placedCount > 0)
      ? `${catItem.name} #${instanceNum}`
      : catItem.name;

    const isZone = Boolean(catItem.isZone);
    const newInst = {
      id: `inst_${catItem.id}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      catalogId: catItem.id,
      name,
      width: catItem.width,
      height: catItem.height,
      x: Number(wx.toFixed(2)),
      y: Number(wy.toFixed(2)),
      rotation: 0,
      labelRotation: 0,
      operatorEdge: catItem.operatorEdge ?? 0,
      offsetEdge: catItem.offsetEdge ?? 2,
      wallOffset: catItem.wallOffset ?? 0.80,
      clearanceOffsets: Array.isArray(catItem.clearanceOffsets) ? [...catItem.clearanceOffsets] : [0.00, 0.00, 0.00, 0.00],
      isPlaced: true,
      category: catItem.category || (isZone ? 'Zonas y Recintos' : 'Mecanizado'),
      color: catItem.color || (isZone ? '#6366f1' : '#0284c7'),
      isCustom: Boolean(catItem.isCustom),
      isZone: isZone,
      parentId: null
    };

    // Si es un objeto sólido, comprobar si cae dentro de una zona para asignación automática
    let parentZone = null;
    if (!isZone) {
      parentZone = this.machines.find(m => m.isZone && m.isPlaced && isPointInsideMachine(wx, wy, m));
      if (parentZone) {
        newInst.parentId = parentZone.id;
      }
    }

    // Evaluamos si cae cerca a un muro o máquina para snap
    const disableSnap = this.isCtrlPressed || this.isShiftPressed;
    let wallSnapRes = { snapped: false };

    if (parentZone) {
      // Snap magnético a las paredes interiores de la zona padre
      const innerWalls = getZoneInnerWallSegments(parentZone);
      wallSnapRes = evaluateWallSnap(newInst, { disableSnap, customWalls: innerWalls });
    } else {
      // Snap a los muros exteriores del taller
      wallSnapRes = evaluateWallSnap(newInst, { disableSnap });
    }

    const machineSnapRes = evaluateInterMachineSnap(newInst, this.machines, { disableSnap });

    if (wallSnapRes.snapped) {
      newInst.x = wallSnapRes.snappedMachine.x;
      newInst.y = wallSnapRes.snappedMachine.y;
      newInst.rotation = wallSnapRes.snappedMachine.rotation;
    } else if (machineSnapRes.snapped) {
      newInst.x = machineSnapRes.snappedMachine.x;
      newInst.y = machineSnapRes.snappedMachine.y;
    }

    this.machines.push(newInst);
    this.selectMachine(newInst.id);
    this.engine.updateCollisions();
    this.engine.requestRender();
    this.updateAllUI();
    this.saveState();
    if (parentZone) {
      this.showToast(`"${name}" colocado dentro de "${parentZone.name}".`);
    } else {
      this.showToast(`"${name}" colocada en (${newInst.x.toFixed(2)}, ${newInst.y.toFixed(2)}) m.`);
    }
  }

  /**
   * Duplica el objeto o máquina actualmente seleccionado [Ctrl+D]
   */
  duplicateSelectedMachine() {
    const selected = this.getSelectedMachine();
    if (!selected) {
      this.showToast('Selecciona primero un objeto en el plano para duplicarlo.');
      return;
    }

    const catId = selected.catalogId || selected.id;
    let catItem = this.catalog.find(c => c.id === catId);
    if (catItem?.isUnique) {
      this.showToast(`"${selected.name}" es un activo único y no puede duplicarse.`);
      return;
    }
    if (!catItem) {
      catItem = {
        id: catId,
        name: selected.name.replace(/ #\d+$/, ''),
        width: selected.width,
        height: selected.height,
        quantity: 1,
        category: selected.category || 'Mobiliario',
        color: selected.color || '#0284c7',
        wallOffset: selected.wallOffset || 0.80,
        clearanceOffsets: Array.isArray(selected.clearanceOffsets) ? [...selected.clearanceOffsets] : [0.00, 0.00, 0.00, 0.00],
        isCustom: true
      };
      this.catalog.push(catItem);
    }

    const existingInstances = this.machines.filter(m => (m.catalogId === catId || m.id === catId) && m.isPlaced);
    const placedCount = existingInstances.length;
    if (placedCount >= (catItem.quantity || 1)) {
      catItem.quantity = placedCount + 1;
    }

    const newName = `${catItem.name} #${placedCount + 1}`;
    const newId = `inst_${catId}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const duplicated = {
      ...selected,
      id: newId,
      catalogId: catId,
      name: newName,
      x: Number((selected.x + 1.0).toFixed(2)),
      y: Number((selected.y + 1.0).toFixed(2)),
      rotation: selected.rotation,
      operatorEdge: selected.operatorEdge,
      offsetEdge: selected.offsetEdge,
      wallOffset: selected.wallOffset,
      clearanceOffsets: Array.isArray(selected.clearanceOffsets) ? [...selected.clearanceOffsets] : [0.00, 0.00, 0.00, 0.00],
      isPlaced: true,
      isCustom: true,
      isZone: Boolean(selected.isZone),
      parentId: selected.parentId || null
    };

    // Evaluamos si el duplicado se pega a algún muro o máquina
    const disableSnap = this.isCtrlPressed || this.isShiftPressed;
    const wallSnapRes = evaluateWallSnap(duplicated, { disableSnap });
    const machineSnapRes = evaluateInterMachineSnap(duplicated, this.machines, { disableSnap });

    if (wallSnapRes.snapped) {
      duplicated.x = wallSnapRes.snappedMachine.x;
      duplicated.y = wallSnapRes.snappedMachine.y;
      duplicated.rotation = wallSnapRes.snappedMachine.rotation;
    } else if (machineSnapRes.snapped) {
      duplicated.x = machineSnapRes.snappedMachine.x;
      duplicated.y = machineSnapRes.snappedMachine.y;
    }

    this.machines.push(duplicated);
    this.selectMachine(duplicated.id);
    this.engine.updateCollisions();
    this.engine.requestRender();
    this.updateAllUI();
    this.saveState();
    this.showToast(`"${newName}" duplicado con éxito [Ctrl+D].`);
  }

  // ==========================================================
  // EVENTOS DEL PUNTERO EN EL CANVAS (Manipulación & Gizmo)
  // ==========================================================
  initPointerEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      this.dragStart = { x: sx, y: sy };

      // 1. Modo Línea Constructiva / Guía de Referencia
      if (this.toolMode === 'guideline' && e.button === 0) {
        const worldPt = this.engine.screenToWorld(sx, sy);
        if (!this.guidelineStart) {
          this.guidelineStart = { x: worldPt.x, y: worldPt.y };
          this.engine.setTempGuideline({ x1: worldPt.x, y1: worldPt.y, x2: worldPt.x, y2: worldPt.y });
          this.showToast('Punto inicial fijado. Haz clic en el punto final (mantén Shift para ortogonal).');
        } else {
          let endX = worldPt.x;
          let endY = worldPt.y;
          if (e.shiftKey) {
            const dx = Math.abs(endX - this.guidelineStart.x);
            const dy = Math.abs(endY - this.guidelineStart.y);
            if (dx > dy) endY = this.guidelineStart.y;
            else endX = this.guidelineStart.x;
          }
          const newLine = {
            id: `guide_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            x1: Number(this.guidelineStart.x.toFixed(3)),
            y1: Number(this.guidelineStart.y.toFixed(3)),
            x2: Number(endX.toFixed(3)),
            y2: Number(endY.toFixed(3)),
            color: '#f59e0b'
          };
          this.constructionLines.push(newLine);
          this.guidelineStart = null;
          this.engine.setTempGuideline(null);
          this.engine.setConstructionLines(this.constructionLines);
          this.saveState();
          const dist = Math.hypot(newLine.x2 - newLine.x1, newLine.y2 - newLine.y1);
          this.showToast(`Línea constructiva de ${dist.toFixed(2)} m creada.`);
        }
        return;
      }

      // 2. Pan con botón del medio o botón izquierdo + Barra Espaciadora
      if (e.button === 1 || (e.button === 0 && this.isSpacePressed)) {
        this.dragMode = 'pan';
        canvas.style.cursor = 'grabbing';
        return;
      }

      // 3. Clic Izquierdo (e.button === 0)
      if (e.button === 0) {
        // 3.1 Verificar si clicó en la manija del Gizmo de Rotación
        if (this.engine.hitTestGizmoHandle(sx, sy)) {
          this.dragMode = 'rotate-gizmo';
          const selected = this.getSelectedMachine();
          this.machineStartPos = { ...selected };
          this.machineStartAngle = selected ? (selected.rotation || 0) : 0;
          if (selected && selected.isZone) {
            this.childrenStartPos = this.machines
              .filter(m => m.parentId === selected.id && m.isPlaced)
              .map(child => ({ id: child.id, x: child.x, y: child.y, rotation: child.rotation || 0 }));
          } else {
            this.childrenStartPos = [];
          }
          return;
        }

        // 3.2 Si hay una máquina seleccionada, verificar si clicó sobre una de sus 4 aristas
        const selected = this.getSelectedMachine();
        if (selected) {
          const clickedEdge = this.engine.hitTestMachineEdge(sx, sy, selected);
          if (clickedEdge !== null) {
            if (e.shiftKey) {
              // Shift + Clic: Define Arista de Referencia de Offset (Sección 5.4)
              selected.offsetEdge = clickedEdge;
              this.showToast(`Arista de Offset asignada a: ${EDGE_NAMES[clickedEdge]}`);
            } else {
              // Clic normal: Define Línea del Operador Verde (Sección 5.4)
              selected.operatorEdge = clickedEdge;
              this.showToast(`Línea del Operador asignada a: ${EDGE_NAMES[clickedEdge]}`);
            }
            this.engine.requestRender();
            this.updateInspector();
            this.saveState();
            return;
          }
        }

        // 3.3 Verificar si clicó sobre cualquier máquina colocada
        const hitMachine = this.engine.hitTestMachine(sx, sy);
        if (hitMachine) {
          this.selectMachine(hitMachine.id);
          this.selectGuideline(null);
          this.dragMode = 'drag-machine';
          this.machineStartPos = {
            x: hitMachine.x,
            y: hitMachine.y,
            rotation: hitMachine.rotation
          };
          if (hitMachine.isZone) {
            this.childrenStartPos = this.machines
              .filter(m => m.parentId === hitMachine.id && m.isPlaced)
              .map(child => ({ id: child.id, x: child.x, y: child.y, rotation: child.rotation || 0 }));
          } else {
            this.childrenStartPos = [];
          }
          canvas.style.cursor = 'move';
          return;
        }

        // 3.4 Verificar si clicó sobre una línea constructiva
        const hitGuide = this.engine.hitTestConstructionLine(sx, sy);
        if (hitGuide) {
          this.selectGuideline(hitGuide.id);
          this.selectMachine(null);
          this.showToast('Línea constructiva seleccionada. Presiona [Supr] para borrarla.');
          return;
        } else {
          this.selectGuideline(null);
        }

        // 3.5 Clic en fondo vacío -> deseleccionar e iniciar Pan
        this.selectMachine(null);
        this.dragMode = 'pan';
        canvas.style.cursor = 'grabbing';
      }
    });

    // Menú contextual en el canvas (Clic Derecho en aristas = Offset Edge)
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const selected = this.getSelectedMachine();
      if (selected) {
        const clickedEdge = this.engine.hitTestMachineEdge(sx, sy, selected);
        if (clickedEdge !== null) {
          selected.offsetEdge = clickedEdge;
          this.showToast(`Arista de Offset asignada a: ${EDGE_NAMES[clickedEdge]}`);
          this.engine.requestRender();
          this.updateInspector();
          this.saveState();
        }
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Actualizar visualizador de coordenadas métricas en tiempo real
      const worldPt = this.engine.screenToWorld(sx, sy);
      if (this.cursorCoords) {
        this.cursorCoords.textContent = `X: ${worldPt.x.toFixed(2)} m | Y: ${worldPt.y.toFixed(2)} m`;
      }

      // Modo trazo de línea constructiva activo
      if (this.toolMode === 'guideline') {
        canvas.style.cursor = 'crosshair';
        if (this.guidelineStart) {
          let endX = worldPt.x;
          let endY = worldPt.y;
          if (e.shiftKey) {
            const dx = Math.abs(endX - this.guidelineStart.x);
            const dy = Math.abs(endY - this.guidelineStart.y);
            if (dx > dy) endY = this.guidelineStart.y;
            else endX = this.guidelineStart.x;
          }
          this.engine.setTempGuideline({
            x1: this.guidelineStart.x,
            y1: this.guidelineStart.y,
            x2: endX,
            y2: endY
          });
        }
        return;
      }

      // Si no estamos arrastrando, actualizar cursor interactivo
      if (this.dragMode === 'none') {
        if (this.engine.hitTestGizmoHandle(sx, sy)) {
          canvas.style.cursor = 'crosshair';
        } else if (this.selectedMachineId && this.engine.hitTestMachineEdge(sx, sy, this.getSelectedMachine()) !== null) {
          canvas.style.cursor = 'pointer';
        } else if (this.engine.hitTestMachine(sx, sy)) {
          canvas.style.cursor = 'move';
        } else if (this.engine.hitTestConstructionLine(sx, sy)) {
          canvas.style.cursor = 'pointer';
        } else if (this.isSpacePressed) {
          canvas.style.cursor = 'grab';
        } else {
          canvas.style.cursor = 'default';
        }
        return;
      }

      const dxPx = sx - this.dragStart.x;
      const dyPx = sy - this.dragStart.y;

      // 1. Pan del lienzo
      if (this.dragMode === 'pan') {
        this.engine.panBy(dxPx, dyPx);
        this.dragStart = { x: sx, y: sy };
        return;
      }

      const selected = this.getSelectedMachine();
      if (!selected) return;

      // 2. Giro continuo con Gizmo de Rotación (Sección 5.3)
      if (this.dragMode === 'rotate-gizmo') {
        const centerScreen = this.engine.worldToScreen(selected.x, selected.y);
        const mouseAngleRad = Math.atan2(centerScreen.y - sy, sx - centerScreen.x);
        let angleDeg = (mouseAngleRad * 180 / Math.PI + 360) % 360;

        // Ajustamos respecto a la posición superior (+Y local)
        let finalAngle = (angleDeg - 90 + 360) % 360;
        selected.rotation = Number(finalAngle.toFixed(1));

        // Si es una zona, rotar en bloque a todos sus hijos alrededor del centroide
        if (selected.isZone && this.childrenStartPos && this.childrenStartPos.length > 0) {
          const deltaAngle = (selected.rotation - this.machineStartAngle + 360) % 360;
          const deltaRad = (deltaAngle * Math.PI) / 180;
          const cos = Math.cos(deltaRad);
          const sin = Math.sin(deltaRad);

          for (const c of this.childrenStartPos) {
            const child = this.machines.find(m => m.id === c.id);
            if (!child) continue;
            const relX = c.x - selected.x;
            const relY = c.y - selected.y;
            child.x = Number((selected.x + (relX * cos - relY * sin)).toFixed(2));
            child.y = Number((selected.y + (relX * sin + relY * cos)).toFixed(2));
            child.rotation = Number(((c.rotation + deltaAngle) % 360 + 360) % 360).toFixed(1);
          }
        }

        this.engine.updateCollisions();
        this.engine.requestRender();
        this.updateInspector();
        return;
      }

      // 3. Arrastre de Máquina o Zona (Sección 5.3 y 6.2)
      if (this.dragMode === 'drag-machine') {
        const dxMeters = dxPx / this.engine.scale;
        const dyMeters = -dyPx / this.engine.scale; // Y invertido en pantalla

        let targetX = this.machineStartPos.x + dxMeters;
        let targetY = this.machineStartPos.y + dyMeters;

        // Clon temporal para evaluar snap a muro
        const tempMachine = {
          ...selected,
          x: targetX,
          y: targetY
        };

        const disableSnap = this.isCtrlPressed || this.isShiftPressed;

        if (selected.isZone) {
          // Snap de la zona contra los muros perimetrales del taller y entre máquinas externas
          const wallSnapRes = evaluateWallSnap(tempMachine, { disableSnap });
          const machineSnapRes = evaluateInterMachineSnap(tempMachine, this.machines, { disableSnap });

          if (wallSnapRes.snapped) {
            selected.x = wallSnapRes.snappedMachine.x;
            selected.y = wallSnapRes.snappedMachine.y;
            selected.rotation = wallSnapRes.snappedMachine.rotation;
            this.engine.setSnapGuide(wallSnapRes.snapGuide);
          } else if (machineSnapRes.snapped) {
            selected.x = machineSnapRes.snappedMachine.x;
            selected.y = machineSnapRes.snappedMachine.y;
            this.engine.setSnapGuide(machineSnapRes.snapGuide);
          } else {
            selected.x = Number(targetX.toFixed(2));
            selected.y = Number(targetY.toFixed(2));
            this.engine.setSnapGuide(null);
          }

          // Desplazar en bloque a todos sus hijos en sincronía exacta (Parent-Child)
          const deltaX = selected.x - this.machineStartPos.x;
          const deltaY = selected.y - this.machineStartPos.y;
          if (this.childrenStartPos && this.childrenStartPos.length > 0) {
            for (const c of this.childrenStartPos) {
              const child = this.machines.find(m => m.id === c.id);
              if (child) {
                child.x = Number((c.x + deltaX).toFixed(2));
                child.y = Number((c.y + deltaY).toFixed(2));
              }
            }
          }
        } else {
          // Es un objeto normal o hijo:
          // Evaluar si pertenece a una zona o está sobre una zona
          let parentZone = null;
          if (selected.parentId) {
            parentZone = this.machines.find(m => m.id === selected.parentId && m.isPlaced);
          }
          if (!parentZone) {
            parentZone = this.machines.find(m => m.isZone && m.isPlaced && isPointInsideMachine(targetX, targetY, m));
          }

          let wallSnapRes = { snapped: false };
          if (parentZone) {
            // Snap magnético contra las paredes interiores de la zona padre
            const innerWalls = getZoneInnerWallSegments(parentZone);
            wallSnapRes = evaluateWallSnap(tempMachine, { disableSnap, customWalls: innerWalls });
          } else {
            // Snap a los muros exteriores del taller
            wallSnapRes = evaluateWallSnap(tempMachine, { disableSnap });
          }

          const machineSnapRes = evaluateInterMachineSnap(tempMachine, this.machines, { disableSnap });

          if (wallSnapRes.snapped) {
            selected.x = wallSnapRes.snappedMachine.x;
            selected.y = wallSnapRes.snappedMachine.y;
            selected.rotation = wallSnapRes.snappedMachine.rotation;
            this.engine.setSnapGuide(wallSnapRes.snapGuide);
          } else if (machineSnapRes.snapped) {
            selected.x = machineSnapRes.snappedMachine.x;
            selected.y = machineSnapRes.snappedMachine.y;
            this.engine.setSnapGuide(machineSnapRes.snapGuide);
          } else {
            selected.x = Number(targetX.toFixed(2));
            selected.y = Number(targetY.toFixed(2));
            this.engine.setSnapGuide(null);
          }
        }

        this.engine.updateCollisions();
        this.engine.requestRender();
        this.updateInspector();
      }
    });

    const endPointerDrag = () => {
      if (this.dragMode !== 'none') {
        const selected = this.getSelectedMachine();
        if (selected && !selected.isZone) {
          // Evaluar si al soltar quedó dentro o fuera de una zona
          const targetZone = this.machines.find(m => m.isZone && m.isPlaced && isPointInsideMachine(selected.x, selected.y, m));
          if (targetZone) {
            if (selected.parentId !== targetZone.id) {
              selected.parentId = targetZone.id;
              this.showToast(`"${selected.name}" asignado a "${targetZone.name}".`);
            }
          } else if (selected.parentId) {
            selected.parentId = null;
            this.showToast(`"${selected.name}" liberado al taller principal.`);
          }
        }

        this.dragMode = 'none';
        this.childrenStartPos = [];
        this.engine.setSnapGuide(null);
        canvas.style.cursor = 'default';
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.updateInspector();
        this.saveState();
      }
    };

    canvas.addEventListener('pointerup', endPointerDrag);
    canvas.addEventListener('pointercancel', endPointerDrag);

    // Zoom centrado en cursor del mouse
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      this.engine.zoomAtPoint(sx, sy, factor);
    }, { passive: false });
  }

  // ==========================================================
  // ATAJOS DE TECLADO (Sección 5.2 y 5.3)
  // [R]   -> Rotación 90°
  // [Q/E] -> Micro-rotación ±5°
  // [Supr]-> Elimina máquina del canvas y la regresa al sidebar
  // ==========================================================
  initKeyboardEvents() {
    window.addEventListener('keydown', (e) => {
      this.isCtrlPressed = e.ctrlKey;
      this.isShiftPressed = e.shiftKey;

      if (e.code === 'Space' && !this.isSpacePressed && e.target.tagName !== 'INPUT') {
        this.isSpacePressed = true;
        this.canvas.style.cursor = 'grab';
      }

      // Si el foco está en un input numérico, permitimos tipeo
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
        return;
      }

      // 1. Borrar línea constructiva si está seleccionada
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedGuidelineId) {
        e.preventDefault();
        this.constructionLines = this.constructionLines.filter(l => l.id !== this.selectedGuidelineId);
        this.selectedGuidelineId = null;
        this.engine.setSelectedGuidelineId(null);
        this.engine.setConstructionLines(this.constructionLines);
        this.saveState();
        this.showToast('Línea constructiva eliminada.');
        return;
      }

      const selected = this.getSelectedMachine();

      // Duplicar activo seleccionado [Ctrl+D]
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        this.duplicateSelectedMachine();
        return;
      }

      // 2. Tecla [Supr] o [Delete]: Elimina máquina y regresa al panel
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        this.removeMachineFromCanvas(selected.id);
        return;
      }

      if (!selected) {
        if (e.key === 'Escape') {
          if (this.toolMode === 'guideline') {
            this.guidelineStart = null;
            this.engine.setTempGuideline(null);
            this.setToolMode('select');
            this.showToast('Modo línea guía cancelado.');
          }
          this.selectGuideline(null);
        }
        return;
      }

      // Tecla [R]: Rotación incremental rápida a 90° de la máquina
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        this.setMachineRotation(selected, selected.rotation + 90);
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.updateInspector();
        this.saveState();
        return;
      }

      // Tecla [T]: Rotar orientación del nombre 90° (lado largo vs lado corto)
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          this.rotateSelectedMachineLabel(90);
          return;
        }
      }

      // Teclas [Q] / [E]: Micro-rotación de ajuste a ±5°
      if (e.key === 'q' || e.key === 'Q') {
        e.preventDefault();
        this.setMachineRotation(selected, selected.rotation - 5);
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.updateInspector();
        this.saveState();
        return;
      }

      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        this.setMachineRotation(selected, selected.rotation + 5);
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.updateInspector();
        this.saveState();
        return;
      }

      // Escape: Deseleccionar
      if (e.key === 'Escape') {
        this.selectMachine(null);
        this.selectGuideline(null);
      }
    });

    window.addEventListener('keyup', (e) => {
      this.isCtrlPressed = e.ctrlKey;
      this.isShiftPressed = e.shiftKey;

      if (e.code === 'Space') {
        this.isSpacePressed = false;
        if (this.dragMode === 'none') {
          this.canvas.style.cursor = 'default';
        }
      }
    });
  }

  // ==========================================================
  // CONTROLES DE LA INTERFAZ (Header, Sidebar e Inspector)
  // ==========================================================
  initUIControls() {
    // 0. Buscador en Catálogo
    const searchInput = document.getElementById('catalog-search');
    searchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase().trim();
      this.renderSidebarList();
    });

    // 1. Botón "Exportar DXF" (Sección 5.1 y 7)
    document.getElementById('btn-export-dxf')?.addEventListener('click', () => {
      const placed = this.machines.filter(m => m.isPlaced);
      if (placed.length === 0 && this.constructionLines.length === 0) {
        alert('No hay máquinas colocadas ni líneas constructivas en el taller para exportar.');
        return;
      }
      downloadDXF(this.machines, this.constructionLines, `Taller_CNC_Layout_${new Date().toISOString().slice(0, 10)}.dxf`);
      this.showToast('Archivo DXF exportado para AutoCAD.');
    });

    // 2. Botón "Guardar Sesión (.json)" (Sección 5.1 y 8)
    document.getElementById('btn-save-json')?.addEventListener('click', () => {
      const view = {
        scale: this.engine.scale,
        panX: this.engine.panX,
        panY: this.engine.panY
      };
      exportLayoutJSON(this.machines, this.constructionLines, view, this.catalog);
      this.showToast('Sesión guardada en taller_layout.json.');
    });

    // 3. Botón "Cargar Sesión (.json)" (Sección 5.1 y 8)
    const fileInput = document.getElementById('file-input-json');
    document.getElementById('btn-load-json')?.addEventListener('click', () => {
      fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const data = await importLayoutFromFile(file);
        if (data.catalog && data.catalog.length > 0) this.catalog = data.catalog;
        this.machines = data.machines;
        this.constructionLines = data.constructionLines || [];
        this.engine.setConstructionLines(this.constructionLines);
        if (data.viewTransform) {
          this.engine.scale = data.viewTransform.scale;
          this.engine.panX = data.viewTransform.panX;
          this.engine.panY = data.viewTransform.panY;
        }
        this.selectMachine(null);
        this.selectGuideline(null);
        this.updateAllUI();
        this.saveState();
        this.showToast('¡Sesión restaurada exitosamente!');
      } catch (err) {
        alert(`Error al cargar el archivo JSON: ${err.message}`);
      } finally {
        fileInput.value = '';
      }
    });

    // 4. Botón desplegable "Ver pendientes" (Sección 5.1)
    this.pendingDropdownBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = this.pendingDropdown.classList.contains('active');
      if (isOpen) {
        this.pendingDropdown.classList.remove('active');
      } else {
        this.renderPendingList();
        this.pendingDropdown.classList.add('active');
      }
    });

    document.addEventListener('click', (e) => {
      if (this.pendingDropdown && !this.pendingDropdown.contains(e.target)) {
        this.pendingDropdown.classList.remove('active');
      }
    });

    // 5. Botones de vista del lienzo y herramientas
    document.getElementById('btn-zoom-extents')?.addEventListener('click', () => {
      this.engine.zoomExtents();
    });

    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      this.engine.zoomAtPoint(this.canvas.width / (2 * (window.devicePixelRatio || 1)), this.canvas.height / (2 * (window.devicePixelRatio || 1)), 1.25);
    });

    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      this.engine.zoomAtPoint(this.canvas.width / (2 * (window.devicePixelRatio || 1)), this.canvas.height / (2 * (window.devicePixelRatio || 1)), 0.8);
    });

    document.getElementById('btn-toggle-grid')?.addEventListener('click', (e) => {
      this.engine.showGrid = !this.engine.showGrid;
      e.currentTarget.classList.toggle('active', this.engine.showGrid);
      this.engine.requestRender();
    });

    document.getElementById('btn-toggle-clearance')?.addEventListener('click', (e) => {
      this.engine.showClearanceZones = !this.engine.showClearanceZones;
      e.currentTarget.classList.toggle('active', this.engine.showClearanceZones);
      this.engine.requestRender();
      this.showToast(this.engine.showClearanceZones ? 'Zonas de separación/offset visibles.' : 'Zonas de separación/offset ocultas.');
    });

    // Herramienta Línea Constructiva (Referencia)
    document.getElementById('btn-tool-guideline')?.addEventListener('click', () => {
      if (this.toolMode === 'guideline') {
        this.setToolMode('select');
      } else {
        this.setToolMode('guideline');
      }
    });

    // Borrar todas las líneas constructivas
    document.getElementById('btn-clear-guidelines')?.addEventListener('click', () => {
      if (this.constructionLines.length === 0) {
        this.showToast('No hay líneas constructivas para borrar.');
        return;
      }
      if (confirm('¿Deseas eliminar todas las líneas constructivas de referencia?')) {
        this.constructionLines = [];
        this.selectedGuidelineId = null;
        this.engine.setSelectedGuidelineId(null);
        this.engine.setConstructionLines([]);
        this.saveState();
        this.showToast('Todas las líneas constructivas han sido eliminadas.');
      }
    });

    document.getElementById('btn-reset-layout')?.addEventListener('click', () => {
      if (this.machines.length === 0) {
        this.showToast('El taller ya está vacío.');
        return;
      }
      if (confirm('¿Deseas retirar todas las máquinas y vaciar el taller?')) {
        this.machines = [];
        this.catalog.forEach(c => {
          if (!c.isCustom) {
            c.quantity = 1;
          }
        });
        this.selectMachine(null);
        this.updateAllUI();
        this.saveState();
        this.showToast('Taller vaciado por completo.');
      }
    });

    // 6. Controles del Inspector de Máquina
    this.initInspectorControls();
  }

  initInspectorControls() {
    this.btnInspClose?.addEventListener('click', () => {
      this.selectMachine(null);
    });

    this.inspX?.addEventListener('change', (e) => {
      const selected = this.getSelectedMachine();
      if (selected) {
        const newX = Number(parseFloat(e.target.value) || 0);
        const deltaX = newX - selected.x;
        selected.x = newX;
        if (selected.isZone && Math.abs(deltaX) > 0.001) {
          const children = this.machines.filter(m => m.parentId === selected.id && m.isPlaced);
          children.forEach(c => {
            c.x = Number((c.x + deltaX).toFixed(2));
          });
        }
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.saveState();
      }
    });

    this.inspY?.addEventListener('change', (e) => {
      const selected = this.getSelectedMachine();
      if (selected) {
        const newY = Number(parseFloat(e.target.value) || 0);
        const deltaY = newY - selected.y;
        selected.y = newY;
        if (selected.isZone && Math.abs(deltaY) > 0.001) {
          const children = this.machines.filter(m => m.parentId === selected.id && m.isPlaced);
          children.forEach(c => {
            c.y = Number((c.y + deltaY).toFixed(2));
          });
        }
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.saveState();
      }
    });

    this.inspRot?.addEventListener('input', (e) => {
      const selected = this.getSelectedMachine();
      if (selected) {
        const val = parseFloat(e.target.value) || 0;
        this.setMachineRotation(selected, val);
        if (this.inspRotSlider) this.inspRotSlider.value = selected.rotation;
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.saveState();
      }
    });

    this.inspRotSlider?.addEventListener('input', (e) => {
      const selected = this.getSelectedMachine();
      if (selected) {
        const val = parseFloat(e.target.value) || 0;
        this.setMachineRotation(selected, val);
        if (this.inspRot) this.inspRot.value = selected.rotation;
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.saveState();
      }
    });

    // Botones de rotación rápida en el inspector
    document.querySelectorAll('[data-rot-inc]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const selected = this.getSelectedMachine();
        if (selected) {
          const inc = parseFloat(btn.dataset.rotInc) || 0;
          this.setMachineRotation(selected, selected.rotation + inc);
          this.engine.updateCollisions();
          this.engine.requestRender();
          this.updateInspector();
          this.saveState();
        }
      });
    });

    // Control de Orientación del Nombre de la máquina (0°, 90°, 180°, 270°)
    this.inspLabelRotBtns = document.querySelectorAll('.btn-label-rot');
    this.inspLabelRotBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const rot = parseInt(btn.dataset.rot, 10);
        this.setMachineLabelRotation(rot);
      });
    });

    document.getElementById('btn-toggle-label-rot')?.addEventListener('click', () => {
      this.rotateSelectedMachineLabel(90);
    });

    // Selector de Arista del Operador (0..3)
    this.inspOpEdgeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const selected = this.getSelectedMachine();
        if (selected) {
          selected.operatorEdge = parseInt(btn.dataset.edge, 10);
          this.engine.requestRender();
          this.updateInspector();
          this.saveState();
        }
      });
    });

    // Selector de Arista de Offset (0..3)
    this.inspOffEdgeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const selected = this.getSelectedMachine();
        if (selected) {
          selected.offsetEdge = parseInt(btn.dataset.edge, 10);
          this.engine.requestRender();
          this.updateInspector();
          this.saveState();
        }
      });
    });

    // Input de distancia al muro (wallOffset)
    this.inspWallOffset?.addEventListener('input', (e) => {
      const selected = this.getSelectedMachine();
      if (selected) {
        selected.wallOffset = Math.max(0.10, Math.min(10.0, parseFloat(e.target.value) || 0.80));
        this.saveState();
      }
    });

    // Inputs de Clearance / Offset de las 4 caras (0: Frontal, 1: Derecho, 2: Trasero, 3: Izquierdo)
    this.inspClearanceInputs?.forEach((input, idx) => {
      input?.addEventListener('input', (e) => {
        const selected = this.getSelectedMachine();
        if (selected) {
          if (!Array.isArray(selected.clearanceOffsets)) {
            selected.clearanceOffsets = [0.00, 0.00, 0.00, 0.00];
          }
          const val = Math.max(0.0, Math.min(10.0, parseFloat(e.target.value) || 0.0));
          selected.clearanceOffsets[idx] = Number(val.toFixed(2));
          this.engine.updateCollisions();
          this.engine.requestRender();
          this.saveState();
        }
      });
    });

    // Presets rápidos de clearance (0m, 0.5m, 0.8m, 1.0m)
    this.btnClearancePresets?.forEach(btn => {
      btn.addEventListener('click', () => {
        const selected = this.getSelectedMachine();
        if (selected) {
          const presetVal = parseFloat(btn.dataset.preset) || 0.0;
          selected.clearanceOffsets = [presetVal, presetVal, presetVal, presetVal];
          this.inspClearanceInputs.forEach(inp => {
            if (inp) inp.value = presetVal.toFixed(2);
          });
          this.engine.updateCollisions();
          this.engine.requestRender();
          this.saveState();
          this.showToast(`Offset de ${presetVal.toFixed(2)} m aplicado a las 4 caras.`);
        }
      });
    });

    // Botón Copiar Frontal a las 4 caras
    this.btnClearanceApplyAll?.addEventListener('click', () => {
      const selected = this.getSelectedMachine();
      if (selected) {
        const frontVal = selected.clearanceOffsets?.[0] ?? 0.00;
        selected.clearanceOffsets = [frontVal, frontVal, frontVal, frontVal];
        this.inspClearanceInputs.forEach(inp => {
          if (inp) inp.value = frontVal.toFixed(2);
        });
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.saveState();
        this.showToast(`Offset de ${frontVal.toFixed(2)} m copiado a las 4 caras.`);
      }
    });

    // Botón Alinear al Muro Más Cercano (Snap forzado)
    this.btnInspSnap?.addEventListener('click', () => {
      const selected = this.getSelectedMachine();
      if (selected) {
        let parentZone = null;
        if (selected.parentId) {
          parentZone = this.machines.find(m => m.id === selected.parentId && m.isPlaced);
        }
        const customWalls = parentZone ? getZoneInnerWallSegments(parentZone) : null;
        const snapRes = evaluateWallSnap(selected, { disableSnap: false, customWalls });

        if (snapRes.snapped) {
          selected.x = snapRes.snappedMachine.x;
          selected.y = snapRes.snappedMachine.y;
          selected.rotation = snapRes.snappedMachine.rotation;
          this.engine.updateCollisions();
          this.engine.requestRender();
          this.updateInspector();
          this.saveState();
          this.showToast(parentZone ? 'Mueble alineado a la pared interior del cuarto.' : 'Máquina alineada al muro con offset métrico.');
        } else {
          // Si estaba a más de 0.60m, encontramos el muro más próximo de todos modos
          const walls = customWalls || getWallSegments();
          let closest = null;
          let minDistance = Infinity;

          for (const wall of walls) {
            const res = pointToSegmentDistance(selected.x, selected.y, wall.start, wall.end);
            if (res.distance < minDistance) {
              minDistance = res.distance;
              closest = { wall, distance: res.distance, closestPoint: res.closestPoint };
            }
          }

          if (closest) {
            // Forzar snap acercándola
            selected.x = Number((closest.closestPoint.x + closest.wall.normal.x * 0.40).toFixed(2));
            selected.y = Number((closest.closestPoint.y + closest.wall.normal.y * 0.40).toFixed(2));
            const res = evaluateWallSnap(selected, { disableSnap: false, customWalls });
            if (res.snapped) {
              selected.x = res.snappedMachine.x;
              selected.y = res.snappedMachine.y;
              selected.rotation = res.snappedMachine.rotation;
            }
            this.engine.updateCollisions();
            this.engine.requestRender();
            this.updateInspector();
            this.saveState();
            this.showToast(parentZone ? 'Mueble alineado a la pared interior más cercana.' : 'Máquina alineada al muro más cercano.');
          }
        }
      }
    });

    // Botón Duplicar Activo [Ctrl+D]
    this.btnInspDuplicate?.addEventListener('click', () => {
      this.duplicateSelectedMachine();
    });

    // Botón Desvincular de Zona
    this.btnDetachZone?.addEventListener('click', () => {
      const selected = this.getSelectedMachine();
      if (selected && selected.parentId) {
        selected.parentId = null;
        this.engine.updateCollisions();
        this.engine.requestRender();
        this.updateInspector();
        this.saveState();
        this.showToast(`"${selected.name}" desvinculado de su zona.`);
      }
    });

    // Botón Retirar del taller (Regresar al sidebar)
    this.btnInspRemove?.addEventListener('click', () => {
      const selected = this.getSelectedMachine();
      if (selected) {
        this.removeMachineFromCanvas(selected.id);
      }
    });
  }

  /**
   * Establece la rotación de una entidad (máquina o zona).
   * Si es una zona, rota a todos sus hijos en bloque alrededor del centroide.
   */
  setMachineRotation(machine, newRotation) {
    if (!machine) return;
    const oldRotation = machine.rotation || 0;
    const targetRotation = ((newRotation % 360) + 360) % 360;
    const deltaAngle = (targetRotation - oldRotation + 360) % 360;
    const signedDelta = deltaAngle > 180 ? deltaAngle - 360 : deltaAngle;
    machine.rotation = Number(targetRotation.toFixed(1));

    if (machine.isZone && Math.abs(signedDelta) > 0.001) {
      const deltaRad = (signedDelta * Math.PI) / 180;
      const cos = Math.cos(deltaRad);
      const sin = Math.sin(deltaRad);
      const children = this.machines.filter(m => m.parentId === machine.id && m.isPlaced);

      for (const child of children) {
        const relX = child.x - machine.x;
        const relY = child.y - machine.y;
        child.x = Number((machine.x + (relX * cos - relY * sin)).toFixed(2));
        child.y = Number((machine.y + (relX * sin + relY * cos)).toFixed(2));
        child.rotation = Number((((child.rotation || 0) + signedDelta) % 360 + 360) % 360).toFixed(1);
      }
    }
  }

  setMachineLabelRotation(deg) {
    const selected = this.getSelectedMachine();
    if (!selected) return;

    selected.labelRotation = ((deg % 360) + 360) % 360;
    this.engine.requestRender();
    this.updateInspector();
    this.saveState();

    const descriptions = {
      0: '0° Frontal (Lado Ancho)',
      90: '90° Derecho (Lado Largo)',
      180: '180° Trasero (Lado Ancho invertido)',
      270: '270° Izquierdo (Lado Largo invertido)'
    };
    this.showToast(`Nombre orientado a ${descriptions[selected.labelRotation] || selected.labelRotation + '°'}.`);
  }

  rotateSelectedMachineLabel(inc = 90) {
    const selected = this.getSelectedMachine();
    if (!selected) return;

    const current = selected.labelRotation || 0;
    const nextRot = ((Math.round(current / 90) * 90) + inc + 360) % 360;
    this.setMachineLabelRotation(nextRot);
  }

  // ==========================================================
  // GESTIÓN DE SELECCIÓN Y RETIRO
  // ==========================================================
  selectMachine(id) {
    this.selectedMachineId = id;
    this.engine.setSelectedMachineId(id);
    this.updateInspector();
  }

  getSelectedMachine() {
    if (!this.selectedMachineId) return null;
    return this.machines.find(m => m.id === this.selectedMachineId) || null;
  }

  removeMachineFromCanvas(id) {
    const machine = this.machines.find(m => m.id === id);
    if (!machine) return;

    // Si la entidad es una zona contenedora, liberar a todos sus hijos al taller principal
    if (machine.isZone) {
      const children = this.machines.filter(m => m.parentId === machine.id);
      children.forEach(c => { c.parentId = null; });
    }

    this.machines = this.machines.filter(m => m.id !== id);
    this.showToast(`"${machine.name}" retirada del taller.`);

    if (this.selectedMachineId === id) {
      this.selectMachine(null);
    }
    this.updateAllUI();
    this.saveState();
  }

  // ==========================================================
  // ACTUALIZACIÓN DE INTERFAZ Y SIDEBAR
  // ==========================================================
  updateAllUI() {
    this.updateCounters();
    this.renderSidebarList();
    this.updateInspector();
    this.engine.setMachines(this.machines);
  }

  updateCounters() {
    const placed = this.machines.filter(m => m.isPlaced).length;
    const totalTarget = this.catalog.reduce((sum, c) => sum + (c.quantity || 1), 0);
    const pending = Math.max(0, totalTarget - placed);

    if (this.placedCounter) this.placedCounter.textContent = placed;
    if (this.totalTargetCounter) this.totalTargetCounter.textContent = totalTarget;
    if (this.unplacedCounter) this.unplacedCounter.textContent = pending;

    const catBadge = document.getElementById('sidebar-placed-badge') || document.querySelector('#sidebar-catalog .sidebar-title span.badge');
    if (catBadge) catBadge.textContent = `${placed} en planta`;

    const brandSub = document.getElementById('brand-subtitle') || document.querySelector('.brand-title span');
    if (brandSub) brandSub.textContent = `1,103.74 m² | Nave Industrial | ${placed} / ${totalTarget} Activos`;
  }

  renderSidebarList() {
    if (!this.sidebarList) return;
    this.sidebarList.innerHTML = '';

    const query = this.searchQuery ? this.searchQuery.toLowerCase() : '';
    const filteredCatalog = this.catalog.filter(c => {
      if (!query) return true;
      return c.name.toLowerCase().includes(query) || (c.category && c.category.toLowerCase().includes(query));
    });

    if (filteredCatalog.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-catalog-msg';
      emptyMsg.innerHTML = `
        <span class="icon">🔍</span>
        <p>No se encontraron máquinas con "${query}".</p>
      `;
      this.sidebarList.appendChild(emptyMsg);
      return;
    }

    for (const item of filteredCatalog) {
      const placedInstances = this.machines.filter(m => (m.catalogId === item.id || m.id === item.id) && m.isPlaced);
      const placedCount = placedInstances.length;
      const targetQty = Math.max(1, item.quantity || 1);
      const isDone = placedCount >= targetQty;

      const isZone = Boolean(item.isZone);
      const card = document.createElement('div');
      card.className = `machine-card ${isDone ? 'card-complete' : ''} ${isZone ? 'card-zone' : ''}`;
      card.draggable = true;
      card.dataset.catalogId = item.id;

      const badgeColor = item.color || (isZone ? '#6366f1' : 'var(--accent-cyan)');
      const badgeBg = isZone ? 'rgba(99, 102, 241, 0.2)' : (item.color ? item.color + '22' : 'rgba(2,132,199,0.15)');
      const categoryLabel = isZone ? `⛶ ${item.category || 'Zona / Recinto'}` : (item.category || 'Activo');

      card.innerHTML = `
        <div class="machine-card-header">
          <span class="machine-badge" style="background-color: ${badgeBg}; color: ${badgeColor};">${categoryLabel}</span>
          <span class="machine-dims">${item.width.toFixed(2)} x ${item.height.toFixed(2)} m</span>
        </div>
        <div class="machine-card-body">
          <div class="machine-thumb" style="border-color: ${item.color || (isZone ? '#818cf8' : '#38bdf8')}; ${isZone ? 'border-style: dashed;' : ''}">
            <span class="thumb-ratio">${isZone ? '⛶ ' : ''}${item.width.toFixed(1)}x${item.height.toFixed(1)}</span>
          </div>
          <div class="machine-info">
            <h4 class="machine-title">${item.name}</h4>
            <span class="drag-hint">⇄ ${isZone ? 'Arrastra zona al taller' : 'Arrastra al taller'}</span>
          </div>
        </div>
        
        <!-- Fila de Control de Cantidad -->
        <div class="qty-control-row">
          <div class="qty-control-left">
            <span class="qty-label">Cantidad:</span>
            ${item.isUnique
              ? `<span style="font-size: 10px; color: var(--text-muted); font-family: var(--font-mono); font-weight: 600;">1 (Único)</span>`
              : `<div class="qty-stepper">
                  <button type="button" class="btn-qty btn-qty-minus" data-id="${item.id}" title="Reducir cantidad">−</button>
                  <input type="number" class="input-qty" min="1" max="99" value="${targetQty}" data-id="${item.id}">
                  <button type="button" class="btn-qty btn-qty-plus" data-id="${item.id}" title="Aumentar cantidad">+</button>
                </div>`
            }
          </div>
          <span class="qty-status-badge ${isDone ? 'done' : ''}">
            ${isDone ? '✓ ' : ''}${placedCount} / ${targetQty} en planta
          </span>
        </div>

        <div style="display: flex; gap: 6px; align-self: flex-end; align-items: center; margin-top: 6px;">
          ${item.isCustom ? `<button type="button" class="btn-delete-custom" data-catalog-id="${item.id}" title="Eliminar definitivamente del catálogo">🗑</button>` : ''}
          <button type="button" class="btn-insert-quick btn-place-catalog" data-id="${item.id}" ${item.isUnique && placedCount >= 1 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''} title="${item.isUnique && placedCount >= 1 ? 'Activo único ya ubicado' : 'Colocar en el centro del taller'}">
            ${placedCount === 0 ? '+ Colocar' : (item.isUnique ? '✓ Ubicado' : '+ Colocar copia')}
          </button>
        </div>
      `;

      // Drag & Drop
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', `catalog:${item.id}`);
        e.dataTransfer.effectAllowed = 'copy';
        card.classList.add('dragging');
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
      });

      // Botón rápido para colocar
      card.querySelector('.btn-place-catalog')?.addEventListener('click', () => {
        const bounds = getWorkshopBounds();
        const offsetDist = placedCount * 0.5;
        this.placeCatalogInstance(item.id, bounds.centerX + offsetDist, bounds.centerY + offsetDist);
      });

      // Stepper Minus
      card.querySelector('.btn-qty-minus')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.quantity > 1 && item.quantity > placedCount) {
          item.quantity--;
          this.updateAllUI();
          this.saveState();
        } else if (item.quantity <= placedCount) {
          this.showToast(`Hay ${placedCount} unidades en planta. Retira una antes de reducir la cantidad.`);
        }
      });

      // Stepper Plus
      card.querySelector('.btn-qty-plus')?.addEventListener('click', (e) => {
        e.stopPropagation();
        item.quantity = (item.quantity || 1) + 1;
        this.updateAllUI();
        this.saveState();
      });

      // Input change
      card.querySelector('.input-qty')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 1) {
          item.quantity = Math.max(val, placedCount);
        }
        this.updateAllUI();
        this.saveState();
      });

      // Eliminar ítem personalizado
      card.querySelector('.btn-delete-custom')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const count = this.machines.filter(m => m.catalogId === item.id).length;
        const msg = count > 0 
          ? `¿Eliminar "${item.name}" del catálogo y retirar sus ${count} copias del taller?`
          : `¿Eliminar "${item.name}" del catálogo?`;
        if (confirm(msg)) {
          if (this.selectedMachineId) {
            const sel = this.getSelectedMachine();
            if (sel && (sel.catalogId === item.id || sel.id === item.id)) {
              this.selectMachine(null);
            }
          }
          if (item.isZone) {
            const deletedZoneIds = this.machines.filter(m => m.catalogId === item.id).map(m => m.id);
            this.machines.forEach(m => {
              if (deletedZoneIds.includes(m.parentId)) {
                m.parentId = null;
              }
            });
          }
          this.machines = this.machines.filter(m => m.catalogId !== item.id);
          this.catalog = this.catalog.filter(c => c.id !== item.id);
          this.updateAllUI();
          this.saveState();
          this.showToast(`"${item.name}" eliminado del catálogo.`);
        }
      });

      this.sidebarList.appendChild(card);
    }
  }

  renderPendingList() {
    if (!this.pendingListContainer) return;
    this.pendingListContainer.innerHTML = '';

    const pendingItems = [];
    for (const cat of this.catalog) {
      const placedCount = this.machines.filter(m => (m.catalogId === cat.id || m.id === cat.id) && m.isPlaced).length;
      const targetQty = cat.quantity || 1;
      if (placedCount < targetQty) {
        pendingItems.push({
          catalog: cat,
          remaining: targetQty - placedCount
        });
      }
    }

    if (pendingItems.length === 0) {
      this.pendingListContainer.innerHTML = `
        <div style="padding: 12px; text-align: center; color: var(--accent-green); font-size: 11px;">
          ✓ ¡Todas las máquinas y cantidades han sido ubicadas en planta!
        </div>
      `;
      return;
    }

    for (const item of pendingItems) {
      const cat = item.catalog;
      const div = document.createElement('div');
      div.className = 'pending-item';
      div.innerHTML = `
        <div class="pending-info">
          <span class="pending-name">${cat.name}</span>
          <span class="pending-dims">${cat.width.toFixed(2)} x ${cat.height.toFixed(2)} m · Pendientes: ${item.remaining}</span>
        </div>
        <button type="button" class="btn-place-pending" data-id="${cat.id}">+ Colocar</button>
      `;

      div.querySelector('.btn-place-pending')?.addEventListener('click', () => {
        const bounds = getWorkshopBounds();
        this.placeCatalogInstance(cat.id, bounds.centerX, bounds.centerY);
      });

      this.pendingListContainer.appendChild(div);
    }
  }

  updateInspector() {
    const selected = this.getSelectedMachine();
    if (!selected || !this.inspectorPanel) {
      this.inspectorPanel?.classList.add('hidden');
      return;
    }

    this.inspectorPanel.classList.remove('hidden');

    if (this.inspName) this.inspName.textContent = selected.name;
    if (this.inspDims) {
      if (selected.isZone) {
        const area = (selected.width * selected.height).toFixed(2);
        this.inspDims.textContent = `${selected.width.toFixed(2)} m (X) x ${selected.height.toFixed(2)} m (Y) · ${area} m²`;
      } else {
        this.inspDims.textContent = `${selected.width.toFixed(2)} m (X) x ${selected.height.toFixed(2)} m (Y)`;
      }
    }

    if (this.inspZoneTag) {
      if (selected.isZone) {
        const childrenCount = this.machines.filter(m => m.parentId === selected.id && m.isPlaced).length;
        const area = (selected.width * selected.height).toFixed(2);
        this.inspZoneTag.style.display = 'inline-block';
        this.inspZoneTag.style.background = 'rgba(99, 102, 241, 0.2)';
        this.inspZoneTag.style.color = '#a5b4fc';
        this.inspZoneTag.textContent = `⛶ RECINTO (${area} m² · ${childrenCount} objetos)`;
        if (this.btnDetachZone) this.btnDetachZone.style.display = 'none';
      } else if (selected.parentId) {
        const parentZone = this.machines.find(m => m.id === selected.parentId);
        this.inspZoneTag.style.display = 'inline-block';
        this.inspZoneTag.style.background = 'rgba(16, 185, 129, 0.2)';
        this.inspZoneTag.style.color = '#6ee7b7';
        this.inspZoneTag.textContent = `📍 Ubicado en: ${parentZone ? parentZone.name : 'Zona'}`;
        if (this.btnDetachZone) this.btnDetachZone.style.display = 'inline-block';
      } else {
        this.inspZoneTag.style.display = 'none';
        if (this.btnDetachZone) this.btnDetachZone.style.display = 'none';
      }
    }
    if (this.inspX) this.inspX.value = selected.x.toFixed(2);
    if (this.inspY) this.inspY.value = selected.y.toFixed(2);
    if (this.inspRot) this.inspRot.value = Math.round(selected.rotation);
    if (this.inspRotSlider) this.inspRotSlider.value = Math.round(selected.rotation);
    if (this.inspWallOffset) this.inspWallOffset.value = (selected.wallOffset ?? 0.80).toFixed(2);

    // Actualizar botones de arista activa
    this.inspOpEdgeBtns.forEach(btn => {
      const edge = parseInt(btn.dataset.edge, 10);
      btn.classList.toggle('active', edge === (selected.operatorEdge ?? 0));
    });

    this.inspOffEdgeBtns.forEach(btn => {
      const edge = parseInt(btn.dataset.edge, 10);
      btn.classList.toggle('active', edge === (selected.offsetEdge ?? 2));
    });

    if (this.inspOffsetBadge) {
      const offIdx = (selected.offsetEdge ?? 2) % 4;
      const offName = (EDGE_NAMES[offIdx] || `Arista ${offIdx}`).toUpperCase();
      this.inspOffsetBadge.textContent = `● CIAN ACTIVO: ${offName}`;
    }

    // Actualizar badge y botones de orientación del nombre (0°, 90°, 180°, 270°)
    const labelRotBadge = document.getElementById('insp-label-rot-badge');
    const rot = ((selected.labelRotation || 0) % 360 + 360) % 360;
    const descriptions = {
      0: '0° Frontal (Ancho)',
      90: '90° Derecho (Largo)',
      180: '180° Trasero (Ancho)',
      270: '270° Izquierdo (Largo)'
    };
    if (labelRotBadge) {
      labelRotBadge.textContent = descriptions[rot] || `${rot}°`;
    }

    if (this.inspLabelRotBtns) {
      this.inspLabelRotBtns.forEach(btn => {
        const btnRot = parseInt(btn.dataset.rot, 10);
        btn.classList.toggle('active', btnRot === rot);
      });
    }

    // Actualizar inputs de clearance de las 4 caras
    if (this.inspClearanceInputs) {
      const offsets = Array.isArray(selected.clearanceOffsets) && selected.clearanceOffsets.length === 4
        ? selected.clearanceOffsets
        : [0.00, 0.00, 0.00, 0.00];
      this.inspClearanceInputs.forEach((inp, i) => {
        if (inp) inp.value = (offsets[i] ?? 0.00).toFixed(2);
      });
    }
  }

  // ==========================================================
  // GESTIÓN DE LÍNEAS CONSTRUCTIVAS
  // ==========================================================
  setToolMode(mode) {
    this.toolMode = mode;
    this.guidelineStart = null;
    this.engine.setTempGuideline(null);

    const btn = document.getElementById('btn-tool-guideline');
    if (btn) btn.classList.toggle('active', mode === 'guideline');

    if (mode === 'guideline') {
      this.canvas.style.cursor = 'crosshair';
      this.selectMachine(null);
      this.selectGuideline(null);
      this.showToast('Modo Línea Constructiva: Haz clic en el canvas para trazar una guía.');
    } else {
      this.canvas.style.cursor = 'default';
    }
  }

  selectGuideline(id) {
    this.selectedGuidelineId = id;
    this.engine.setSelectedGuidelineId(id);
  }

  // ==========================================================
  // MODAL CREAR NUEVO OBJETO (Personalizado / Plantilla Reutilizable)
  // ==========================================================
  initCustomObjectModal() {
    const modal = document.getElementById('modal-create-object');
    const btnOpen = document.getElementById('btn-open-create-modal');
    const btnClose = document.getElementById('btn-close-create-modal');
    const btnCancel = document.getElementById('btn-cancel-create-modal');
    const form = document.getElementById('form-create-object');

    const openModal = () => {
      modal?.classList.remove('hidden');
      document.getElementById('new-obj-name')?.focus();
    };

    const closeModal = () => {
      modal?.classList.add('hidden');
      form?.reset();
    };

    const natureSelect = document.getElementById('new-obj-nature');
    const nameInput = document.getElementById('new-obj-name');
    const catSelect = document.getElementById('new-obj-category');
    const widthInput = document.getElementById('new-obj-width');
    const heightInput = document.getElementById('new-obj-height');
    const colorInput = document.getElementById('new-obj-color');

    natureSelect?.addEventListener('change', () => {
      if (natureSelect.value === 'zone') {
        if (!nameInput.value || nameInput.value === 'Mesa de Trabajo CNC') {
          nameInput.value = 'Área Metrología';
        }
        if (catSelect) catSelect.value = 'Zonas y Recintos';
        if (widthInput && (!widthInput.value || widthInput.value === '1.80')) widthInput.value = '6.00';
        if (heightInput && (!heightInput.value || heightInput.value === '2.00')) heightInput.value = '4.00';
        if (colorInput && colorInput.value === '#0284c7') colorInput.value = '#6366f1';
      } else {
        if (nameInput.value === 'Área Metrología') nameInput.value = '';
        if (catSelect && catSelect.value === 'Zonas y Recintos') catSelect.value = 'Personalizado';
        if (colorInput && colorInput.value === '#6366f1') colorInput.value = '#0284c7';
      }
    });

    btnOpen?.addEventListener('click', openModal);
    btnClose?.addEventListener('click', closeModal);
    btnCancel?.addEventListener('click', closeModal);

    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const nature = natureSelect?.value || 'solid';
      const isZone = (nature === 'zone');
      const objType = document.getElementById('new-obj-type')?.value || 'template';
      const name = nameInput?.value.trim();
      const category = catSelect?.value || (isZone ? 'Zonas y Recintos' : 'Personalizado');
      const width = parseFloat(widthInput?.value);
      const height = parseFloat(heightInput?.value);
      const wallOffset = parseFloat(document.getElementById('new-obj-wall-offset')?.value) || 0.80;
      const clearanceVal = parseFloat(document.getElementById('new-obj-clearance')?.value) || 0.00;
      const color = colorInput?.value || (isZone ? '#6366f1' : '#0284c7');

      if (!name || isNaN(width) || isNaN(height) || width < 0.20 || height < 0.20) {
        alert('Por favor introduce dimensiones válidas (mínimo 0.20 m) y un nombre descriptivo.');
        return;
      }

      const clrOffsets = [clearanceVal, clearanceVal, clearanceVal, clearanceVal];
      const isUnique = objType === 'unique';

      const newCatItem = {
        id: `custom_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        name,
        width: Number(width.toFixed(2)),
        height: Number(height.toFixed(2)),
        quantity: 1,
        category,
        color,
        wallOffset: Number(wallOffset.toFixed(2)),
        clearanceOffsets: clrOffsets,
        isCustom: true,
        isUnique,
        isZone
      };

      this.catalog.push(newCatItem);
      this.updateAllUI();
      this.saveState();
      closeModal();
      this.showToast(`"${name}" (${isZone ? 'Zona / Recinto' : 'Objeto'}) añadido al catálogo.`);
    });
  }

  saveState() {
    const view = {
      scale: this.engine.scale,
      panX: this.engine.panX,
      panY: this.engine.panY
    };
    saveToLocalStorage(this.machines, this.constructionLines, view, this.catalog);
  }

  showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }
}

// Inicializar la aplicación cuando el DOM esté listo
window.addEventListener('DOMContentLoaded', () => {
  window.app = new LayoutPlannerApp();
});
