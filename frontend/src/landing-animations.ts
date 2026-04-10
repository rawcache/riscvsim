const NS = "http://www.w3.org/2000/svg";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

type SvgAttrs = Record<string, number | string>;
type MotionDemoType = "stack" | "pipeline" | "branch";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smooth(current: number, target: number, rate: number): number {
  const delta = target - current;
  if (Math.abs(delta) < 0.0005) {
    return target;
  }
  return current + delta * rate;
}

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: SvgAttrs = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  setAttrs(node, attrs);
  return node;
}

function setAttrs(node: Element, attrs: Record<string, number | string | undefined>): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) {
      node.removeAttribute(key);
      continue;
    }
    node.setAttribute(key, String(value));
  }
}

function setPaint(
  node: SVGElement,
  options: {
    fill?: string;
    fillOpacity?: number;
    stroke?: string;
    strokeOpacity?: number;
    strokeWidth?: number;
    opacity?: number;
    filter?: string;
  }
): void {
  const {
    fill,
    fillOpacity,
    stroke,
    strokeOpacity,
    strokeWidth,
    opacity,
    filter,
  } = options;

  if (fill) {
    node.setAttribute("fill", fill);
  } else {
    node.setAttribute("fill", "none");
  }
  if (fillOpacity !== undefined) {
    node.setAttribute("fill-opacity", fillOpacity.toFixed(3));
  } else {
    node.removeAttribute("fill-opacity");
  }
  if (stroke) {
    node.setAttribute("stroke", stroke);
  } else {
    node.setAttribute("stroke", "none");
  }
  if (strokeOpacity !== undefined) {
    node.setAttribute("stroke-opacity", strokeOpacity.toFixed(3));
  } else {
    node.removeAttribute("stroke-opacity");
  }
  if (strokeWidth !== undefined) {
    node.setAttribute("stroke-width", strokeWidth.toFixed(2));
  } else {
    node.removeAttribute("stroke-width");
  }
  if (opacity !== undefined) {
    node.setAttribute("opacity", opacity.toFixed(3));
  } else {
    node.removeAttribute("opacity");
  }
  if (filter) {
    node.setAttribute("filter", filter);
  } else {
    node.removeAttribute("filter");
  }
}

function pointString(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

function addGlowFilter(defs: SVGDefsElement, id: string, stdDeviation: number): void {
  const filter = svgNode("filter", {
    id,
    x: "-80%",
    y: "-80%",
    width: "260%",
    height: "260%",
  });
  const blur = svgNode("feGaussianBlur", {
    in: "SourceGraphic",
    stdDeviation,
    result: "blur",
  });
  const merge = svgNode("feMerge");
  merge.append(svgNode("feMergeNode", { in: "blur" }), svgNode("feMergeNode", { in: "SourceGraphic" }));
  filter.append(blur, merge);
  defs.appendChild(filter);
}

abstract class MotionDemo {
  protected readonly svg: SVGSVGElement;
  protected readonly defs: SVGDefsElement;
  protected readonly reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;
  protected readonly canHover = window.matchMedia(HOVER_QUERY).matches;

  private rafId = 0;
  private lastTs = 0;
  private visible = false;

  constructor(
    readonly container: HTMLElement,
    viewBox: string,
    label: string
  ) {
    this.svg = svgNode("svg", {
      viewBox,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": label,
    });
    this.svg.style.setProperty("font-family", "var(--font-mono)");
    this.defs = svgNode("defs");
    this.svg.appendChild(this.defs);
    this.container.appendChild(this.svg);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.reducedMotion) {
      this.renderReducedMotion();
      return;
    }
    if (visible) {
      this.start();
      return;
    }
    this.stop();
  }

  protected start(): void {
    if (this.rafId !== 0) {
      return;
    }
    this.lastTs = 0;
    this.rafId = window.requestAnimationFrame(this.frame);
  }

  protected stop(): void {
    if (this.rafId !== 0) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.lastTs = 0;
  }

  protected get isVisible(): boolean {
    return this.visible;
  }

  private readonly frame = (ts: number) => {
    if (!this.visible) {
      this.rafId = 0;
      return;
    }
    const dt = this.lastTs === 0 ? 16 : Math.min(ts - this.lastTs, 48);
    this.lastTs = ts;
    this.tick(ts, dt);
    this.rafId = window.requestAnimationFrame(this.frame);
  };

  protected abstract tick(ts: number, dt: number): void;
  protected abstract renderReducedMotion(): void;
}

class StackPeelDemo extends MotionDemo {
  private static readonly COUNT = 11;
  private static readonly WIDTH = 148;
  private static readonly HEIGHT = 14;
  private static readonly SKEW_X = 34;
  private static readonly SKEW_Y = -16;
  private static readonly PITCH = 14;
  private static readonly AX = 74;
  private static readonly AY = 220;

  private readonly slabLayer = svgNode("g");
  private readonly hitLayer = svgNode("g");
  private readonly slabs: Array<{
    group: SVGGElement;
    front: SVGPolygonElement;
    right: SVGPolygonElement;
    top: SVGPolygonElement;
    hit: SVGPolygonElement;
  }> = [];
  private readonly progress = new Float32Array(StackPeelDemo.COUNT);
  private activeIndex: number | null = null;
  private autoIndex = 0;
  private autoElapsed = 0;

  constructor(container: HTMLElement) {
    super(container, "0 0 360 260", "Stack frame peel animation");

    addGlowFilter(this.defs, "stack-glow", 4);
    this.svg.append(this.slabLayer, this.hitLayer);

    for (let index = 0; index < StackPeelDemo.COUNT; index += 1) {
      const group = svgNode("g");
      const front = svgNode("polygon");
      const right = svgNode("polygon");
      const top = svgNode("polygon");
      group.append(front, right, top);
      this.slabLayer.appendChild(group);

      const hit = svgNode("polygon", {
        fill: "transparent",
        stroke: "none",
      });
      hit.style.cursor = "pointer";
      this.hitLayer.appendChild(hit);

      if (this.canHover) {
        hit.addEventListener("pointerenter", () => {
          this.activeIndex = index;
          this.autoElapsed = 0;
        });
      }

      this.slabs.push({ group, front, right, top, hit });
    }

    if (this.canHover) {
      this.svg.addEventListener("pointerleave", () => {
        this.activeIndex = null;
      });
    }

    this.renderIdle();
  }

  protected tick(_ts: number, dt: number): void {
    if (this.activeIndex === null) {
      this.autoElapsed += dt;
      if (this.autoElapsed >= 620) {
        this.autoElapsed = 0;
        this.autoIndex = (this.autoIndex + 1) % StackPeelDemo.COUNT;
      }
    }

    const focusIndex = this.activeIndex ?? this.autoIndex;

    for (let index = 0; index < StackPeelDemo.COUNT; index += 1) {
      const target = index === focusIndex ? 1 : 0;
      this.progress[index] = smooth(this.progress[index], target, 0.12);
      this.positionSlab(index, this.progress[index]);
      this.styleSlab(index, this.progress[index]);
    }

    this.reorder(focusIndex);
  }

  protected renderReducedMotion(): void {
    for (let index = 0; index < StackPeelDemo.COUNT; index += 1) {
      const amount = (index / (StackPeelDemo.COUNT - 1)) * 0.24;
      this.progress[index] = amount;
      this.positionSlab(index, amount);
      this.styleSlab(index, amount * 0.9);
    }
    this.reorder(null);
  }

  private renderIdle(): void {
    for (let index = 0; index < StackPeelDemo.COUNT; index += 1) {
      this.progress[index] = 0;
      this.positionSlab(index, 0);
      this.styleSlab(index, 0);
    }
    this.reorder(null);
  }

  private reorder(focusIndex: number | null): void {
    for (let index = 0; index < StackPeelDemo.COUNT; index += 1) {
      if (index !== focusIndex) {
        this.slabLayer.appendChild(this.slabs[index].group);
      }
    }
    if (focusIndex !== null) {
      this.slabLayer.appendChild(this.slabs[focusIndex].group);
    }
  }

  private fanOffset(index: number): { dx: number; dy: number } {
    const t = index / (StackPeelDemo.COUNT - 1);
    return {
      dx: t * t * 164,
      dy: 0,
    };
  }

  private geometry(originX: number, originY: number): {
    front: Array<[number, number]>;
    right: Array<[number, number]>;
    top: Array<[number, number]>;
  } {
    const { WIDTH, HEIGHT, SKEW_X, SKEW_Y } = StackPeelDemo;
    const a: [number, number] = [originX, originY];
    const b: [number, number] = [originX + WIDTH, originY];
    const b1: [number, number] = [originX + WIDTH, originY - HEIGHT];
    const a1: [number, number] = [originX, originY - HEIGHT];
    const c1: [number, number] = [b1[0] + SKEW_X, b1[1] + SKEW_Y];
    const d1: [number, number] = [a1[0] + SKEW_X, a1[1] + SKEW_Y];
    const c: [number, number] = [b[0] + SKEW_X, b[1] + SKEW_Y];

    return {
      front: [a, b, b1, a1],
      right: [b, c, c1, b1],
      top: [a1, b1, c1, d1],
    };
  }

  private positionSlab(index: number, amount: number): void {
    const baseX = StackPeelDemo.AX;
    const baseY = StackPeelDemo.AY - index * StackPeelDemo.PITCH;
    const offset = this.fanOffset(index);
    const geo = this.geometry(baseX + offset.dx * amount, baseY + offset.dy * amount);
    const rest = this.geometry(baseX, baseY);
    const slab = this.slabs[index];

    slab.front.setAttribute("points", pointString(geo.front));
    slab.right.setAttribute("points", pointString(geo.right));
    slab.top.setAttribute("points", pointString(geo.top));
    slab.hit.setAttribute("points", pointString(rest.top));
  }

  private styleSlab(index: number, amount: number): void {
    const slab = this.slabs[index];
    const depth = index / (StackPeelDemo.COUNT - 1);
    const active = amount > 0.02;

    if (active) {
      setPaint(slab.top, {
        fill: "var(--accent)",
        fillOpacity: 0.08 + amount * 0.07,
        stroke: "var(--text-primary)",
        strokeOpacity: 0.34 + amount * 0.42,
        strokeWidth: 1.3 + amount * 0.8,
        filter: "url(#stack-glow)",
      });
      setPaint(slab.front, {
        fill: "var(--accent)",
        fillOpacity: 0.14 + amount * 0.1,
        stroke: "var(--text-primary)",
        strokeOpacity: 0.24 + amount * 0.24,
        strokeWidth: 1.1 + amount * 0.6,
      });
      setPaint(slab.right, {
        fill: "var(--accent)",
        fillOpacity: 0.1 + amount * 0.08,
        stroke: "var(--accent)",
        strokeOpacity: 0.28 + amount * 0.24,
        strokeWidth: 1 + amount * 0.4,
      });
      slab.group.setAttribute("opacity", (0.72 + amount * 0.28).toFixed(3));
      return;
    }

    setPaint(slab.top, {
      fill: "var(--accent)",
      fillOpacity: 0.02 + depth * 0.04,
      stroke: "var(--text-secondary)",
      strokeOpacity: 0.14 + depth * 0.16,
      strokeWidth: 1.1,
    });
    setPaint(slab.front, {
      fill: "var(--accent)",
      fillOpacity: 0.04 + depth * 0.05,
      stroke: "var(--text-secondary)",
      strokeOpacity: 0.12 + depth * 0.16,
      strokeWidth: 1,
    });
    setPaint(slab.right, {
      fill: "var(--text-secondary)",
      fillOpacity: 0.04 + depth * 0.04,
      stroke: "var(--text-muted)",
      strokeOpacity: 0.1 + depth * 0.1,
      strokeWidth: 0.9,
    });
    slab.group.setAttribute("opacity", (0.34 + depth * 0.54).toFixed(3));
  }
}

class PipelineDemo extends MotionDemo {
  private static readonly LABELS = ["IF", "ID", "EX", "MEM", "WB"];
  private static readonly STAGES = 5;
  private static readonly STAGE_W = 48;
  private static readonly STAGE_H = 22;
  private static readonly SKEW_X = 16;
  private static readonly SKEW_Y = -10;
  private static readonly OX = 52;
  private static readonly OY = 148;
  private static readonly TOTAL_W = PipelineDemo.STAGES * PipelineDemo.STAGE_W;
  private static readonly LABEL_LIFT = 18;

  private readonly slabLayer = svgNode("g");
  private readonly connectorLayer = svgNode("g");
  private readonly labelLayer = svgNode("g");
  private readonly arrowLayer = svgNode("g");
  private readonly slabs: Array<{
    front: SVGPolygonElement;
    right: SVGPolygonElement;
    top: SVGPolygonElement;
  }> = [];
  private readonly labels: Array<{
    glow: SVGRectElement;
    pill: SVGRectElement;
    text: SVGTextElement;
    baseY: number;
  }> = [];
  private readonly levels = new Float32Array(PipelineDemo.STAGES);
  private readonly lifts = new Float32Array(PipelineDemo.STAGES);
  private readonly trail = svgNode("line", {
    "stroke-linecap": "round",
  });
  private readonly arrowGlow = svgNode("rect", {
    width: 20,
    height: 10,
    rx: 3,
  });
  private readonly arrowHead = svgNode("path", {
    d: "M -5,-4 L 5,0 L -5,4 Z",
    "stroke-linejoin": "round",
  });
  private readonly tipDot = svgNode("circle", { r: 1.8 });

  private hovering = false;
  private pointerProgress = 0;
  private progress = 0;
  private autoClock = 0;

  constructor(container: HTMLElement) {
    super(container, "0 0 360 210", "Pipeline flow animation");

    addGlowFilter(this.defs, "pipeline-glow", 4);
    addGlowFilter(this.defs, "pipeline-arrow-glow", 6);
    addGlowFilter(this.defs, "pipeline-label-glow", 6);

    this.svg.append(this.slabLayer, this.connectorLayer, this.labelLayer, this.arrowLayer);

    for (let index = 0; index < PipelineDemo.STAGES; index += 1) {
      const front = svgNode("polygon");
      const right = svgNode("polygon");
      const top = svgNode("polygon");
      this.slabLayer.append(front, right, top);
      this.slabs.push({ front, right, top });

      const geometry = this.geometry(index);
      const glow = svgNode("rect", {
        x: geometry.tcx - 18,
        y: geometry.tcy - 8,
        width: 36,
        height: 16,
        rx: 4,
      });
      const pill = svgNode("rect", {
        x: geometry.tcx - 16,
        y: geometry.tcy - 7,
        width: 32,
        height: 14,
        rx: 4,
      });
      const text = svgNode("text", {
        x: geometry.tcx,
        y: geometry.tcy,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "font-size": 8.6,
        "font-weight": 700,
        "letter-spacing": "0.12em",
      });
      text.textContent = PipelineDemo.LABELS[index];
      this.labelLayer.append(glow, pill, text);
      this.labels.push({ glow, pill, text, baseY: geometry.tcy });
    }

    for (let index = 0; index < PipelineDemo.STAGES - 1; index += 1) {
      const geometry = this.geometry(index);
      const chevron = svgNode("path", {
        d: `M ${geometry.leftX + PipelineDemo.STAGE_W - 2},${PipelineDemo.OY - PipelineDemo.STAGE_H / 2 - 3} L ${
          geometry.leftX + PipelineDemo.STAGE_W + 4
        },${PipelineDemo.OY - PipelineDemo.STAGE_H / 2} L ${geometry.leftX + PipelineDemo.STAGE_W - 2},${
          PipelineDemo.OY - PipelineDemo.STAGE_H / 2 + 3
        }`,
        fill: "none",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
        "stroke-width": 1,
      });
      this.connectorLayer.appendChild(chevron);
    }

    this.arrowLayer.append(this.trail, this.arrowGlow, this.arrowHead, this.tipDot);
    this.arrowLayer.style.opacity = "0";

    if (this.canHover) {
      this.container.addEventListener("pointerenter", (event) => {
        this.hovering = true;
        this.pointerProgress = this.xToProgress(event);
      });
      this.container.addEventListener("pointermove", (event) => {
        if (!this.hovering) {
          return;
        }
        this.pointerProgress = this.xToProgress(event);
      });
      this.container.addEventListener("pointerleave", () => {
        this.hovering = false;
      });
    }

    this.positionAll();
    this.applyStyles();
  }

  protected tick(_ts: number, dt: number): void {
    this.autoClock = (this.autoClock + dt) % 3400;
    const autoProgress =
      this.autoClock < 2200
        ? this.autoClock / 2200
        : 1 - (this.autoClock - 2200) / 1200;
    const targetProgress = this.hovering ? this.pointerProgress : autoProgress;
    this.progress = smooth(this.progress, targetProgress, this.hovering ? 0.18 : 0.08);

    for (let index = 0; index < PipelineDemo.STAGES; index += 1) {
      const stageStart = index / PipelineDemo.STAGES;
      const stageEnd = (index + 1) / PipelineDemo.STAGES;
      const target =
        this.progress >= stageEnd
          ? 1
          : this.progress > stageStart
            ? (this.progress - stageStart) * PipelineDemo.STAGES
            : 0;
      this.levels[index] = smooth(this.levels[index], target, 0.16);
      this.lifts[index] = smooth(this.lifts[index], target * PipelineDemo.LABEL_LIFT, 0.14);
    }

    this.applyStyles();
    this.positionArrow(this.progress);
  }

  protected renderReducedMotion(): void {
    this.progress = 0.66;
    for (let index = 0; index < PipelineDemo.STAGES; index += 1) {
      this.levels[index] = this.progress >= (index + 1) / PipelineDemo.STAGES ? 1 : 0.72;
      this.lifts[index] = this.levels[index] * PipelineDemo.LABEL_LIFT;
    }
    this.positionAll();
    this.applyStyles();
    this.positionArrow(this.progress);
  }

  private xToProgress(event: PointerEvent): number {
    const rect = this.container.getBoundingClientRect();
    const relativeX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    return relativeX;
  }

  private geometry(index: number): {
    front: Array<[number, number]>;
    right: Array<[number, number]>;
    top: Array<[number, number]>;
    tcx: number;
    tcy: number;
    leftX: number;
  } {
    const leftX = PipelineDemo.OX + index * PipelineDemo.STAGE_W;
    const a: [number, number] = [leftX, PipelineDemo.OY];
    const b: [number, number] = [leftX + PipelineDemo.STAGE_W, PipelineDemo.OY];
    const b1: [number, number] = [leftX + PipelineDemo.STAGE_W, PipelineDemo.OY - PipelineDemo.STAGE_H];
    const a1: [number, number] = [leftX, PipelineDemo.OY - PipelineDemo.STAGE_H];
    const c1: [number, number] = [b1[0] + PipelineDemo.SKEW_X, b1[1] + PipelineDemo.SKEW_Y];
    const d1: [number, number] = [a1[0] + PipelineDemo.SKEW_X, a1[1] + PipelineDemo.SKEW_Y];
    const c: [number, number] = [b[0] + PipelineDemo.SKEW_X, b[1] + PipelineDemo.SKEW_Y];
    return {
      front: [a, b, b1, a1],
      right: [b, c, c1, b1],
      top: [a1, b1, c1, d1],
      tcx: leftX + PipelineDemo.STAGE_W / 2 + PipelineDemo.SKEW_X / 2,
      tcy: PipelineDemo.OY - PipelineDemo.STAGE_H + PipelineDemo.SKEW_Y / 2,
      leftX,
    };
  }

  private positionAll(): void {
    for (let index = 0; index < PipelineDemo.STAGES; index += 1) {
      const geo = this.geometry(index);
      const slab = this.slabs[index];
      slab.front.setAttribute("points", pointString(geo.front));
      slab.right.setAttribute("points", pointString(geo.right));
      slab.top.setAttribute("points", pointString(geo.top));
    }
  }

  private applyStyles(): void {
    for (let index = 0; index < PipelineDemo.STAGES; index += 1) {
      const level = this.levels[index];
      const slab = this.slabs[index];
      const depth = 1 - index / (PipelineDemo.STAGES - 1) * 0.72;

      if (level > 0.01) {
        setPaint(slab.top, {
          fill: "var(--accent)",
          fillOpacity: 0.05 + level * 0.08,
          stroke: "var(--text-primary)",
          strokeOpacity: 0.28 + level * 0.42,
          strokeWidth: 1.2 + level * 0.6,
          filter: "url(#pipeline-glow)",
        });
        setPaint(slab.front, {
          fill: "var(--accent)",
          fillOpacity: 0.1 + level * 0.12,
          stroke: "var(--text-primary)",
          strokeOpacity: 0.18 + level * 0.26,
          strokeWidth: 1 + level * 0.4,
        });
        setPaint(slab.right, {
          fill: "var(--accent)",
          fillOpacity: 0.08 + level * 0.08,
          stroke: "var(--accent)",
          strokeOpacity: 0.24 + level * 0.24,
          strokeWidth: 0.9 + level * 0.3,
        });
      } else {
        setPaint(slab.top, {
          fill: "var(--accent)",
          fillOpacity: 0.02 + depth * 0.04,
          stroke: "var(--text-secondary)",
          strokeOpacity: 0.12 + depth * 0.26,
          strokeWidth: 1.05,
        });
        setPaint(slab.front, {
          fill: "var(--accent)",
          fillOpacity: 0.03 + depth * 0.05,
          stroke: "var(--text-secondary)",
          strokeOpacity: 0.1 + depth * 0.18,
          strokeWidth: 0.95,
        });
        setPaint(slab.right, {
          fill: "var(--text-secondary)",
          fillOpacity: 0.03 + depth * 0.04,
          stroke: "var(--text-muted)",
          strokeOpacity: 0.08 + depth * 0.14,
          strokeWidth: 0.9,
        });
      }

      const label = this.labels[index];
      const geo = this.geometry(index);
      const liftedY = label.baseY - this.lifts[index];
      label.glow.setAttribute("y", (liftedY - 8).toFixed(2));
      label.pill.setAttribute("y", (liftedY - 7).toFixed(2));
      label.text.setAttribute("y", liftedY.toFixed(2));

      setPaint(label.glow, {
        fill: "var(--accent)",
        fillOpacity: level * 0.2,
        filter: "url(#pipeline-label-glow)",
      });
      setPaint(label.pill, {
        fill: "var(--accent)",
        fillOpacity: level * 0.34,
        stroke: "var(--text-primary)",
        strokeOpacity: level * 0.44,
        strokeWidth: 0.9,
      });
      setPaint(label.text, {
        fill: "var(--text-primary)",
        fillOpacity: 0.18 + level * 0.72,
      });

      const connector = this.connectorLayer.children.item(index);
      if (connector instanceof SVGPathElement) {
        setPaint(connector, {
          stroke: "var(--border)",
          strokeOpacity: 0.34,
          strokeWidth: 1,
        });
      }

      slab.front.setAttribute("transform", "");
      slab.right.setAttribute("transform", "");
      slab.top.setAttribute("transform", "");
      label.text.setAttribute("x", geo.tcx.toFixed(2));
    }
  }

  private positionArrow(progress: number): void {
    const span = PipelineDemo.TOTAL_W + PipelineDemo.SKEW_X;
    const x = PipelineDemo.OX + progress * span;
    const y = PipelineDemo.OY - PipelineDemo.STAGE_H + (progress * PipelineDemo.SKEW_Y);
    const startProgress = clamp(progress - 0.22, 0, 1);
    const startX = PipelineDemo.OX + startProgress * span;
    const startY = PipelineDemo.OY - PipelineDemo.STAGE_H + (startProgress * PipelineDemo.SKEW_Y);
    const fade = clamp(progress * 8, 0, 1) * clamp((1 - progress) * 6, 0, 1);

    setPaint(this.trail, {
      stroke: "var(--accent)",
      strokeOpacity: 0.12 + fade * 0.18,
      strokeWidth: 2,
    });
    setAttrs(this.trail, {
      x1: startX.toFixed(2),
      y1: startY.toFixed(2),
      x2: (x - 6).toFixed(2),
      y2: y.toFixed(2),
    });

    setPaint(this.arrowGlow, {
      fill: "var(--accent)",
      fillOpacity: 0.16 + fade * 0.18,
      filter: "url(#pipeline-arrow-glow)",
    });
    setAttrs(this.arrowGlow, {
      x: (x - 16).toFixed(2),
      y: (y - 5).toFixed(2),
    });

    setPaint(this.arrowHead, {
      fill: "var(--text-primary)",
      fillOpacity: 0.42 + fade * 0.5,
      stroke: "var(--text-primary)",
      strokeOpacity: 0.28 + fade * 0.32,
      strokeWidth: 0.5,
    });
    this.arrowHead.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);

    setPaint(this.tipDot, {
      fill: "var(--text-primary)",
      fillOpacity: 0.56 + fade * 0.36,
    });
    setAttrs(this.tipDot, {
      cx: (x + 5).toFixed(2),
      cy: y.toFixed(2),
    });

    this.arrowLayer.style.opacity = fade > 0.01 ? "1" : "0";
  }
}

class BranchPredictionDemo extends MotionDemo {
  private static readonly LEVELS = 4;
  private static readonly WIDTH = 360;
  private static readonly ROOT_Y = 26;
  private static readonly LEAF_Y = 224;

  private readonly faintLayer = svgNode("g");
  private readonly haloLayer = svgNode("g");
  private readonly brightLayer = svgNode("g");
  private readonly dotLayer = svgNode("g");

  private readonly nodes: Array<Array<{ x: number; y: number }>> = [];
  private readonly edges: Array<Array<{ length: number; index: number }>> = [];
  private readonly pathEls: Array<
    Array<{
      faint: SVGPathElement;
      bright: SVGPathElement;
      halo: SVGPathElement;
      length: number;
    }>
  > = [];
  private readonly dots: SVGCircleElement[][] = [];

  private readonly faintOpacity: Float32Array[] = [];
  private readonly brightProgress: Float32Array[] = [];
  private readonly haloProgress: Float32Array[] = [];
  private readonly dotOpacity: Float32Array[] = [];

  private phase: "idle" | "branching" | "chosen" | "hold" | "retracting" = "idle";
  private phaseTs = 0;
  private idleSince = 0;
  private chosenPath: number[] | null = null;
  private pointerInside = false;

  constructor(container: HTMLElement) {
    super(container, "0 0 360 250", "Branch prediction animation");

    addGlowFilter(this.defs, "branch-line-glow", 3);
    addGlowFilter(this.defs, "branch-halo-glow", 8);
    addGlowFilter(this.defs, "branch-dot-glow", 2);

    this.svg.append(this.faintLayer, this.haloLayer, this.brightLayer, this.dotLayer);

    this.buildGeometry();
    this.buildTree();

    if (this.canHover) {
      this.container.addEventListener("pointerenter", () => {
        this.pointerInside = true;
        if (this.phase === "idle" || this.phase === "retracting") {
          this.startBranching(performance.now());
        }
      });
      this.container.addEventListener("pointerleave", () => {
        this.pointerInside = false;
        if (this.phase !== "idle") {
          this.startRetracting(performance.now());
        }
      });
    }

    this.renderIdle();
  }

  protected tick(ts: number, _dt: number): void {
    if (!this.pointerInside && this.phase === "idle" && ts - this.idleSince > 520) {
      this.startBranching(ts);
    }
    if (!this.pointerInside && this.phase === "hold" && ts - this.phaseTs > 720) {
      this.startRetracting(ts);
    }

    switch (this.phase) {
      case "branching":
        this.tickBranching(ts);
        break;
      case "chosen":
        this.tickChosen(ts);
        break;
      case "hold":
        this.tickHold();
        break;
      case "retracting":
        this.tickRetracting(ts);
        break;
      case "idle":
        this.tickIdle();
        break;
      default:
        break;
    }

    this.applyTree();
  }

  protected renderReducedMotion(): void {
    this.chosenPath = [1, 3, 7];
    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      for (let index = 0; index < this.edges[level].length; index += 1) {
        this.faintOpacity[level][index] = this.isChosenEdge(level, index) ? 0.08 : 0.2;
        this.brightProgress[level][index] = this.isChosenEdge(level, index) ? 1 : 0;
        this.haloProgress[level][index] = this.isChosenEdge(level, index) ? 0.5 : 0;
      }
    }
    for (let level = 0; level < BranchPredictionDemo.LEVELS; level += 1) {
      const chosenNode = this.chosenNodeIndex(level);
      for (let index = 0; index < this.nodes[level].length; index += 1) {
        this.dotOpacity[level][index] = index === chosenNode ? 1 : 0.2;
      }
    }
    this.applyTree();
  }

  private buildGeometry(): void {
    const leaves = 1 << (BranchPredictionDemo.LEVELS - 1);
    const slotWidth = BranchPredictionDemo.WIDTH / leaves;

    for (let level = 0; level < BranchPredictionDemo.LEVELS; level += 1) {
      const count = 1 << level;
      const row: Array<{ x: number; y: number }> = [];
      for (let index = 0; index < count; index += 1) {
        const slotsPerNode = leaves >> level;
        row.push({
          x: (index * slotsPerNode + slotsPerNode / 2) * slotWidth,
          y:
            BranchPredictionDemo.ROOT_Y +
            (level / (BranchPredictionDemo.LEVELS - 1)) * (BranchPredictionDemo.LEAF_Y - BranchPredictionDemo.ROOT_Y),
        });
      }
      this.nodes.push(row);
      this.dotOpacity.push(new Float32Array(count));
    }

    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      const levelEdges: Array<{ length: number; index: number }> = [];
      this.faintOpacity.push(new Float32Array(this.nodes[level + 1].length));
      this.brightProgress.push(new Float32Array(this.nodes[level + 1].length));
      this.haloProgress.push(new Float32Array(this.nodes[level + 1].length));
      for (let parentIndex = 0; parentIndex < this.nodes[level].length; parentIndex += 1) {
        for (let side = 0; side < 2; side += 1) {
          const childIndex = parentIndex * 2 + side;
          const parent = this.nodes[level][parentIndex];
          const child = this.nodes[level + 1][childIndex];
          levelEdges.push({
            index: childIndex,
            length: Math.abs(child.y - parent.y) + Math.abs(child.x - parent.x),
          });
        }
      }
      this.edges.push(levelEdges);
    }
  }

  private buildTree(): void {
    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      const levelPaths: Array<{
        faint: SVGPathElement;
        bright: SVGPathElement;
        halo: SVGPathElement;
        length: number;
      }> = [];
      for (let parentIndex = 0; parentIndex < this.nodes[level].length; parentIndex += 1) {
        for (let side = 0; side < 2; side += 1) {
          const childIndex = parentIndex * 2 + side;
          const parent = this.nodes[level][parentIndex];
          const child = this.nodes[level + 1][childIndex];
          const d = `M ${parent.x.toFixed(2)},${parent.y.toFixed(2)} L ${parent.x.toFixed(2)},${child.y.toFixed(2)} L ${child.x.toFixed(2)},${child.y.toFixed(2)}`;
          const length = this.edges[level][childIndex].length;

          const faint = svgNode("path", {
            d,
            fill: "none",
            "stroke-linecap": "square",
            "stroke-linejoin": "miter",
          });
          const halo = svgNode("path", {
            d,
            fill: "none",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "stroke-dasharray": length,
            "stroke-dashoffset": length,
          });
          const bright = svgNode("path", {
            d,
            fill: "none",
            "stroke-linecap": "square",
            "stroke-linejoin": "miter",
            "stroke-dasharray": length,
            "stroke-dashoffset": length,
          });

          this.faintLayer.appendChild(faint);
          this.haloLayer.appendChild(halo);
          this.brightLayer.appendChild(bright);
          levelPaths.push({ faint, bright, halo, length });
        }
      }
      this.pathEls.push(levelPaths);
    }

    for (let level = 0; level < BranchPredictionDemo.LEVELS; level += 1) {
      const row: SVGCircleElement[] = [];
      for (let index = 0; index < this.nodes[level].length; index += 1) {
        const node = this.nodes[level][index];
        const dot = svgNode("circle", {
          cx: node.x,
          cy: node.y,
          r: level === 0 ? 3 : level === BranchPredictionDemo.LEVELS - 1 ? 2 : 2.3,
        });
        this.dotLayer.appendChild(dot);
        row.push(dot);
      }
      this.dots.push(row);
    }
  }

  private startBranching(ts: number): void {
    this.phase = "branching";
    this.phaseTs = ts;
    this.chosenPath = null;
    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      this.faintOpacity[level].fill(0);
      this.brightProgress[level].fill(0);
      this.haloProgress[level].fill(0);
    }
    for (const dots of this.dotOpacity) {
      dots.fill(0);
    }
  }

  private startRetracting(ts: number): void {
    this.phase = "retracting";
    this.phaseTs = ts;
  }

  private tickIdle(): void {
    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      this.faintOpacity[level].fill(0);
      this.brightProgress[level].fill(0);
      this.haloProgress[level].fill(0);
    }
    for (const dots of this.dotOpacity) {
      dots.fill(0);
    }
  }

  private tickBranching(ts: number): void {
    const elapsed = ts - this.phaseTs;
    const branchDur = 130;
    const totalReveal = branchDur * (BranchPredictionDemo.LEVELS - 1);

    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      const levelProgress = clamp((elapsed - level * branchDur) / branchDur, 0, 1);
      for (let index = 0; index < this.edges[level].length; index += 1) {
        this.faintOpacity[level][index] = smooth(this.faintOpacity[level][index], levelProgress * 0.34, 0.16);
      }
      for (let index = 0; index < this.nodes[level].length; index += 1) {
        this.dotOpacity[level][index] = smooth(this.dotOpacity[level][index], levelProgress * 0.42, 0.16);
      }
      if (level === BranchPredictionDemo.LEVELS - 2) {
        for (let index = 0; index < this.nodes[level + 1].length; index += 1) {
          this.dotOpacity[level + 1][index] = smooth(this.dotOpacity[level + 1][index], levelProgress * 0.36, 0.16);
        }
      }
    }

    if (elapsed >= totalReveal + 70) {
      this.chosenPath = this.pickPath();
      this.phase = "chosen";
      this.phaseTs = ts;
    }
  }

  private tickChosen(ts: number): void {
    if (!this.chosenPath) {
      return;
    }

    const elapsed = ts - this.phaseTs;
    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      const levelProgress = clamp((elapsed - level * 90) / 120, 0, 1);
      for (let index = 0; index < this.edges[level].length; index += 1) {
        const chosen = this.isChosenEdge(level, index);
        const brightTarget = chosen ? levelProgress : 0;
        const haloTarget = chosen ? levelProgress * 0.62 : 0;
        const faintTarget = chosen ? 0.05 : 0.24;
        this.brightProgress[level][index] = smooth(this.brightProgress[level][index], brightTarget, 0.16);
        this.haloProgress[level][index] = smooth(this.haloProgress[level][index], haloTarget, 0.14);
        this.faintOpacity[level][index] = smooth(this.faintOpacity[level][index], faintTarget, 0.14);
      }
    }

    for (let level = 0; level < BranchPredictionDemo.LEVELS; level += 1) {
      const chosenNode = this.chosenNodeIndex(level);
      for (let index = 0; index < this.nodes[level].length; index += 1) {
        const target = index === chosenNode ? 1 : 0.18;
        this.dotOpacity[level][index] = smooth(this.dotOpacity[level][index], target, 0.12);
      }
    }

    if (elapsed >= 520) {
      this.phase = "hold";
      this.phaseTs = ts;
    }
  }

  private tickHold(): void {
    if (!this.chosenPath) {
      return;
    }
    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      for (let index = 0; index < this.edges[level].length; index += 1) {
        const chosen = this.isChosenEdge(level, index);
        this.brightProgress[level][index] = smooth(this.brightProgress[level][index], chosen ? 1 : 0, 0.12);
        this.haloProgress[level][index] = smooth(this.haloProgress[level][index], chosen ? 0.62 : 0, 0.12);
        this.faintOpacity[level][index] = smooth(this.faintOpacity[level][index], chosen ? 0.05 : 0.24, 0.12);
      }
    }
    for (let level = 0; level < BranchPredictionDemo.LEVELS; level += 1) {
      const chosenNode = this.chosenNodeIndex(level);
      for (let index = 0; index < this.nodes[level].length; index += 1) {
        this.dotOpacity[level][index] = smooth(
          this.dotOpacity[level][index],
          index === chosenNode ? 1 : 0.18,
          0.12
        );
      }
    }
  }

  private tickRetracting(ts: number): void {
    const elapsed = ts - this.phaseTs;
    const retractDur = 110;
    let settled = true;

    for (let level = BranchPredictionDemo.LEVELS - 2; level >= 0; level -= 1) {
      const start = (BranchPredictionDemo.LEVELS - 2 - level) * retractDur;
      const retain = 1 - clamp((elapsed - start) / retractDur, 0, 1);
      for (let index = 0; index < this.edges[level].length; index += 1) {
        const chosen = this.isChosenEdge(level, index);
        const brightTarget = chosen ? retain : 0;
        const haloTarget = chosen ? retain * 0.5 : 0;
        const faintTarget = retain * 0.08;
        this.brightProgress[level][index] = smooth(this.brightProgress[level][index], brightTarget, 0.18);
        this.haloProgress[level][index] = smooth(this.haloProgress[level][index], haloTarget, 0.16);
        this.faintOpacity[level][index] = smooth(this.faintOpacity[level][index], faintTarget, 0.14);
        if (
          this.brightProgress[level][index] > 0.01 ||
          this.haloProgress[level][index] > 0.01 ||
          this.faintOpacity[level][index] > 0.01
        ) {
          settled = false;
        }
      }
    }

    for (let level = 0; level < BranchPredictionDemo.LEVELS; level += 1) {
      for (let index = 0; index < this.nodes[level].length; index += 1) {
        this.dotOpacity[level][index] = smooth(this.dotOpacity[level][index], 0, 0.14);
        if (this.dotOpacity[level][index] > 0.01) {
          settled = false;
        }
      }
    }

    if (settled) {
      this.phase = "idle";
      this.phaseTs = 0;
      this.idleSince = ts;
      this.chosenPath = null;
    }
  }

  private renderIdle(): void {
    this.idleSince = performance.now();
    this.applyTree();
  }

  private isChosenEdge(level: number, edgeIndex: number): boolean {
    return this.chosenPath !== null && this.chosenPath[level] === edgeIndex;
  }

  private chosenNodeIndex(level: number): number {
    if (!this.chosenPath) {
      return level === 0 ? 0 : -1;
    }
    let index = 0;
    for (let current = 0; current < level; current += 1) {
      index = this.chosenPath[current];
    }
    return index;
  }

  private pickPath(): number[] {
    const path: number[] = [];
    let parentIndex = 0;
    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      const side = Math.round(Math.random());
      const edgeIndex = parentIndex * 2 + side;
      path.push(edgeIndex);
      parentIndex = edgeIndex;
    }
    return path;
  }

  private applyTree(): void {
    for (let level = 0; level < BranchPredictionDemo.LEVELS - 1; level += 1) {
      for (let index = 0; index < this.pathEls[level].length; index += 1) {
        const edge = this.pathEls[level][index];
        const faintOpacity = this.faintOpacity[level][index];
        const brightProgress = this.brightProgress[level][index];
        const haloProgress = this.haloProgress[level][index];
        const dashOffset = edge.length * (1 - brightProgress);

        setPaint(edge.faint, {
          stroke: "var(--accent)",
          strokeOpacity: faintOpacity,
          strokeWidth: 1,
        });
        setPaint(edge.bright, {
          stroke: "var(--text-primary)",
          strokeOpacity: brightProgress > 0.01 ? 0.92 : 0,
          strokeWidth: 1.5,
          filter: "url(#branch-line-glow)",
        });
        setPaint(edge.halo, {
          stroke: "var(--accent)",
          strokeOpacity: haloProgress,
          strokeWidth: 6,
          filter: "url(#branch-halo-glow)",
        });

        edge.bright.setAttribute("stroke-dashoffset", dashOffset.toFixed(2));
        edge.halo.setAttribute("stroke-dashoffset", dashOffset.toFixed(2));
      }
    }

    for (let level = 0; level < BranchPredictionDemo.LEVELS; level += 1) {
      const chosenNode = this.chosenNodeIndex(level);
      for (let index = 0; index < this.dots[level].length; index += 1) {
        const dot = this.dots[level][index];
        const opacity = this.dotOpacity[level][index];
        setPaint(dot, {
          fill: index === chosenNode ? "var(--text-primary)" : "var(--accent)",
          fillOpacity: opacity,
          filter: index === chosenNode && opacity > 0.46 ? "url(#branch-dot-glow)" : undefined,
        });
      }
    }
  }
}

export function initLandingAnimations(): void {
  const containers = Array.from(document.querySelectorAll<HTMLElement>("[data-motion-demo]"));
  if (containers.length === 0) {
    return;
  }

  const demos = new Map<HTMLElement, MotionDemo>();

  for (const container of containers) {
    if (container.dataset.motionMounted === "1") {
      continue;
    }
    container.dataset.motionMounted = "1";

    const type = container.dataset.motionDemo as MotionDemoType | undefined;
    let demo: MotionDemo | null = null;

    switch (type) {
      case "stack":
        demo = new StackPeelDemo(container);
        break;
      case "pipeline":
        demo = new PipelineDemo(container);
        break;
      case "branch":
        demo = new BranchPredictionDemo(container);
        break;
      default:
        demo = null;
        break;
    }

    if (demo) {
      demos.set(container, demo);
    }
  }

  if (demos.size === 0) {
    return;
  }

  if (!("IntersectionObserver" in window)) {
    for (const demo of demos.values()) {
      demo.setVisible(true);
    }
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (!(target instanceof HTMLElement)) {
          continue;
        }
        demos.get(target)?.setVisible(entry.isIntersecting);
      }
    },
    {
      threshold: 0.3,
    }
  );

  for (const container of demos.keys()) {
    observer.observe(container);
  }
}
