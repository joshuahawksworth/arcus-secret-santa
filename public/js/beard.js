/* ---------------------------------------------------------------------------
 * Santa's beard.
 *
 * A port of the cloth simulation from Google Santa Tracker's `santaselfie`
 * scene (Apache-2.0). In that scene the beard is a grid of points held
 * together by distance constraints, each one stamping the same little hair
 * tuft on to a canvas, and you style it with clippers, sprays and a hairdryer.
 *
 * The customisation is gone here -- no tools, no mouse, no sprays and no
 * decorations -- so what is left is the scene's own default beard: the same
 * constants, the same grid, the same pinning and the same hair shape, settled
 * under gravity and drawn once.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  const C = {
    CANVAS_WIDTH: 1200,
    CANVAS_HEIGHT: 1400,
    CLOTH_HEIGHT: 25,
    CLOTH_WIDTH: 22,
    START_Y: 670,
    SPACING: 20,
    PHYSICS_DELTA: 0.001024,
    PHYSICS_ACCURACY: 3,
    GRAVITY: 2000,
    DAMPING: 0.8,
  };

  /** Frames of simulation run before the first paint, to let the beard hang. */
  const SETTLE_STEPS = 160;

  const distance = (x, y) => Math.sqrt(x * x + y * y);

  class Point {
    constructor(options) {
      this.options = options;
      this.x = options.x;
      this.y = options.y;
      this.px = this.x;
      this.py = this.y;
      this.vx = 0;
      this.vy = 0;
      this.pinned = options.pinned || false;
      this.rotation = options.rotation || 2 * Math.random() * Math.PI;
      this.constraints = options.constraints || [];
      this.draw = !Object.prototype.hasOwnProperty.call(options, 'draw') || options.draw;
      this.constrain = !Object.prototype.hasOwnProperty.call(options, 'constrain') || options.constrain;
    }

    addForce(x, y) { this.vx += x; this.vy += y; }

    /** Verlet integration, as in the scene (minus the tools' forces). */
    update() {
      this.addForce(0, C.GRAVITY);
      const nx = this.x + (this.x - this.px) * C.DAMPING + (this.vx / 2) * C.PHYSICS_DELTA;
      const ny = this.y + (this.y - this.py) * C.DAMPING + (this.vy / 2) * C.PHYSICS_DELTA;
      this.px = this.x;
      this.py = this.y;
      this.x = nx;
      this.y = ny;
      this.vx = 0;
      this.vy = 0;
    }

    resolveConstraints(points) {
      if (this.pinned) {
        this.x = this.px;
        this.y = this.py;
        return;
      }
      for (let i = this.constraints.length; i--;) {
        this.resolveConstraint(points[this.constraints[i]]);
      }
      const maxX = C.CANVAS_WIDTH - 1;
      const maxY = C.CANVAS_HEIGHT - 1;
      if (this.x > maxX) this.x = 2 * maxX - this.x;
      else if (this.x < 1) this.x = 2 - this.x;
      if (this.y < 1) this.y = 2 - this.y;
      else if (this.y > maxY) { this.y = maxY; this.draw = false; }
    }

    resolveConstraint(other) {
      if (!this.constrain || !other) return;
      const dx = this.x - other.x;
      const dy = this.y - other.y;
      const length = distance(dx, dy);
      const difference = (C.SPACING - length) / length;
      const adjustX = dx * difference * 0.5;
      const adjustY = dy * difference * 0.5;
      this.x += adjustX;
      this.y += adjustY;
      other.x -= adjustX;
      other.y -= adjustY;
    }

    drawHair(tuft, ctx, scale) {
      if (!this.draw) return;
      const sin = Math.sin(this.rotation);
      const cos = Math.cos(this.rotation);
      const w = tuft.width;
      const h = tuft.height;
      ctx.save();
      ctx.setTransform(cos, sin, -sin, cos, this.x * scale, this.y * scale);
      ctx.drawImage(tuft, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
  }

  /** The scene's hair tuft: one wispy shape, stamped once per grid point. */
  function makeHairShape(scale) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 53 * scale;
    canvas.height = 52 * scale;
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(47, 30);
    ctx.bezierCurveTo(46, 28, 49, 25, 49, 23);
    ctx.bezierCurveTo(48, 20, 47, 18, 46, 15);
    ctx.bezierCurveTo(44, 15, 46, 18, 40, 19);
    ctx.bezierCurveTo(41, 12, 34, 7, 34, 0);
    ctx.bezierCurveTo(31, 5, 30, 11, 31, 17);
    ctx.bezierCurveTo(28, 13, 23, 10, 22, 4);
    ctx.bezierCurveTo(19, 9, 19, 13, 18, 18);
    ctx.bezierCurveTo(13, 14, 6, 14, 0, 17);
    ctx.bezierCurveTo(4, 18, 9, 19, 11, 23);
    ctx.bezierCurveTo(9, 21, 2, 21, 0, 22);
    ctx.bezierCurveTo(9, 26, 10, 38, 17, 43);
    ctx.bezierCurveTo(17, 44, 12, 48, 11, 46);
    ctx.bezierCurveTo(13, 49, 19, 48, 22, 48);
    ctx.bezierCurveTo(23, 49, 26, 50, 27, 50);
    ctx.bezierCurveTo(32, 52, 28, 44, 33, 52);
    ctx.bezierCurveTo(33, 46, 37, 47, 39, 50);
    ctx.bezierCurveTo(39, 48, 38, 46, 37, 44);
    ctx.bezierCurveTo(42, 44, 46, 41, 49, 38);
    ctx.bezierCurveTo(47, 39, 44, 39, 43, 37);
    ctx.bezierCurveTo(44, 39, 53, 31, 53, 29);
    ctx.bezierCurveTo(51, 31, 49, 31, 47, 30);
    ctx.bezierCurveTo(47, 29, 48, 31, 47, 30);
    ctx.closePath();
    ctx.fill();
    return canvas;
  }

  /** The scene's starting grid: a pinned mass with a free-hanging fringe. */
  function buildCloth() {
    const width = C.CANVAS_WIDTH;
    const cols = C.CLOTH_WIDTH;
    const rows = C.CLOTH_HEIGHT;
    const spacing = C.SPACING;
    const startY = C.START_Y;
    const left = width / 2 - (cols * spacing) / 2;
    const points = [];
    const radius = cols / 2;

    for (let row = 0; row <= rows; row++) {
      for (let col = 0; col <= cols; col++) {
        const constraints = [];
        if (col > 0) constraints.push(points.length - 1);
        if (row > 0) constraints.push(col + (row - 1) * (cols + 1));
        const x = left + col * spacing;
        const y = startY + row * spacing;
        const pinned = y < 5
          || distance(x - width / 2, y - startY - 30) < ((cols + 2) * spacing) / 2;
        const inRoundedTip = (col - radius) * (col - radius)
          + (row - (rows - radius)) * (row - (rows - radius)) < radius * radius;
        points.push(new Point({
          x, y, pinned, constraints,
          draw: !(row > rows - radius) || inRoundedTip,
        }));
      }
    }

    // The sideburns down each edge...
    const side = (col, row) => points.push(new Point({
      x: left + col * spacing, y: startY - row * spacing, pinned: true,
    }));
    // ...and the moustache above the beard.
    const tache = (col, row) => points.push(new Point({
      x: left + 60 + col * spacing, y: startY - 165 - row * spacing, pinned: true,
    }));

    for (let row = 1; row < 5; row++) {
      for (let col = 0; col < 2; col++) { side(col, row); side(col + cols - 1, row); }
    }
    for (let col = 3; col < 11; col++) tache(col, 3);
    for (let col = 3; col < 12; col++) tache(col, 2);
    for (let col = 4; col < 12; col++) tache(col, 1);
    for (let col = 5; col < 11; col++) tache(col, 0);

    return points;
  }

  class Beard {
    /** @param {HTMLCanvasElement} canvas sized in `em` against the face */
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.points = buildCloth();
      for (let step = SETTLE_STEPS; step--;) this.step();
      this.render();
    }

    step() {
      for (let i = C.PHYSICS_ACCURACY; i--;) {
        for (let j = this.points.length; j--;) this.points[j].resolveConstraints(this.points);
      }
      for (let j = this.points.length; j--;) this.points[j].update();
    }

    render() {
      // One scene unit is one `em` of the face, so read the computed size.
      const unit = parseFloat(window.getComputedStyle(this.canvas).fontSize) || 1;
      const dpr = window.devicePixelRatio || 1;
      const scale = unit * dpr;

      this.canvas.width = Math.ceil(C.CANVAS_WIDTH * scale);
      this.canvas.height = Math.ceil(C.CANVAS_HEIGHT * scale);
      this.canvas.style.width = `${C.CANVAS_WIDTH * unit}px`;
      this.canvas.style.height = `${C.CANVAS_HEIGHT * unit}px`;

      const tuft = makeHairShape(scale);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      for (let i = this.points.length; i--;) this.points[i].drawHair(tuft, this.ctx, scale);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  window.SantaBeard = Beard;
})();
