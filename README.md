# BPMN Smart Auto Layout (Enhanced)

Automated generation of BPMN DI (shapes + edges) with advanced, collaboration‑wide layout:

* Full collaboration (all participants + lanes) – not just the first process
* Orthogonal (Manhattan) sequence & message flow routing (no diagonal "steep" segments)
* Unique entry / exit anchor distribution per side (prevents stacked arrows)
* Intelligent gateway fan‑out: precise diamond edge intersection + orthogonal stubs
* Lane‑aware text annotation placement + association DI
* Data objects & stores positioned and linked via data associations
* Sub‑process (incl. nested & parallel gateway) layout
* Under‑route strategy for certain right→left crossings to reduce clutter


## Table of Contents

1. Installation
2. Quick Start (API)
3. Feature Highlights (Enhancements)
4. Example & Demo Script
5. Build & Run Scripts
6. Testing & Snapshots
7. Configuration / Extension Ideas
8. Limitations
9. Changelog Summary
10. Migration (Original → Enhanced)
11. License

## 1. Installation

```bash
npm install bpmn-smart-auto-layout
```

Requires Node.js >= 18.

## 2. Quick Start (API)

```javascript
import { layoutProcess } from 'bpmn-smart-auto-layout';
import diagramXML from './diagram.bpmn';

const outputXml = await layoutProcess(diagramXML);
console.log(outputXml);
```

The returned XML has full BPMN DI (BPMNDiagram, BPMNPlane, BPMNShape, BPMNEdge) for all laid out elements.

### Minimal Script

```javascript
import { readFileSync, writeFileSync } from 'node:fs';
import { layoutProcess } from 'bpmn-smart-auto-layout';

const src = readFileSync('input.bpmn', 'utf8');
const out = await layoutProcess(src);
writeFileSync('output.layout.bpmn', out);
```

## 3. Feature Highlights (Enhancements Over Original)

| # | Feature | Description |
|---|---------|-------------|
| 1 | Collaboration-wide | Layout every participant & its process, vertically stacked pools. |
| 2 | Lane handling | Elements kept within lane bands. |
| 3 | Orthogonal routing | Sequence & message flows are straight or 90° bends only. |
| 4 | Gateway fan-out | Diamond border intersection + grouped outward stubs. |
| 5 | Unique anchors | Even distribution along shape sides (no arrow pile‑ups). |
| 6 | Vertical docking | Chooses top/bottom edges when tasks stack vertically. |
| 7 | Under‑routing | Right→left multi‑incoming scenarios route below to avoid overlaps. |
| 8 | Text annotations | Lane/pool aware placement + association edges. |
| 9 | Data associations | Side docking + avoidance re‑routes beneath obstacles. |
| 10 | Message flows | Vertical drop, T, or corridor strategies + uniqueness distribution. |
| 11 | Sub‑process support | Includes nested & parallel gateway content layout. |

## 4. Example & Demo Script

The repo includes `test-complex-enhanced.js` demonstrating a complex collaboration (participants, lanes, subprocesses, data objects, message flows). Run it:

```bash
node test-complex-enhanced.js
```

Outputs: `example_complex/output_complex_enhanced.bpmn` plus summary metrics.

## 5. Build & Run Scripts

```bash
# install dependencies
npm install

# lint + test (build included via pretest)
npm run all

# build distribution (rollup)
npm run build

# run browser example (workspace example)
npm start
```

## 6. Configuration / Extension Ideas

| Aspect | Current | Possible Extension |
|--------|---------|--------------------|
| Spacing & offsets | Fixed heuristics (stubLen=10, spread=14, vertical gaps) | External config / adaptive spacing |
| Under‑routing | Limited right→left heuristic | General congestion / crossing minimizer |
| Annotation placement | Lane inference only | Collision avoidance + smart offsets |
| Anchor distribution | Even proportional split | Minimum distance + overflow handling |
| Path optimization | First-valid orthogonal bends | Shortest-path Manhattan refinement |

## 7. Limitations

* BPMN Groups still not laid out.
* No curved connectors; Manhattan only.
* Collision avoidance between edges beyond anchors is minimal.
* Lane width auto-expansion and advanced crowding resolution not yet implemented.

## 8. Changelog Summary (Major Additions)

* Multi‑participant & lane layout
* Orthogonal routing (sequence, message, data, associations)
* Gateway diamond-edge intersection + side-grouped fan‑out
* Unique per-side anchor distribution
* Text annotation placement + association edges
* Data object/store positioning and associations
* Message flow vertical / T / corridor strategies
* Under‑route path for select reverse flows
* Sub‑process (including nested & parallel) layout

## 9. Migration (Original → Enhanced)

| Original Limitation | Enhanced Behavior |
|---------------------|-------------------|
| Only first participant laid out | All participants & processes handled |
| No message flows DI | Full message flow routing & DI |
| No annotations / associations | Lane-aware placement + association edges |
| No data object / store DI | Positioned + connected via associations |
| Diagonal sequence flow segments | Orthogonal (90°) only |
| Gateway exits overlapped | Distributed stubs at diamond boundary |
"# bpmn-auto-layout" 
# bpmn-auto-layout
