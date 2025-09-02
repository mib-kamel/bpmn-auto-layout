import BPMNModdle from 'bpmn-moddle';
import { isBoundaryEvent, isConnection } from './utils/elementUtils.js';
import { Grid } from './Grid.js';
import { DiFactory } from './di/DiFactory.js';
import { is } from './di/DiUtil.js';
import { handlers } from './handler/index.js';
import { isFunction } from 'min-dash';

export class Layouter {
  constructor() {
    this.moddle = new BPMNModdle();
    this.diFactory = new DiFactory(this.moddle);
    this._handlers = handlers;
    // track created plane elements to avoid duplicate diagram creation for same element
    this._createdPlanes = new Set();
    // grid management
    this._gridSize = 20;
    this._usedGridPoints = new Set(); // track internal waypoint occupancy (exclude first/last)
  }

  handle(operation, options) {
    return this._handlers
      .filter(handler => isFunction(handler[operation]))
      .map(handler => handler[operation](options));

  }

  async layoutProcess(xml) {
    const { rootElement } = await this.moddle.fromXML(xml);

    this.diagram = rootElement;

    // Check if we have a collaboration first
    const collaboration = this.getCollaboration();
    const root = collaboration || this.getProcess();

    if (root) {
      this.cleanDi();

      if (collaboration) {
        this.handleCollaboration(collaboration);
      } else {
        this.handlePlane(root);
      }
    }

    return (await this.moddle.toXML(this.diagram, { format: true })).xml;
  }

  handlePlane(planeElement) {
    if (!planeElement || !planeElement.id) {
      return;
    }

    // avoid creating duplicate planes / diagrams (can happen for subprocess scan + explicit calls)
    if (this._createdPlanes.has(planeElement.id)) {
      return;
    }

    const layout = this.createGridLayout(planeElement);
    this.generateDi(planeElement, layout);
    this._createdPlanes.add(planeElement.id);
  }

  cleanDi() {
    this.diagram.diagrams = [];
    this._usedGridPoints.clear();
  }

  createGridLayout(root) {
    const grid = new Grid();

    const flowElements = root.flowElements || [];
    const elements = flowElements.filter(el => !is(el, 'bpmn:SequenceFlow'));

    // check for empty process/subprocess
    if (!flowElements) {
      return grid;
    }

    const boundaryEvents = flowElements.filter(el => isBoundaryEvent(el));
    boundaryEvents.forEach(boundaryEvent => {
      const attachedTask = boundaryEvent.attachedToRef;
      const attachers = attachedTask.attachers || [];
      attachers.push(boundaryEvent);
      attachedTask.attachers = attachers;
    });

    // Depth-first-search
    const visited = new Set();
    while (visited.size < elements.filter(element => !element.attachedToRef).length) {

      const startingElements = flowElements.filter(el => {
        return !isConnection(el) && !isBoundaryEvent(el) && (!el.incoming || el.incoming.length === 0) && !visited.has(el);
      });

      const stack = [...startingElements];

      startingElements.forEach(el => {
        grid.add(el);
        visited.add(el);
      });

      this.handleGrid(grid, visited, stack);

      if (grid.getElementsTotal() != elements.length) {
        const gridElements = grid.getAllElements();
        const missingElements = elements.filter(el => !gridElements.includes(el) && !isBoundaryEvent(el));
        if (missingElements.length > 1) {
          stack.push(missingElements[0]);
          grid.add(missingElements[0]);
          visited.add(missingElements[0]);
          this.handleGrid(grid, visited, stack);
        }
      }
    }
    return grid;
  }

  generateDi(root, layoutGrid) {
    const diFactory = this.diFactory;

    // Step 0: Create Root element
    const diagram = this.diagram;

    var planeDi = diFactory.createDiPlane({
      id: 'BPMNPlane_' + root.id,
      bpmnElement: root
    });
    var diagramDi = diFactory.createDiDiagram({
      id: 'BPMNDiagram_' + root.id,
      plane: planeDi
    });

    // Insert diagram: if generating a subprocess inside a collaboration keep collaboration first
    if (is(root, 'bpmn:SubProcess') && this.getCollaboration()) {
      diagram.diagrams.push(diagramDi);
    } else {
      diagram.diagrams.unshift(diagramDi);
    }

    const planeElement = planeDi.get('planeElement');

    // Step 1: Create DI for all elements
    layoutGrid.elementsByPosition().forEach(({ element, row, col }) => {
      const dis = this
        .handle('createElementDi', { element, row, col, layoutGrid, diFactory })
        .flat();

      planeElement.push(...dis);
    });

    // snap shapes to grid before creating connections so routing uses snapped bounds
    this._snapAllShapesToGrid(planeElement);

    // Step 2: Create DI for all connections
    layoutGrid.elementsByPosition().forEach(({ element, row, col }) => {
      const dis = this
        .handle('createConnectionDi', { element, row, col, layoutGrid, diFactory })
        .flat();

      planeElement.push(...dis);
    });
  }

  // --- Grid Helpers ------------------------------------------------------
  _snap(v) {
    const g = this._gridSize; return Math.round(v / g) * g;
  }
  _snapAllShapesToGrid(planeElement) {
    planeElement.forEach(pe => {
      if (pe.bounds) {
        const b = pe.bounds;
        // snap x,y
        const oldRight = b.x + b.width;
        const oldBottom = b.y + b.height;
        b.x = this._snap(b.x);
        b.y = this._snap(b.y);
        // adjust width/height so right/bottom also land on grid (expand if necessary)
        const snappedRight = this._snap(oldRight);
        const snappedBottom = this._snap(oldBottom);
        b.width = Math.max(this._gridSize, snappedRight - b.x);
        b.height = Math.max(this._gridSize, snappedBottom - b.y);
      }
    });
  }
  _snapWaypoints(waypoints, { lockFirstLast = true } = {}) {
    if (!Array.isArray(waypoints)) return waypoints;
    return waypoints.map((wp, idx) => {
      if (lockFirstLast && (idx === 0 || idx === waypoints.length - 1)) return wp; // keep docking exact to shape edge
      let x = this._snap(wp.x), y = this._snap(wp.y);
      // ensure unique grid point for internal waypoint
      const keyBase = () => x + ',' + y;
      if (this._usedGridPoints.has(keyBase())) {
        // search nearby free spots expanding manhattan distance
        const g = this._gridSize;
        let found = false; let radius = 1;
        while (!found && radius < 6) {
          const candidates = [
            [x + g * radius, y], [x - g * radius, y], [x, y + g * radius], [x, y - g * radius]
          ];
          for (const [cx, cy] of candidates) {
            const ck = cx + ',' + cy;
            if (!this._usedGridPoints.has(ck)) { x = cx; y = cy; found = true; break; }
          }
          radius++;
        }
      }
      this._usedGridPoints.add(x + ',' + y);
      return { x, y };
    });
  }

  _sanitizeWaypoints(waypoints, { keepEnds = false } = {}) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) return waypoints;
    const firstOrig = waypoints[0];
    const lastOrig = waypoints[waypoints.length - 1];
    // 1) Snap everything (optionally skip ends)
    waypoints = waypoints.map((wp, idx) => {
      if (keepEnds && (idx === 0 || idx === waypoints.length - 1)) return { ...wp }; // leave as is
      return { x: this._snap(wp.x), y: this._snap(wp.y) };
    });
    // 2) Remove consecutive duplicates
    const cleaned = [];
    for (const wp of waypoints) {
      if (!cleaned.length || cleaned[cleaned.length - 1].x !== wp.x || cleaned[cleaned.length - 1].y !== wp.y) cleaned.push(wp);
    }
    // 3) Straighten near-misses: if diagonal, insert bend
    const orth = [cleaned[0]];
    for (let i = 1; i < cleaned.length; i++) {
      const prev = orth[orth.length - 1];
      const cur = cleaned[i];
      if (prev.x !== cur.x && prev.y !== cur.y) {
        // insert horizontal then vertical bend at grid
        orth.push({ x: cur.x, y: prev.y });
      }
      orth.push(cur);
    }
    // 4) Remove redundant collinear interior points
    const finalWps = [orth[0]];
    for (let i = 1; i < orth.length - 1; i++) {
      const a = finalWps[finalWps.length - 1];
      const b = orth[i];
      const c = orth[i + 1];
      const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
      if (collinear) continue; // skip b
      finalWps.push(b);
    }
    finalWps.push(orth[orth.length - 1]);
    if (keepEnds) {
      finalWps[0] = firstOrig; // restore docking
      finalWps[finalWps.length - 1] = lastOrig;
    }
    return finalWps;
  }

  _rectDock(bounds, towardX, towardY) {
    if (!bounds) return { x: towardX, y: towardY };
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    let dx = towardX - cx; let dy = towardY - cy;
    if (dx === 0 && dy === 0) dy = 0.0001;
    const halfW = bounds.width / 2, halfH = bounds.height / 2;
    const scale = 1 / (Math.abs(dx) / halfW + Math.abs(dy) / halfH);
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  handleGrid(grid, visited, stack) {
    while (stack.length > 0) {
      const currentElement = stack.pop();

      if (is(currentElement, 'bpmn:SubProcess')) {
        this.handlePlane(currentElement);
      }

      const nextElements = this.handle('addToGrid', { element: currentElement, grid, visited, stack });

      nextElements.flat().forEach(el => {
        stack.push(el);
        visited.add(el);
      });
    }
  }

  getProcess() {
    return this.diagram.get('rootElements').find(el => el.$type === 'bpmn:Process');
  }

  getCollaboration() {
    return this.diagram.get('rootElements').find(el => el.$type === 'bpmn:Collaboration');
  }

  handleCollaboration(collaboration) {
    const processes = this.getProcessesInCollaboration(collaboration);
    const participants = collaboration.participants || [];

    const diFactory = this.diFactory;
    const planeDi = diFactory.createDiPlane({ id: 'BPMNPlane_' + collaboration.id, bpmnElement: collaboration });
    const diagramDi = diFactory.createDiDiagram({ id: 'BPMNDiagram_' + collaboration.id, plane: planeDi });
    this.diagram.diagrams.push(diagramDi);
    const planeElement = planeDi.get('planeElement');

    // Layout participants (pools)
    let currentY = 50;
    const poolMinHeight = 180, poolSpacing = 60, poolLeft = 50, poolRightPadding = 80;
    participants.forEach(participant => {
      const tempPoolBounds = { x: poolLeft, y: currentY, width: 800, height: poolMinHeight };
      const poolShape = diFactory.createDiShape(participant, tempPoolBounds, { id: participant.id + '_di', isHorizontal: true });
      planeElement.push(poolShape);
      participant.di = poolShape;
      if (participant.processRef) {
        const bbox = this.layoutProcessInPool(participant.processRef, tempPoolBounds, planeElement, diFactory);
        if (bbox) {
          poolShape.bounds.width = Math.max(bbox.maxX + poolRightPadding - tempPoolBounds.x, tempPoolBounds.width);
          poolShape.bounds.height = Math.max(bbox.maxY + 40 - tempPoolBounds.y, tempPoolBounds.height);
        }
      }
      currentY += poolShape.bounds.height + poolSpacing;
    });

    // Message flows
    this.handleMessageFlows(collaboration, planeElement, diFactory);

    // Collaboration-level text annotations: if associated only with elements in a single lane, place inside that lane; otherwise fallback below pools
    const collAssociations = (collaboration.artifacts || []).filter(a => is(a, 'bpmn:Association'));
    const textAnnotations = (collaboration.artifacts || []).filter(a => is(a, 'bpmn:TextAnnotation'));

    // Build elementId -> lane / participant map
    const laneIndex = new Map();
    const participantIndex = new Map();
    participants.forEach(p => {
      if (p.processRef) {
        participantIndex.set(p.processRef.id, p);
        const laneSets = p.processRef.laneSets || p.processRef.laneSet || [];
        const laneSet = Array.isArray(laneSets) ? laneSets[0] : laneSets[0];
        const lanes = laneSet && laneSet.lanes ? laneSet.lanes : [];
        lanes.forEach(l => {
          (l.flowNodeRef || []).forEach(fn => laneIndex.set(fn.id, l));
        });
      }
    });

    textAnnotations.forEach(ta => {
      if (ta.di) return; // already placed
      // Find all association targets for this TA
      const relatedAssocs = collAssociations.filter(a => (Array.isArray(a.sourceRef) ? a.sourceRef : [a.sourceRef]).some(s => s && s.id === ta.id));
      const targetIds = relatedAssocs.map(a => a.targetRef && a.targetRef.id).filter(Boolean);
      const targetLanes = new Set(targetIds.map(id => laneIndex.get(id)).filter(Boolean));
      let chosenBounds = null;
      if (targetLanes.size === 1) {
        // place inside that lane
        const lane = [...targetLanes][0];
        const laneShape = planeElement.find(pe => pe.bpmnElement === lane);
        if (laneShape) {
          chosenBounds = {
            x: laneShape.bounds.x + 10,
            y: laneShape.bounds.y + 50, // below lane header
            width: 160,
            height: 50
          };
        }
      } else if (targetLanes.size === 0 && targetIds.length) {
        // No lanes (process without lanes) -> place inside participant pool of first target
        const firstTargetId = targetIds[0];
        // find process of target by searching participants' processes
        let owningParticipant = null;
        participants.forEach(p => {
          if (p.processRef && (p.processRef.flowElements || []).some(fe => fe.id === firstTargetId)) owningParticipant = p;
        });
        if (owningParticipant && owningParticipant.di) {
          chosenBounds = {
            x: owningParticipant.di.bounds.x + 10,
            y: owningParticipant.di.bounds.y + 20,
            width: 160,
            height: 50
          };
        }
      }
      if (!chosenBounds) {
        const firstPool = participants.find(p => p.di);
        const baseX = firstPool ? firstPool.di.bounds.x + 20 : 50;
        chosenBounds = { x: baseX, y: currentY + 20, width: 160, height: 50 };
      }
      const shapeDi = diFactory.createDiShape(ta, chosenBounds, { id: ta.id + '_di' });
      ta.di = shapeDi; planeElement.push(shapeDi);
    });

    // Collaboration-level associations (e.g., TextAnnotation -> element in a process)
    collAssociations.forEach(assoc => {
      const sourceRefs = assoc.sourceRef ? (Array.isArray(assoc.sourceRef) ? assoc.sourceRef : [assoc.sourceRef]) : [];
      const targetRef = assoc.targetRef;
      sourceRefs.forEach(src => {
        const sDi = src && src.di; const tDi = targetRef && targetRef.di;
        if (sDi && tDi && sDi.bounds && tDi.bounds) {
          const waypoints = this._dockBetween(sDi.bounds, tDi.bounds);
          const edgeId = assoc.id + '_di';
          if (!planeElement.find(pe => pe.id === edgeId)) {
            planeElement.push(diFactory.createDiEdge(assoc, waypoints, { id: edgeId }));
          }
        }
      });
    });

    // Sub process diagrams
    processes.forEach(process => {
      if (process && process.flowElements) {
        process.flowElements.filter(el => is(el, 'bpmn:SubProcess')).forEach(sp => this.handlePlane(sp));
      }
    });

    // Keep collaboration diagram first
    const collIndex = this.diagram.diagrams.indexOf(diagramDi);
    if (collIndex > 0) {
      this.diagram.diagrams.splice(collIndex, 1);
      this.diagram.diagrams.unshift(diagramDi);
    }
  }

  getProcessesInCollaboration(collaboration) {
    const participants = collaboration.participants || [];
    return participants
      .map(p => p.processRef)
      .filter(p => p);
  }

  layoutProcessInPool(process, poolBounds, planeElement, diFactory) {
    if (!process || !process.flowElements) return;

    // Handle lanes if they exist
    // BPMN moddle exposes laneSets (plural). Keep backward compatibility with laneSet.
    const laneSets = process.laneSets || process.laneSet || [];
    const laneSet = Array.isArray(laneSets) ? laneSets[0] : laneSets[0];
    const lanes = laneSet && laneSet.lanes ? laneSet.lanes : [];

    if (lanes.length > 0) {
      return this.layoutProcessWithLanes(process, poolBounds, planeElement, diFactory, lanes);
    } else {
      return this.layoutProcessWithoutLanes(process, poolBounds, planeElement, diFactory);
    }
  }

  layoutProcessWithLanes(process, poolBounds, planeElement, diFactory, lanes) {
    // constants
    const poolPaddingX = 140; // left space for lane labels
    const colGap = 120;
    const rowGap = 30;
    const taskWidth = 100;
    const taskHeight = 80;
    const minLaneHeight = 140;
    const laneHeader = 40; // typical BPMN lane label band

    // lookup map
    const elementIndex = new Map();
    (process.flowElements || []).forEach(el => elementIndex.set(el.id, el));

    // build forward graph for BFS layering shared across lanes
    const flows = (process.flowElements || []).filter(el => is(el, 'bpmn:SequenceFlow'));
    const outgoing = new Map();
    const incomingCount = new Map();
    flows.forEach(f => {
      if (!outgoing.has(f.sourceRef.id)) outgoing.set(f.sourceRef.id, new Set());
      outgoing.get(f.sourceRef.id).add(f.targetRef.id);
      incomingCount.set(f.targetRef.id, (incomingCount.get(f.targetRef.id) || 0) + 1);
      if (!incomingCount.has(f.sourceRef.id)) incomingCount.set(f.sourceRef.id, 0);
    });
    function computeDepths(ids) {
      const depth = new Map();
      const queue = [];
      ids.forEach(id => {
        const el = elementIndex.get(id);
        const isStart = el && is(el, 'bpmn:StartEvent');
        if (isStart || (incomingCount.get(id) === 0)) {
          depth.set(id, 0); queue.push(id);
        }
      });
      while (queue.length) {
        const cur = queue.shift(); const d = depth.get(cur); const succ = outgoing.get(cur) || [];
        // shortest-path style layering: assign first time only
        succ.forEach(s => { if (depth.get(s) === undefined) { depth.set(s, d + 1); queue.push(s); } });
      }
      let max = 0; depth.forEach(v => { if (v > max) max = v; });
      ids.forEach(id => { if (!depth.has(id)) depth.set(id, max + 1); });
      return depth;
    }

    // First pass: layout each lane in its own local coordinate system (x absolute, y relative inside lane)
    const laneStores = [];
    let globalInternalMaxX = poolPaddingX; // relative to poolBounds.x

    lanes.forEach(lane => {
      const laneElements = (lane.flowNodeRef || []).map(r => elementIndex.get(r.id)).filter(Boolean);
      const laneDepths = computeDepths(laneElements.map(e => e.id));
      const positioned = laneElements.map(el => ({ el, depth: laneDepths.get(el.id) || 0 }));
      positioned.sort((a, b) => a.depth - b.depth || a.el.id.localeCompare(b.el.id));
      const columnRows = new Map();
      let maxInternalX = poolPaddingX;
      let maxInternalY = 0;
      const elementLayouts = [];
      positioned.forEach(({ el, depth }) => {
        const rowIndex = columnRows.get(depth) || 0; columnRows.set(depth, rowIndex + 1);
        const x = poolPaddingX + depth * (taskWidth + colGap);
        const y = rowIndex * (taskHeight + rowGap);
        const bounds = { x: poolBounds.x + x, y: y, width: taskWidth, height: taskHeight }; // y relative for now
        this.adjustElementBounds(el, bounds); // may change size (affects height/width)
        maxInternalX = Math.max(maxInternalX, x + bounds.width);
        maxInternalY = Math.max(maxInternalY, y + bounds.height);
        elementLayouts.push({ el, bounds });
      });
      globalInternalMaxX = Math.max(globalInternalMaxX, maxInternalX);
      const laneHeight = Math.max(minLaneHeight, laneHeader + maxInternalY + 40); // padding bottom
      laneStores.push({ lane, elementLayouts, laneHeight });
    });

    // Second pass: assign final absolute Y positions, create DI (lane first, then elements) so lanes render behind elements
    let cursorY = poolBounds.y + 0; // top of pool content
    let overallMaxY = poolBounds.y;
    laneStores.forEach(store => {
      const { lane, elementLayouts, laneHeight } = store;
      const laneShape = diFactory.createDiShape(lane, { x: poolBounds.x, y: cursorY, width: globalInternalMaxX + 60, height: laneHeight }, { id: lane.id + '_di', isHorizontal: true });
      planeElement.push(laneShape); // lane first
      const contentOffsetY = laneShape.bounds.y + laneHeader; // where flow nodes start
      elementLayouts.forEach(({ el, bounds }) => {
        bounds.y = contentOffsetY + bounds.y; // convert relative->absolute
        const options = { id: el.id + '_di' };
        if (is(el, 'bpmn:ExclusiveGateway') || is(el, 'bpmn:ParallelGateway')) options.isMarkerVisible = true;
        const shapeDi = diFactory.createDiShape(el, bounds, options);
        el.di = shapeDi; planeElement.push(shapeDi);
        overallMaxY = Math.max(overallMaxY, bounds.y + bounds.height);
      });
      overallMaxY = Math.max(overallMaxY, laneShape.bounds.y + laneShape.bounds.height);
      cursorY += laneHeight; // next lane
    });

    const overallMaxX = poolBounds.x + globalInternalMaxX + 60; // include right padding

    // Finally draw connections now that element coordinates are final
    this.createConnectionsForProcess(process, planeElement, diFactory);
    return { maxX: overallMaxX, maxY: overallMaxY };
  }

  layoutProcessWithoutLanes(process, poolBounds, planeElement, diFactory) {
    const elements = (process.flowElements || []).filter(el => !is(el, 'bpmn:SequenceFlow'));
    const flows = (process.flowElements || []).filter(el => is(el, 'bpmn:SequenceFlow'));
    const outgoing = new Map();
    const incomingCount = new Map();
    flows.forEach(f => { if (!outgoing.has(f.sourceRef.id)) outgoing.set(f.sourceRef.id, new Set()); outgoing.get(f.sourceRef.id).add(f.targetRef.id); incomingCount.set(f.targetRef.id, (incomingCount.get(f.targetRef.id) || 0) + 1); if (!incomingCount.has(f.sourceRef.id)) incomingCount.set(f.sourceRef.id, 0); });
    const depth = new Map();
    const queue = [];
    elements.forEach(el => { const isStart = is(el, 'bpmn:StartEvent'); if (isStart || incomingCount.get(el.id) === 0) { depth.set(el.id, 0); queue.push(el.id); } });
    while (queue.length) { const cur = queue.shift(); const d = depth.get(cur); const succ = outgoing.get(cur) || []; succ.forEach(s => { const prev = depth.get(s); if (prev === undefined || d + 1 > prev) { depth.set(s, d + 1); queue.push(s); } }); }
    // convert to shortest-path layering (no depth upgrades after initial set)
    // Rerun BFS with shortest logic so already set depths remain minimal
    // (Previous loop may have upgraded depths; rebuild if upgrades occurred)
    // Detect if any upgrades happened (by presence of re-queue after initial set)
    // Simpler: recompute clean with shortest semantics
    const shortestDepth = new Map();
    const q2 = [];
    elements.forEach(el => { const isStart = is(el, 'bpmn:StartEvent'); if (isStart || incomingCount.get(el.id) === 0) { shortestDepth.set(el.id, 0); q2.push(el.id); } });
    while (q2.length) { const cur = q2.shift(); const d2 = shortestDepth.get(cur); const succ2 = outgoing.get(cur) || []; succ2.forEach(s => { if (shortestDepth.get(s) === undefined) { shortestDepth.set(s, d2 + 1); q2.push(s); } }); }
    let max2 = 0; shortestDepth.forEach(v => { if (v > max2) max2 = v; });
    elements.forEach(el => { if (!shortestDepth.has(el.id)) shortestDepth.set(el.id, max2 + 1); });
    depth.clear(); shortestDepth.forEach((v, k) => depth.set(k, v));
    let max = 0; depth.forEach(v => { if (v > max) max = v; });
    elements.forEach(el => { if (!depth.has(el.id)) depth.set(el.id, max + 1); });
    const sorted = elements.slice().sort((a, b) => depth.get(a.id) - depth.get(b.id) || a.id.localeCompare(b.id));
    const colWidth = 160, rowHeight = 110, baseX = poolBounds.x + 140, baseY = poolBounds.y + 40;
    const columnRows = new Map(); let maxX = baseX, maxY = baseY;
    sorted.forEach(el => { const d = depth.get(el.id); const rowIndex = columnRows.get(d) || 0; columnRows.set(d, rowIndex + 1); const x = baseX + d * colWidth; const y = baseY + rowIndex * rowHeight; const elementBounds = { x, y, width: 100, height: 80 }; this.adjustElementBounds(el, elementBounds); const options = { id: el.id + '_di' }; if (is(el, 'bpmn:ExclusiveGateway') || is(el, 'bpmn:ParallelGateway')) options.isMarkerVisible = true; const shapeDi = diFactory.createDiShape(el, elementBounds, options); el.di = shapeDi; planeElement.push(shapeDi); maxX = Math.max(maxX, elementBounds.x + elementBounds.width); maxY = Math.max(maxY, elementBounds.y + elementBounds.height); });
    this.createConnectionsForProcess(process, planeElement, diFactory);
    return { maxX, maxY };
  }

  adjustElementBounds(element, elementBounds) {
    // Adjust bounds for different element types
    if (is(element, 'bpmn:StartEvent') || is(element, 'bpmn:EndEvent') || is(element, 'bpmn:IntermediateCatchEvent')) {
      elementBounds.width = 36;
      elementBounds.height = 36;
      elementBounds.y += 22; // Center vertically
    } else if (is(element, 'bpmn:ExclusiveGateway') || is(element, 'bpmn:ParallelGateway')) {
      elementBounds.width = 50;
      elementBounds.height = 50;
      elementBounds.y += 15; // Center vertically
    }
  }

  createConnectionsForProcess(process, planeElement, diFactory) {
    // Pass 0: classify sides for all sequence flows so we can distribute unique entry/exit anchor points per edge
    // Side codes: 'L','R','T','B'
    const outgoingGroups = new Map(); // key = elementId + '|' + side -> flows[]
    const incomingGroups = new Map(); // key = elementId + '|' + side -> flows[]

    function classifySide(sourceBounds, targetBounds) {
      const gapRight = targetBounds.x - (sourceBounds.x + sourceBounds.width);
      const gapLeft = sourceBounds.x - (targetBounds.x + targetBounds.width);
      const gapDown = targetBounds.y - (sourceBounds.y + sourceBounds.height);
      const gapUp = sourceBounds.y - (targetBounds.y + targetBounds.height);
      const hClear = Math.max(gapRight, gapLeft);
      const vClear = Math.max(gapDown, gapUp);
      // Prefer horizontal if clear separation horizontally
      if (gapRight > 5) return { s: 'R', t: 'L' };
      if (gapLeft > 5) return { s: 'L', t: 'R' };
      if (gapDown > 5) return { s: 'B', t: 'T' };
      if (gapUp > 5) return { s: 'T', t: 'B' };
      // Fallback: choose shortest axis
      if (hClear >= vClear) {
        if (sourceBounds.x + sourceBounds.width / 2 <= targetBounds.x + targetBounds.width / 2) return { s: 'R', t: 'L' };
        return { s: 'L', t: 'R' };
      }
      if (sourceBounds.y + sourceBounds.height / 2 <= targetBounds.y + targetBounds.height / 2) return { s: 'B', t: 'T' };
      return { s: 'T', t: 'B' };
    }

    (process.flowElements || []).forEach(el => {
      (el.outgoing || []).forEach(flow => {
        const src = flow.sourceRef, tgt = flow.targetRef;
        if (!(src && tgt && src.di && tgt.di)) return;
        const sb = src.di.bounds, tb = tgt.di.bounds;
        const sides = classifySide(sb, tb);
        const outKey = src.id + '|' + sides.s;
        const inKey = tgt.id + '|' + sides.t;
        if (!outgoingGroups.has(outKey)) outgoingGroups.set(outKey, []);
        outgoingGroups.get(outKey).push(flow);
        if (!incomingGroups.has(inKey)) incomingGroups.set(inKey, []);
        incomingGroups.get(inKey).push(flow);
        flow.__autoLayoutSides = sides; // store for later use
      });
    });
    // Sort flows within each group for stable anchor ordering (by id for determinism)
    for (const group of [...outgoingGroups.values(), ...incomingGroups.values()]) group.sort((a, b) => a.id.localeCompare(b.id));

    (process.flowElements || []).forEach(element => {
      if (!element.outgoing) return;
      element.outgoing.forEach(flow => {
        const sourceElement = flow.sourceRef;
        const targetElement = flow.targetRef;
        if (!(sourceElement && targetElement && sourceElement.di && targetElement.di)) return;
        const sourceBounds = sourceElement.di.bounds;
        const targetBounds = targetElement.di.bounds;
        const sourceIsGateway = is(sourceElement, 'bpmn:ExclusiveGateway') || is(sourceElement, 'bpmn:ParallelGateway');
        const targetIsGateway = is(targetElement, 'bpmn:ExclusiveGateway') || is(targetElement, 'bpmn:ParallelGateway');

        // Default docking points (right of source, left of target)
        let sourcePoint = { x: sourceBounds.x + sourceBounds.width, y: sourceBounds.y + sourceBounds.height / 2 };
        let targetPoint = { x: targetBounds.x, y: targetBounds.y + targetBounds.height / 2 };

        // Adjust incoming to gateway: ensure we land exactly on left edge (avoid overshoot into diamond)
        if (targetIsGateway) {
          targetPoint = { x: targetBounds.x, y: targetBounds.y + targetBounds.height / 2 };
        }

        // Gateway outgoing: compute precise intersection of center->target ray with diamond boundary
        if (sourceIsGateway && sourceElement.outgoing && sourceElement.outgoing.length) {
          const srcCx = sourceBounds.x + sourceBounds.width / 2;
          const srcCy = sourceBounds.y + sourceBounds.height / 2;
          const tgtCx = targetBounds.x + targetBounds.width / 2;
          const tgtCy = targetBounds.y + targetBounds.height / 2;
          let dx = tgtCx - srcCx;
          let dy = tgtCy - srcCy;
          if (dx === 0 && dy === 0) dx = 0.0001; // avoid degenerate
          const halfW = sourceBounds.width / 2;
          const halfH = sourceBounds.height / 2;
          const scale = 1 / (Math.abs(dx) / halfW + Math.abs(dy) / halfH); // parametric diamond edge intersection
          const ix = srcCx + dx * scale;
          const iy = srcCy + dy * scale;
          sourcePoint = { x: ix, y: iy };
          // Determine primary direction side
          const side = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'B' : 'T');
          // Group outgoing flows by side once per gateway for stable ordering / distribution
          if (!sourceElement.__gwSideGroups) {
            const map = { R: [], L: [], T: [], B: [] };
            sourceElement.outgoing.forEach(f => {
              const t = f.targetRef && f.targetRef.di && f.targetRef.di.bounds;
              if (!t) return;
              const tcx = t.x + t.width / 2;
              const tcy = t.y + t.height / 2;
              let ddx = tcx - srcCx; let ddy = tcy - srcCy; if (ddx === 0 && ddy === 0) ddx = 0.0001;
              const s = Math.abs(ddx) >= Math.abs(ddy) ? (ddx > 0 ? 'R' : 'L') : (ddy > 0 ? 'B' : 'T');
              map[s].push(f);
            });
            // stable sort
            Object.keys(map).forEach(k => map[k].sort((a, b) => a.id.localeCompare(b.id)));
            sourceElement.__gwSideGroups = map;
          }
          const group = sourceElement.__gwSideGroups[side] || [];
          if (group.length > 1) {
            const index = group.indexOf(flow);
            const spread = 14; // spacing between branches
            const offsetIndex = index - (group.length - 1) / 2;
            const stubLen = 10;
            // Build orthogonal stub sequence: first go outward (cardinal), then distribute perpendicular
            let stubPoints = [];
            if (side === 'R' || side === 'L') {
              const dir = side === 'R' ? 1 : -1;
              const outward = { x: ix + dir * stubLen, y: iy };
              const distributed = offsetIndex !== 0 ? { x: outward.x, y: iy + offsetIndex * spread } : null;
              stubPoints = distributed ? [outward, distributed] : [outward];
            } else { // T or B
              const dir = side === 'B' ? 1 : -1;
              const outward = { x: ix, y: iy + dir * stubLen };
              const distributed = offsetIndex !== 0 ? { x: ix + offsetIndex * spread, y: outward.y } : null;
              stubPoints = distributed ? [outward, distributed] : [outward];
            }
            flow.__gatewayStub = { start: sourcePoint, stubs: stubPoints };
          }
        }

        // Vertical docking for near vertical alignment (e.g., stacked tasks) to use bottom->top edges instead of side routing
        const srcCenterX = sourceBounds.x + sourceBounds.width / 2;
        const tgtCenterX = targetBounds.x + targetBounds.width / 2;
        const srcBottom = sourceBounds.y + sourceBounds.height;
        const tgtTop = targetBounds.y;
        const verticalGap = tgtTop - srcBottom;
        const overlapX = Math.min(sourceBounds.x + sourceBounds.width, targetBounds.x + targetBounds.width) - Math.max(sourceBounds.x, targetBounds.x);
        // predeclare verticalAnchor (may change after adjustments); initialize false and set later
        let verticalAnchor = false;
        // Reduce threshold so typical task row gap (~30) triggers vertical docking; allow if gap >= 10
        // Relaxed vertical docking: allow if (a) sufficient horizontal overlap OR (b) centers close enough
        const centerDeltaX = Math.abs(srcCenterX - tgtCenterX);
        const nearCenter = centerDeltaX <= Math.max(sourceBounds.width, targetBounds.width) * 0.6;
        if (verticalGap >= 10 && (overlapX > Math.min(sourceBounds.width, targetBounds.width) * 0.4 || nearCenter)) {
          // target below source with decent horizontal overlap -> vertical connection
          // Prefer bottom center if source has only one outgoing OR target has only one incoming
          const singleOut = (sourceElement.outgoing || []).length === 1;
          const singleIn = (targetElement.incoming || []).length === 1;
          sourcePoint = { x: srcCenterX, y: srcBottom };
          targetPoint = { x: tgtCenterX, y: tgtTop };
        } else {
          // check reverse (target above source)
          const srcTop = sourceBounds.y;
          const tgtBottom = targetBounds.y + targetBounds.height;
          const reverseVerticalGap = srcTop - tgtBottom;
          if (reverseVerticalGap >= 10 && (overlapX > Math.min(sourceBounds.width, targetBounds.width) * 0.4 || nearCenter)) {
            sourcePoint = { x: sourceBounds.x + sourceBounds.width / 2, y: srcTop }; // top center
            targetPoint = { x: tgtCenterX, y: tgtBottom }; // bottom center
          }
        }

        // Under-route strategy for right-to-left flow into a target with multiple incomings (e.g., Event -> Activity to its left) to avoid crossing front face
        const isRightToLeft = sourceBounds.x > targetBounds.x + targetBounds.width + 10; // clearly to right
        const targetIncomingCount = (targetElement.incoming || []).length;
        const shouldUnderRoute = isRightToLeft && targetIncomingCount > 1;
        if (shouldUnderRoute) {
          const underY = Math.max(sourceBounds.y + sourceBounds.height, targetBounds.y + targetBounds.height) + 30;
          // bottom docking points
          const startBottom = { x: sourceBounds.x + sourceBounds.width / 2, y: sourceBounds.y + sourceBounds.height };
          const endBottom = { x: tgtCenterX, y: targetBounds.y + targetBounds.height };
          sourcePoint = startBottom; // adjust docking to bottom center
          targetPoint = { x: tgtCenterX, y: targetBounds.y + targetBounds.height }; // bottom center of target
          // Build orthogonal path: down, across, up
          const downPoint = { x: startBottom.x, y: underY };
          const acrossPoint = { x: endBottom.x, y: underY };
          const upPoint = endBottom; // already bottom edge; if prefer entering from left, adjust
          let waypointsUnder = [startBottom, downPoint, acrossPoint, upPoint];
          waypointsUnder = this._snapWaypoints(waypointsUnder);
          waypointsUnder = this._sanitizeWaypoints(waypointsUnder);
          planeElement.push(diFactory.createDiEdge(flow, waypointsUnder, { id: flow.id + '_di' }));
          return; // done
        }

        // Unique anchor distribution: adjust sourcePoint / targetPoint if classified side groups have >1
        if (flow.__autoLayoutSides && !sourceIsGateway) { // skip source distribution for gateways (handled by intersection)
          const { s: sSide, t: tSide } = flow.__autoLayoutSides;
          function applyAnchor(bounds, point, side, index, total) {
            if (total <= 1) return point;
            const slots = total + 1; // leave padding top/bottom or left/right
            if (side === 'R' || side === 'L') {
              const newY = bounds.y + ((index + 1) / slots) * bounds.height;
              return { x: point.x, y: newY };
            } else if (side === 'T' || side === 'B') {
              const newX = bounds.x + ((index + 1) / slots) * bounds.width;
              return { x: newX, y: point.y };
            }
            return point;
          }
          // source
          const outKey = sourceElement.id + '|' + sSide;
          const outGroup = outgoingGroups.get(outKey) || [];
          const sIdx = outGroup.indexOf(flow);
          if (sIdx !== -1) sourcePoint = applyAnchor(sourceBounds, sourcePoint, sSide, sIdx, outGroup.length);
          // target
          const inKey = targetElement.id + '|' + tSide;
          const inGroup = incomingGroups.get(inKey) || [];
          const tIdx = inGroup.indexOf(flow);
          if (tIdx !== -1) targetPoint = applyAnchor(targetBounds, targetPoint, tSide, tIdx, inGroup.length);
        }

        let waypoints;
        verticalAnchor = verticalAnchor || (sourceIsGateway && (sourcePoint.y === sourceBounds.y || sourcePoint.y === sourceBounds.y + sourceBounds.height));
        if (verticalAnchor) {
          // start vertical then route horizontally
          const verticalOffset = (sourcePoint.y === sourceBounds.y) ? -20 : 20;
          const first = { x: sourcePoint.x, y: sourcePoint.y + verticalOffset };
          const midX = (targetPoint.x + sourceBounds.x + sourceBounds.width) / 2;
          waypoints = [sourcePoint, first, { x: midX, y: first.y }, { x: midX, y: targetPoint.y }, targetPoint];
        } else if (Math.abs(sourcePoint.x - targetPoint.x) < 6 && (sourcePoint.y < targetPoint.y ? targetPoint.y - sourcePoint.y : sourcePoint.y - targetPoint.y) > 10) {
          // straight vertical
          waypoints = [sourcePoint, targetPoint];
        } else if (Math.abs(sourcePoint.y - targetPoint.y) < 10) {
          waypoints = [sourcePoint, targetPoint];
        } else {
          const midX = (sourcePoint.x + targetPoint.x) / 2;
          waypoints = [sourcePoint, { x: midX, y: sourcePoint.y }, { x: midX, y: targetPoint.y }, targetPoint];
        }
        // If gateway stub fan-out defined, inject stub points (already orthogonal)
        if (flow.__gatewayStub && waypoints && waypoints.length) {
          const { stubs } = flow.__gatewayStub;
          if (stubs && stubs.length) {
            waypoints = [waypoints[0], ...stubs, ...waypoints.slice(1)];
          }
        }
        // Ensure orthogonal segments only (Manhattan). Insert bends where diagonal segments exist.
        if (waypoints && waypoints.length > 1) {
          const ortho = [waypoints[0]];
          for (let i = 1; i < waypoints.length; i++) {
            const prev = ortho[ortho.length - 1];
            const cur = waypoints[i];
            if (prev.x !== cur.x && prev.y !== cur.y) {
              // choose bend: horizontal then vertical
              ortho.push({ x: cur.x, y: prev.y });
            }
            ortho.push(cur);
          }
          waypoints = ortho;
        }
        // adjust first/last points to exact shape border after possible anchor modifications
        if (waypoints.length >= 2) {
          const first = waypoints[0];
          const last = waypoints[waypoints.length - 1];
          waypoints[0] = this._rectDock(sourceBounds, waypoints[1].x, waypoints[1].y);
          waypoints[waypoints.length - 1] = this._rectDock(targetBounds, waypoints[waypoints.length - 2].x, waypoints[waypoints.length - 2].y);
        }
        waypoints = this._snapWaypoints(waypoints, { lockFirstLast: false });
        waypoints = this._sanitizeWaypoints(waypoints, { keepEnds: true });
        planeElement.push(diFactory.createDiEdge(flow, waypoints, { id: flow.id + '_di' }));
      });
    });

    // DataInputAssociations / DataOutputAssociations / Associations on tasks & events
    (process.flowElements || []).forEach(element => {
      const diElement = element.di && element.di.bounds ? element.di : null;
      // 1) DataInputAssociations: connect each source data object/store -> activity
      (element.dataInputAssociations || []).forEach(dia => {
        const sources = dia.sourceRef ? (Array.isArray(dia.sourceRef) ? dia.sourceRef : [dia.sourceRef]) : [];
        sources.forEach((src, idx) => {
          const sDi = src && src.di; if (!sDi || !diElement) return;
          const sB = sDi.bounds; const tB = diElement.bounds;
          let waypoints = this._dockBetween(sB, tB);
          waypoints = this._snapWaypoints(waypoints);
          waypoints = this._sanitizeWaypoints(waypoints);
          // If horizontal span crosses other shapes, re-route beneath
          const minX = Math.min(sB.x + sB.width / 2, tB.x + tB.width / 2);
          const maxX = Math.max(sB.x + sB.width / 2, tB.x + tB.width / 2);
          const potentialY = Math.max(sB.y + sB.height, tB.y + tB.height) + 40; // 40px below lower shape
          const intersects = planeElement.some(pe => pe.bounds && pe.bpmnElement && pe !== src.di && pe !== diElement && pe.bounds.x < maxX && (pe.bounds.x + pe.bounds.width) > minX && pe.bounds.y < potentialY && (pe.bounds.y + pe.bounds.height) > potentialY - 10);
          if (intersects) {
            // orthogonal path: from source edge down, across, up to target edge
            const start = { x: sB.x + sB.width / 2, y: sB.y + sB.height };
            const end = { x: tB.x + tB.width / 2, y: tB.y + tB.height };
            waypoints = [
              { x: start.x, y: start.y },
              { x: start.x, y: potentialY },
              { x: end.x, y: potentialY },
              { x: end.x, y: end.y }
            ];
          }
          // ensure unique id if multiple sources
          const edgeId = (sources.length > 1 ? dia.id + '_' + src.id : dia.id) + '_di';
          if (!planeElement.find(pe => pe.id === edgeId)) {
            planeElement.push(diFactory.createDiEdge(dia, waypoints, { id: edgeId }));
          }
        });
      });
      // 2) DataOutputAssociations: connect activity -> each target data object/store
      (element.dataOutputAssociations || []).forEach(doa => {
        const targets = doa.targetRef ? (Array.isArray(doa.targetRef) ? doa.targetRef : [doa.targetRef]) : [];
        targets.forEach((tgt, idx) => {
          const tDi = tgt && tgt.di; if (!tDi || !diElement) return;
          const sB = diElement.bounds; const tB = tDi.bounds;
          let waypoints = this._dockBetween(sB, tB);
          waypoints = this._snapWaypoints(waypoints);
          waypoints = this._sanitizeWaypoints(waypoints);
          const edgeId = (targets.length > 1 ? doa.id + '_' + tgt.id : doa.id) + '_di';
          if (!planeElement.find(pe => pe.id === edgeId)) {
            planeElement.push(diFactory.createDiEdge(doa, waypoints, { id: edgeId }));
          }
        });
      });
      // 3) Generic Associations (e.g., TextAnnotation)
      (element.association || []).forEach(assoc => {
        const sourceRefs = assoc.sourceRef ? (Array.isArray(assoc.sourceRef) ? assoc.sourceRef : [assoc.sourceRef]) : [];
        const targetRef = assoc.targetRef;
        sourceRefs.forEach(sourceRef => {
          const sourceDi = sourceRef && sourceRef.di; const targetDi = targetRef && targetRef.di;
          if (sourceDi && targetDi) {
            const sB = sourceDi.bounds; const tB = targetDi.bounds;
            let waypoints = [
              { x: sB.x + sB.width / 2, y: sB.y + sB.height / 2 },
              { x: tB.x + tB.width / 2, y: tB.y + tB.height / 2 }
            ];
            waypoints = this._snapWaypoints(waypoints);
            waypoints = this._sanitizeWaypoints(waypoints);
            const edgeId = assoc.id + '_di';
            if (!planeElement.find(pe => pe.id === edgeId)) {
              planeElement.push(diFactory.createDiEdge(assoc, waypoints, { id: edgeId }));
            }
          }
        });
      });
    });

    // Simple positioning of DataObjects & DataStores if not already positioned
    (process.flowElements || []).forEach(element => {
      if ((is(element, 'bpmn:DataObject') || is(element, 'bpmn:DataObjectReference') || is(element, 'bpmn:DataStoreReference')) && !element.di) {
        // find a related task (incoming/outgoing referencing it)
        const related = (process.flowElements || []).find(fe => (fe.dataInputAssociations || []).some(a => a.sourceRef && a.sourceRef[0] && a.sourceRef[0].id === element.id));
        let refBounds;
        if (related && related.di) {
          refBounds = related.di.bounds;
        }
        const bounds = {
          x: refBounds ? refBounds.x + refBounds.width + 30 : 50,
          y: refBounds ? refBounds.y : 50,
          width: is(element, 'bpmn:DataStoreReference') ? 50 : 36,
          height: is(element, 'bpmn:DataStoreReference') ? 50 : 50
        };
        const shapeDi = diFactory.createDiShape(element, bounds, { id: element.id + '_di' });
        element.di = shapeDi;
        planeElement.push(shapeDi);
      }
    });
  }

  handleMessageFlows(collaboration, planeElement, diFactory) {
    const messageFlows = collaboration.messageFlows || [];
    // Pre-classify sides for uniqueness distribution (similar to sequence flows)
    const mfOutgoingGroups = new Map(); // key shapeId|side -> flows
    const mfIncomingGroups = new Map();
    function classifySideMF(sourceBounds, targetBounds) {
      const gapRight = targetBounds.x - (sourceBounds.x + sourceBounds.width);
      const gapLeft = sourceBounds.x - (targetBounds.x + targetBounds.width);
      const gapDown = targetBounds.y - (sourceBounds.y + sourceBounds.height);
      const gapUp = sourceBounds.y - (targetBounds.y + targetBounds.height);
      const hClear = Math.max(gapRight, gapLeft);
      const vClear = Math.max(gapDown, gapUp);
      if (gapRight > 5) return { s: 'R', t: 'L' };
      if (gapLeft > 5) return { s: 'L', t: 'R' };
      if (gapDown > 5) return { s: 'B', t: 'T' };
      if (gapUp > 5) return { s: 'T', t: 'B' };
      if (hClear >= vClear) {
        if (sourceBounds.x + sourceBounds.width / 2 <= targetBounds.x + targetBounds.width / 2) return { s: 'R', t: 'L' };
        return { s: 'L', t: 'R' };
      }
      if (sourceBounds.y + sourceBounds.height / 2 <= targetBounds.y + targetBounds.height / 2) return { s: 'B', t: 'T' };
      return { s: 'T', t: 'B' };
    }
    messageFlows.forEach(flow => {
      const source = flow.sourceRef; const target = flow.targetRef;
      let sourceBounds = source && (source.$type === 'bpmn:Participant' ? (planeElement.find(s => s.bpmnElement === source) || {}).bounds : (source.di && source.di.bounds));
      let targetBounds = target && (target.$type === 'bpmn:Participant' ? (planeElement.find(s => s.bpmnElement === target) || {}).bounds : (target.di && target.di.bounds));
      if (!(sourceBounds && targetBounds)) return;
      const sides = classifySideMF(sourceBounds, targetBounds);
      flow.__autoLayoutSides = sides;
      const outKey = (source.id || source.businessObject && source.businessObject.id) + '|' + sides.s;
      const inKey = (target.id || target.businessObject && target.businessObject.id) + '|' + sides.t;
      if (!mfOutgoingGroups.has(outKey)) mfOutgoingGroups.set(outKey, []);
      mfOutgoingGroups.get(outKey).push(flow);
      if (!mfIncomingGroups.has(inKey)) mfIncomingGroups.set(inKey, []);
      mfIncomingGroups.get(inKey).push(flow);
    });
    // stable ordering
    for (const group of [...mfOutgoingGroups.values(), ...mfIncomingGroups.values()]) group.sort((a, b) => a.id.localeCompare(b.id));
    messageFlows.forEach(messageFlow => {
      const source = messageFlow.sourceRef;
      const target = messageFlow.targetRef;
      let waypoints = [];
      if (source && target) {
        let sourceBounds = source.$type === 'bpmn:Participant' ? (planeElement.find(s => s.bpmnElement === source) || {}).bounds : (source.di && source.di.bounds);
        let targetBounds = target.$type === 'bpmn:Participant' ? (planeElement.find(s => s.bpmnElement === target) || {}).bounds : (target.di && target.di.bounds);
        if (sourceBounds && targetBounds) {
          // Special case: Participant -> StartEvent (or CatchEvent) directly below: force clean vertical drop
          if (is(source, 'bpmn:Participant') && (is(target, 'bpmn:StartEvent') || is(target, 'bpmn:IntermediateCatchEvent'))) {
            const srcBottom = sourceBounds.y + sourceBounds.height;
            const tgtTop = targetBounds.y;
            if (tgtTop > srcBottom - 5) { // target is below
              const tgtCenterX = targetBounds.x + targetBounds.width / 2;
              let exitX = Math.min(Math.max(tgtCenterX, sourceBounds.x + 10), sourceBounds.x + sourceBounds.width - 10);
              // shift vertical line if it intersects unrelated shapes
              exitX = this._findClearVerticalX(exitX, srcBottom, tgtTop, planeElement, new Set([source, target]));
              const sourcePoint = { x: exitX, y: srcBottom };
              const targetPoint = { x: tgtCenterX, y: tgtTop };
              waypoints = [sourcePoint, targetPoint];
              // push edge and continue to next flow
              const existing = planeElement.find(pe => pe.bpmnElement === messageFlow);
              if (!existing) {
                planeElement.push(diFactory.createDiEdge(messageFlow, waypoints, { id: messageFlow.id + '_di' }));
              }
              return; // handled
            }
          }
          const srcCenterX = sourceBounds.x + sourceBounds.width / 2;
          const srcCenterY = sourceBounds.y + sourceBounds.height / 2;
          const tgtCenterX = targetBounds.x + targetBounds.width / 2;
          const tgtCenterY = targetBounds.y + targetBounds.height / 2;
          const srcRight = sourceBounds.x + sourceBounds.width;
          const srcLeft = sourceBounds.x;
          const tgtLeft = targetBounds.x;
          const tgtRight = targetBounds.x + targetBounds.width;
          const horizontalGapRight = tgtLeft - srcRight;
          const horizontalGapLeft = srcLeft - tgtRight;
          const horizontalOverlap = Math.min(srcRight, tgtRight) - Math.max(srcLeft, tgtLeft);
          const verticalGapAbs = Math.abs(srcCenterY - tgtCenterY);
          const verticalDominant = horizontalOverlap > 40 && verticalGapAbs > 60;
          // Unique anchor distribution preparation
          function adjustAnchor(point, bounds, side, flow, groups, axisCount) {
            const key = (bounds.bpmnElement ? bounds.bpmnElement.id : null); // not reliable for participant shapes, we will pass explicit keys
            // We will derive groups using precomputed maps
            if (!flow.__autoLayoutSides) return point;
            const elemId = (bounds.bpmnElement && bounds.bpmnElement.id) || (bounds.id) || null;
            if (!elemId) return point;
            const sideKey = elemId + '|' + side;
            const group = groups.get(sideKey) || [];
            if (group.length <= 1) return point;
            const idx = group.indexOf(flow);
            if (idx === -1) return point;
            const slots = group.length + 1;
            if (side === 'R' || side === 'L') {
              const newY = bounds.y + ((idx + 1) / slots) * bounds.height;
              return { x: point.x, y: newY };
            } else if (side === 'T' || side === 'B') {
              const newX = bounds.x + ((idx + 1) / slots) * bounds.width;
              return { x: newX, y: point.y };
            }
            return point;
          }
          if (verticalDominant) {
            const downwards = srcCenterY < tgtCenterY;
            // exit from bottom (or top) of source; if source is a Participant and target lies horizontally inside it,
            // align exit X with target to produce a straight vertical drop (improves readability for participant -> startEvent/messageEvent).
            let exitX = srcCenterX;
            if (is(source, 'bpmn:Participant')) {
              const targetCenterWithin = (tgtCenterX >= sourceBounds.x + 10) && (tgtCenterX <= sourceBounds.x + sourceBounds.width - 10);
              if (targetCenterWithin) {
                exitX = tgtCenterX; // align vertical segment with target center
              }
            }
            // adjust exitX to avoid intersecting intermediate shapes along vertical path
            const vStartY = downwards ? sourceBounds.y + sourceBounds.height : targetBounds.y + targetBounds.height;
            const vEndY = downwards ? targetBounds.y : sourceBounds.y;
            exitX = this._findClearVerticalX(exitX, Math.min(vStartY, vEndY), Math.max(vStartY, vEndY), planeElement, new Set([source, target]));
            let sourcePoint = downwards ? { x: exitX, y: sourceBounds.y + sourceBounds.height } : { x: exitX, y: sourceBounds.y };
            let targetPoint = downwards ? { x: tgtCenterX, y: targetBounds.y } : { x: tgtCenterX, y: targetBounds.y + targetBounds.height };
            // Apply unique distribution along top/bottom if multiple flows share the side
            if (messageFlow.__autoLayoutSides) {
              const { s: sSide, t: tSide } = messageFlow.__autoLayoutSides;
              // Only adjust the axis relevant to side
              sourcePoint = adjustAnchor(sourcePoint, sourceBounds, sSide, messageFlow, mfOutgoingGroups);
              targetPoint = adjustAnchor(targetPoint, targetBounds, tSide, messageFlow, mfIncomingGroups);
            }
            const xDelta = Math.abs(sourcePoint.x - targetPoint.x);
            if (xDelta <= 10) {
              // perfectly aligned --> single vertical segment
              waypoints = [sourcePoint, targetPoint];
            } else if (xDelta <= 120) {
              // small horizontal offset near target -> T shape
              const approachY = downwards ? targetPoint.y - 30 : targetPoint.y + 30;
              waypoints = [sourcePoint, { x: sourcePoint.x, y: approachY }, { x: targetPoint.x, y: approachY }, targetPoint];
            } else {
              // large separation -> two-step with mid vertical corridor aligned to target X
              const midY = (sourcePoint.y + targetPoint.y) / 2;
              waypoints = [sourcePoint, { x: sourcePoint.x, y: midY }, { x: targetPoint.x, y: midY }, targetPoint];
            }
          } else {
            let leftToRight = true; if (horizontalGapLeft > 40) leftToRight = false;
            let sourcePoint = leftToRight ? { x: srcRight, y: srcCenterY } : { x: srcLeft, y: srcCenterY };
            let targetPoint = leftToRight ? { x: tgtLeft, y: tgtCenterY } : { x: tgtRight, y: tgtCenterY };
            if (messageFlow.__autoLayoutSides) {
              const { s: sSide, t: tSide } = messageFlow.__autoLayoutSides;
              sourcePoint = adjustAnchor(sourcePoint, sourceBounds, sSide, messageFlow, mfOutgoingGroups);
              targetPoint = adjustAnchor(targetPoint, targetBounds, tSide, messageFlow, mfIncomingGroups);
            }
            if ((leftToRight && horizontalGapRight > 40 || !leftToRight && horizontalGapLeft > 40) && Math.abs(srcCenterY - tgtCenterY) < 30) {
              waypoints = [sourcePoint, targetPoint];
            } else {
              const offset = 20;
              const firstLegEnd = leftToRight ? { x: sourcePoint.x + offset, y: sourcePoint.y } : { x: sourcePoint.x - offset, y: sourcePoint.y };
              let bendX = (sourcePoint.x + targetPoint.x) / 2;
              if (leftToRight && bendX - firstLegEnd.x < 40) bendX = firstLegEnd.x + 40;
              if (!leftToRight && firstLegEnd.x - bendX < 40) bendX = firstLegEnd.x - 40;
              const verticalTargetY = targetPoint.y;
              waypoints = [sourcePoint, firstLegEnd, { x: bendX, y: firstLegEnd.y }, { x: bendX, y: verticalTargetY }, targetPoint];
            }
          }
        }
      }
      if (!waypoints.length) waypoints = [{ x: 500, y: 100 }, { x: 500, y: 300 }];
      waypoints = this._snapWaypoints(waypoints);
      const existing = planeElement.find(pe => pe.bpmnElement === messageFlow);
      if (!existing) {
        // orthogonalize message flow segments
        if (waypoints.length > 1) {
          const ortho = [waypoints[0]];
          for (let i = 1; i < waypoints.length; i++) {
            const prev = ortho[ortho.length - 1];
            const cur = waypoints[i];
            if (prev.x !== cur.x && prev.y !== cur.y) {
              ortho.push({ x: cur.x, y: prev.y });
            }
            ortho.push(cur);
          }
          waypoints = ortho;
        }
        waypoints = this._sanitizeWaypoints(waypoints);
        planeElement.push(diFactory.createDiEdge(messageFlow, waypoints, { id: messageFlow.id + '_di' }));
      }
    });
  }

  _dockBetween(a, b) {
    // Compute docking points on rectangle edges pointing toward the other rectangle center
    const aCenter = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const bCenter = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    // vector from a to b
    const vx = bCenter.x - aCenter.x;
    const vy = bCenter.y - aCenter.y;
    function edgePoint(rect, towardX, towardY) {
      // parametric intersection with rectangle bounds
      const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      if (Math.abs(towardX - cx) < 1e-6 && Math.abs(towardY - cy) < 1e-6) return { x: cx, y: cy };
      const dx = towardX - cx, dy = towardY - cy;
      const candidates = [];
      if (dx !== 0) {
        const t1 = (rect.width / 2) / Math.abs(dx);
        candidates.push({ t: t1, x: cx + Math.sign(dx) * rect.width / 2, y: cy + dy * t1 });
      }
      if (dy !== 0) {
        const t2 = (rect.height / 2) / Math.abs(dy);
        candidates.push({ t: t2, x: cx + dx * t2, y: cy + Math.sign(dy) * rect.height / 2 });
      }
      // choose smallest positive t that lies on edge
      candidates.sort((a, b) => a.t - b.t);
      for (const c of candidates) {
        if (c.x >= rect.x - 0.5 && c.x <= rect.x + rect.width + 0.5 && c.y >= rect.y - 0.5 && c.y <= rect.y + rect.height + 0.5) {
          return { x: c.x, y: c.y };
        }
      }
      return { x: cx, y: cy }; // fallback
    }
    const start = edgePoint(a, bCenter.x, bCenter.y);
    const end = edgePoint(b, aCenter.x, aCenter.y);
    return [start, end];
  }

  _findClearVerticalX(x, yTop, yBottom, planeElement, ignoreSet) {
    const shapes = planeElement.filter(pe => pe.bounds && pe.bpmnElement && !ignoreSet.has(pe.bpmnElement));
    const collides = (cx) => shapes.some(s => {
      const b = s.bounds; if (!b) return false;
      const overlapY = !(b.y > yBottom || (b.y + b.height) < yTop);
      const withinX = cx >= b.x - 1 && cx <= b.x + b.width + 1;
      return overlapY && withinX;
    });
    if (!collides(x)) return x;
    const maxShift = 80; const step = 12;
    for (let delta = step; delta <= maxShift; delta += step) {
      if (!collides(x + delta)) return x + delta;
      if (!collides(x - delta)) return x - delta;
    }
    return x;
  }
}
