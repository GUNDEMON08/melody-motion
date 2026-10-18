// scene.js — dependency-free WebGL2 renderer: sheet music on a marble floor, glowing dots that fall and
// burst into Google-coloured sparks when they touch the staff, with a bloom post-process.

export const SPEED = 2.4;        // world units per second along the staff
const STEP = 0.34;               // half a staff-line gap (one diatonic step)
const LEAD = 0.42;               // seconds a dot takes to fall onto its note
const GOOGLE = [
  [0.29, 0.56, 1.0],   // blue
  [1.0, 0.29, 0.24],   // red
  [1.0, 0.80, 0.08],   // yellow
  [0.20, 0.85, 0.40],  // green
];
const INK = [0.30, 0.37, 0.50];
const hsv = (h, sat, v) => { const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - sat), q = v * (1 - f * sat), t = v * (1 - (1 - f) * sat);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]; };
const PALETTES = {
  google: GOOGLE,
  hands: [[1.0, 0.55, 0.12], [1.0, 0.30, 0.20], [0.45, 0.95, 0.25], [0.95, 0.90, 0.20]],
  rainbow: Array.from({ length: 12 }, (_, i) => hsv(i / 12, 0.75, 1)),
};
const DIA = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]; // pitch class -> diatonic step (sharps sit on the natural below)

const diaOf = (p) => (Math.floor(p / 12) - 1) * 7 + DIA[p % 12];
const zOf = (p) => -(diaOf(p) - 28) * STEP;

// ---------- tiny matrix helpers (column-major) ----------
function perspective(fovy, aspect, n, f) {
  const t = 1 / Math.tan(fovy / 2);
  return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]);
}
function lookAt(e, c, u) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
}

// ---------- shaders ----------
const V300 = '#version 300 es\nprecision highp float;\n';
const FS_QUAD = V300 + `out vec2 vUv; void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.-1.,0.,1.); }`;

const NOISE = `
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float pnoise(vec2 p,float per){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  vec2 a=mod(i,per),b=mod(i+1.,per);
  return mix(mix(hash(a),hash(vec2(b.x,a.y)),f.x),mix(hash(vec2(a.x,b.y)),hash(b),f.x),f.y); }
float fbm(vec2 p,float per){ float a=.5,s=0.; for(int i=0;i<5;i++){ s+=a*pnoise(p,per); p*=2.; per*=2.; a*=.5; } return s; }
`;

const SRC = {
  bake: V300 + NOISE + `in vec2 vUv; out vec4 o;
    void main(){
      vec2 p=vUv*8.;
      float base=fbm(p,8.);
      vec2 w=vec2(fbm(p+3.7,8.),fbm(p+9.1,8.));
      float r=fbm(p*1.5+w*2.5,12.);
      float vein=1.-smoothstep(0.,.04,abs(r-.5));
      float vein2=1.-smoothstep(0.,.02,abs(fbm(p*3.+w*3.,24.)-.5));
      vec3 col=mix(vec3(.05,.065,.09),vec3(.13,.16,.21),base);
      col+=vec3(.55,.65,.8)*(vein*.16+vein2*.09);
      o=vec4(col,1.);
    }`,
  floorV: V300 + `layout(location=0) in vec3 aPos; uniform mat4 uVP; uniform vec2 uCenter; out vec2 vW;
    void main(){ vec3 w=vec3(uCenter.x+aPos.x*90., -0.02, uCenter.y+aPos.z*70.); vW=w.xz; gl_Position=uVP*vec4(w,1.); }`,
  floorF: V300 + `in vec2 vW; uniform sampler2D uTex; uniform vec3 uPlay; uniform vec3 uCam; uniform vec3 uTint; out vec4 o;
    void main(){
      vec3 a=texture(uTex,vW*0.05).rgb;
      vec3 b=texture(uTex,vW*0.017+vec2(.37,.61)).rgb;
      vec3 col=a*(0.55+b*3.0);
      float d=length(vW-uPlay.xz);
      float lit=0.38+1.35*exp(-d*d/80.);
      col*=lit;
      col+=uTint*exp(-d*d/14.)*0.22;
      float fd=length(vW-uCam.xz);
      col*=exp(-fd*fd/2300.);
      o=vec4(col,1.);
    }`,
  lineV: V300 + `layout(location=0) in vec3 aPos; uniform mat4 uVP; out vec2 vW; void main(){ vW=aPos.xz; gl_Position=uVP*vec4(aPos,1.); }`,
  lineF: V300 + `in vec2 vW; uniform vec3 uPlay; out vec4 o;
    void main(){ float dx=vW.x-uPlay.x; float a=smoothstep(-11.,-2.,dx)*(1.-smoothstep(16.,30.,dx));
      o=vec4(vec3(.66,.74,.88)*.85,.62*a); }`,
  noteV: V300 + `layout(location=0) in vec2 aQ; layout(location=1) in vec2 iPos; layout(location=2) in vec3 iCol; layout(location=3) in float iGlow;
    uniform mat4 uVP; out vec2 vQ; out vec3 vC; out float vG;
    void main(){ vQ=aQ; vC=iCol; vG=iGlow; vec3 w=vec3(iPos.x+aQ.x*.46*(1.+iGlow*.25), 0.012, iPos.y+aQ.y*.30*(1.+iGlow*.25)); gl_Position=uVP*vec4(w,1.); }`,
  noteF: V300 + `in vec2 vQ; in vec3 vC; in float vG; out vec4 o;
    void main(){ float r=length(vQ); float a=1.-smoothstep(.82,1.,r); if(a<=0.) discard;
      vec3 c=vC+vec3(.22)*vG*(1.-r); o=vec4(c,a); }`,
  ringV: V300 + `layout(location=0) in vec2 aQ; layout(location=1) in vec3 iA; layout(location=2) in vec3 iCol;
    uniform mat4 uVP; out vec2 vQ; out vec3 vC; out float vAge;
    void main(){ vQ=aQ; vC=iCol; vAge=iA.z; float s=.5+iA.z*3.4; vec3 w=vec3(iA.x+aQ.x*s, 0.02, iA.y+aQ.y*s*.7); gl_Position=uVP*vec4(w,1.); }`,
  ringF: V300 + `in vec2 vQ; in vec3 vC; in float vAge; out vec4 o;
    void main(){ float r=length(vQ); float ring=smoothstep(.62,.84,r)*(1.-smoothstep(.84,1.,r)); float a=ring*pow(1.-vAge,2.); o=vec4(vC*a*0.9,a); }`,
  ptV: V300 + `layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol; layout(location=2) in float aSize;
    uniform mat4 uVP; uniform float uScale; out vec4 vC;
    void main(){ vC=aCol; gl_Position=uVP*vec4(aPos,1.); gl_PointSize=max(1.,aSize*uScale/gl_Position.w); }`,
  ptF: V300 + `in vec4 vC; out vec4 o;
    void main(){ float d=length(gl_PointCoord-.5)*2.; if(d>1.) discard; float a=exp(-d*d*3.2)*vC.a; float core=exp(-d*d*14.);
      o=vec4((vC.rgb+vec3(.22)*core)*a*.85,a); }`,
  bright: FS_QUAD.replace(/^/, '') , // placeholder replaced below
};
SRC.brightF = V300 + `in vec2 vUv; uniform sampler2D uTex; out vec4 o;
  void main(){ vec3 c=texture(uTex,vUv).rgb; float l=max(c.r,max(c.g,c.b)); float k=smoothstep(.55,.95,l); o=vec4(c*k,1.); }`;
SRC.blurF = V300 + `in vec2 vUv; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
  void main(){ vec3 s=texture(uTex,vUv).rgb*.227027;
    s+=(texture(uTex,vUv+uDir*1.3846).rgb+texture(uTex,vUv-uDir*1.3846).rgb)*.3162162;
    s+=(texture(uTex,vUv+uDir*3.2308).rgb+texture(uTex,vUv-uDir*3.2308).rgb)*.0702703;
    o=vec4(s,1.); }`;
SRC.copyF = V300 + `in vec2 vUv; uniform sampler2D uTex; out vec4 o; void main(){ o=vec4(texture(uTex,vUv).rgb,1.); }`;
SRC.compF = V300 + `in vec2 vUv; uniform sampler2D uScene,uB0,uB1,uB2; uniform float uBloom; out vec4 o;
  void main(){ vec3 s=texture(uScene,vUv).rgb;
    vec3 b=texture(uB0,vUv).rgb*.4+texture(uB1,vUv).rgb*.55+texture(uB2,vUv).rgb*.7;
    vec3 c=s+b*uBloom; vec2 q=vUv-.5; c*=1.-dot(q,q)*.85; c=c/(1.+.12*c)*1.08; o=vec4(c,1.); }`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.slice(0, 200));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

const lowerBound = (arr, x, n = arr.length) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

export class MusicScene {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.preserve });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.maxDpr = opts.maxDpr || 1.75;
    this.bloom = 1.0;
    this.time = 0;
    this.lastT = 0;
    this.tint = [0, 0, 0];
    this.pal = GOOGLE; this.palMode = 'google'; this.fixedDpr = 0;

    const P = (v, f) => compile(gl, v, f);
    this.prog = {
      floor: P(SRC.floorV, SRC.floorF), line: P(SRC.lineV, SRC.lineF), note: P(SRC.noteV, SRC.noteF),
      ring: P(SRC.ringV, SRC.ringF), pt: P(SRC.ptV, SRC.ptF), bake: P(FS_QUAD, SRC.bake),
      bright: P(FS_QUAD, SRC.brightF), blur: P(FS_QUAD, SRC.blurF), copy: P(FS_QUAD, SRC.copyF), comp: P(FS_QUAD, SRC.compF),
    };

    // geometry
    const buf = (data, usage = gl.STATIC_DRAW) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage); return b; };
    this.quadXZ = buf(new Float32Array([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1]));
    this.quad2 = buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.vaoEmpty = gl.createVertexArray();
    this.vaoFloor = gl.createVertexArray();
    gl.bindVertexArray(this.vaoFloor);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadXZ); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this.vaoLines = gl.createVertexArray();
    this.lineBuf = gl.createBuffer(); this.lineCount = 0;

    this.vaoNotes = gl.createVertexArray();
    this.noteBuf = gl.createBuffer();
    this.maxRings = 64;
    this.vaoRings = gl.createVertexArray();
    this.ringBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf); gl.bufferData(gl.ARRAY_BUFFER, this.maxRings * 6 * 4, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.vaoRings);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad2); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 12); gl.vertexAttribDivisor(2, 1);
    this.rings = [];

    this.maxPts = 9000;
    this.ptData = new Float32Array(this.maxPts * 8);
    this.vaoPts = gl.createVertexArray();
    this.ptBuf = gl.createBuffer();
    gl.bindVertexArray(this.vaoPts);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf); gl.bufferData(gl.ARRAY_BUFFER, this.ptData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
    gl.bindVertexArray(null);

    // particle pool (struct of arrays)
    this.pc = 0;
    const M = 6000;
    this.P = { x: new Float32Array(M), y: new Float32Array(M), z: new Float32Array(M), vx: new Float32Array(M), vy: new Float32Array(M), vz: new Float32Array(M),
      life: new Float32Array(M), max: new Float32Array(M), size: new Float32Array(M), r: new Float32Array(M), g: new Float32Array(M), b: new Float32Array(M), M };

    this.bakeMarble();
    this.setSong([], 0);
    this.resize();
  }

  bakeMarble() {
    const gl = this.gl;
    const S = 1024;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, S, S);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog.bake.p);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    gl.deleteFramebuffer(fbo);
    this.marble = tex;
  }

  // ---- song data ----
  setSong(notes, duration) {
    const gl = this.gl;
    this.notes = notes;
    const n = notes.length;
    this.n = n;
    this.starts = new Float32Array(n);
    this.ends = new Float32Array(n);
    this.gi = new Uint8Array(n);
    this.nz = new Float32Array(n);
    this.inst = new Float32Array(Math.max(1, n) * 6);
    for (let i = 0; i < n; i++) {
      const nt = notes[i];
      this.starts[i] = nt.t;
      this.ends[i] = nt.t + Math.min(nt.d, 4);
            this.nz[i] = zOf(nt.p);
      this.inst[i * 6] = nt.t * SPEED; this.inst[i * 6 + 1] = this.nz[i];
      this.inst[i * 6 + 2] = INK[0]; this.inst[i * 6 + 3] = INK[1]; this.inst[i * 6 + 4] = INK[2];
    }
    this.computeGi();
    this.duration = duration;
    this.lastT = 0;
    this.pc = 0;
    this.rings.length = 0;

    // note instance buffer
    gl.bindVertexArray(this.vaoNotes);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.noteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad2);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // staff lines, ledger lines, system bar
    const v = [];
    const quad = (x0, x1, z, th) => v.push(x0, 0.004, z - th, x1, 0.004, z - th, x0, 0.004, z + th, x0, 0.004, z + th, x1, 0.004, z - th, x1, 0.004, z + th);
    const xEnd = duration * SPEED + 18;
    for (const dia of [30, 32, 34, 36, 38, 18, 20, 22, 24, 26]) quad(-9, xEnd, -(dia - 28) * STEP, 0.024);
    const vbar = (x, z0, z1) => v.push(x - 0.02, 0.004, z0, x + 0.02, 0.004, z0, x - 0.02, 0.004, z1, x - 0.02, 0.004, z1, x + 0.02, 0.004, z0, x + 0.02, 0.004, z1);
    vbar(-2.0, -(38 - 28) * STEP, -(18 - 28) * STEP);
    const seen = new Set();
    const hbar = (x0, x1, z) => v.push(x0, 0.004, z - 0.012, x1, 0.004, z - 0.012, x0, 0.004, z + 0.012, x0, 0.004, z + 0.012, x1, 0.004, z - 0.012, x1, 0.004, z + 0.012);
    for (const nt of notes) {
      if (nt.d < 2.5) { // stem: up (toward higher pitch) for notes below the middle line
        const dd = diaOf(nt.p), up = dd < (dd >= 28 ? 34 : 22), z0 = zOf(nt.p), x = nt.t * SPEED + (up ? 0.44 : -0.44);
        vbar(x, z0, z0 + (up ? -1 : 1) * STEP * 4.2);
      }
      if ([1, 3, 6, 8, 10].includes(nt.p % 12)) { // sharp sign
        const x = nt.t * SPEED - 0.78, z0 = zOf(nt.p);
        vbar(x, z0 - 0.26, z0 + 0.26); vbar(x + 0.15, z0 - 0.3, z0 + 0.22);
        hbar(x - 0.07, x + 0.22, z0 - 0.07); hbar(x - 0.07, x + 0.22, z0 + 0.1);
      }
      const dia = diaOf(nt.p), x = nt.t * SPEED;
      const ledger = [];
      if (dia >= 40) for (let d = 40; d <= dia; d += 2) ledger.push(d);
      else if (dia <= 16) for (let d = 16; d >= dia; d -= 2) ledger.push(d);
      else if (dia === 28 || dia === 27 && false) ledger.push(28);
      for (const d of ledger) {
        const key = Math.round(x * 20) + ':' + d;
        if (seen.has(key)) continue;
        seen.add(key);
        quad(x - 0.55, x + 0.55, -(d - 28) * STEP, 0.02);
      }
    }
    this.lineCount = v.length / 3;
    gl.bindVertexArray(this.vaoLines);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  setPalette(mode) { this.palMode = PALETTES[mode] ? mode : 'google'; this.pal = PALETTES[this.palMode]; this.computeGi(); }
  computeGi() {
    const m = this.palMode;
    for (let i = 0; i < this.n; i++) {
      const p = this.notes[i].p;
      this.gi[i] = m === 'hands' ? (p >= 60 ? 0 : 2) + (p % 2) : m === 'rainbow' ? p % 12 : p % 4;
    }
  }

  // ---- sizing ----
  resize() {
    const gl = this.gl, c = this.canvas;
    const dpr = this.fixedDpr || Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const w = Math.max(2, Math.floor(c.clientWidth * dpr)), h = Math.max(2, Math.floor(c.clientHeight * dpr));
    if (c.width === w && c.height === h && this.fbScene) return;
    c.width = w; c.height = h;
    this.W = w; this.H = h;
    for (const f of [this.fbScene, ...(this.levels || []).flatMap((l) => [l.a, l.b]), this.fbBright]) if (f) { gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.tex); }
    this.fbScene = this.makeFbo(w, h);
    if (this.msaa) { gl.deleteFramebuffer(this.msaa.fbo); gl.deleteRenderbuffer(this.msaa.rb); this.msaa = null; }
    try {
      const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
      if (samples > 1 && !this.noMsaa) {
        const rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
        const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) this.msaa = { fbo, rb };
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    } catch (e) { this.msaa = null; }
    this.fbBright = this.makeFbo(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.levels = [1, 2, 3].map((i) => {
      const lw = Math.max(2, w >> (i)), lh = Math.max(2, h >> (i));
      return { w: lw, h: lh, a: this.makeFbo(lw, lh), b: this.makeFbo(lw, lh) };
    });
  }
  makeFbo(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }

  // ---- particles ----
  spawn(x, y, z, vx, vy, vz, life, size, c) {
    const P = this.P;
    if (this.pc >= P.M) return;
    const i = this.pc++;
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
    P.life[i] = life; P.max[i] = life; P.size[i] = size; P.r[i] = c[0]; P.g[i] = c[1]; P.b[i] = c[2];
  }
  burst(x, z, gi) {
    const own = this.pal[gi];
    for (let k = 0; k < 13; k++) {
      const a = Math.random() * Math.PI * 2, sp = 0.8 + Math.random() * 2.6;
      const col = Math.random() < 0.55 ? this.pal[(Math.random() * this.pal.length) | 0] : own;
      this.spawn(x, 0.06, z, Math.cos(a) * sp, 1.6 + Math.random() * 3.6, Math.sin(a) * sp * 0.7, 0.55 + Math.random() * 0.7, 0.11 + Math.random() * 0.16, col);
    }
    if (this.rings.length < this.maxRings) this.rings.push({ x, z, age: 0, c: own });
    this.tint[0] += own[0] * 0.35; this.tint[1] += own[1] * 0.35; this.tint[2] += own[2] * 0.35;
  }

  // ---- main draw ----
  render(t, dt, playing, seeked) {
    const gl = this.gl;
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.time += dt;
    const px = t * SPEED;
    const aspect = this.W / this.H;

    // hits (notes whose start was crossed this frame)
    if (playing && !seeked && t > this.lastT && t - this.lastT < 0.4) {
      const a = lowerBound(this.starts, this.lastT + 1e-6, this.n), b = lowerBound(this.starts, t + 1e-6, this.n);
      const cnt = b - a, stride = cnt > 10 ? cnt / 10 : 1;
      for (let k = a; k < b; k += stride) { const i = k | 0; this.burst(this.nz.length ? this.starts[i] * SPEED : 0, this.nz[i], this.gi[i]); }
    }
    this.lastT = t;
    for (let k = 0; k < 3; k++) this.tint[k] *= Math.exp(-dt * 3.2);

    // visible notes & colours
    const i0 = lowerBound(this.starts, t - 5, this.n), i1 = lowerBound(this.starts, t + 13, this.n);
    const inst = this.inst;
    for (let i = i0; i < i1; i++) {
      const s = this.starts[i], e = this.ends[i], o = i * 6, g = this.pal[this.gi[i]];
      let k, glow = 0;
      if (t < s) { inst[o + 2] = INK[0]; inst[o + 3] = INK[1]; inst[o + 4] = INK[2]; inst[o + 5] = 0; continue; }
      if (t < e + 0.05) { k = 1; glow = 1; } else { k = 0.42 + 0.58 * Math.exp(-(t - e) * 2.0); }
      inst[o + 2] = g[0] * k; inst[o + 3] = g[1] * k; inst[o + 4] = g[2] * k; inst[o + 5] = glow;
    }

    // update particles
    const P = this.P;
    for (let i = 0; i < this.pc;) {
      P.life[i] -= dt;
      if (P.life[i] <= 0) { // swap-remove
        const j = --this.pc;
        for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'life', 'max', 'size', 'r', 'g', 'b']) P[key][i] = P[key][j];
        continue;
      }
      P.vy[i] -= 9 * dt;
      P.vx[i] *= 1 - 1.2 * dt; P.vz[i] *= 1 - 1.2 * dt;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
      if (P.y[i] < 0.02) { P.y[i] = 0.02; P.vy[i] *= -0.35; }
      i++;
    }

    // sustained notes emit a sparkling trail from the playhead
    const act0 = lowerBound(this.starts, t - 4.1, this.n), act1 = lowerBound(this.starts, t + 1e-6, this.n);
    let emitted = 0;
    const active = [];
    if (playing) {
      for (let i = act0; i < act1 && active.length < 24; i++) if (this.ends[i] > t) active.push(i);
      for (const i of active) {
        const g = this.pal[this.gi[i]];
        const n = Math.random() < dt * 70 ? 1 + (Math.random() < 0.5 ? 1 : 0) : 0;
        for (let k = 0; k < n && emitted < 60; k++, emitted++) {
          this.spawn(px + (Math.random() - 0.5) * 0.1, 0.05 + Math.random() * 0.25, this.nz[i] + (Math.random() - 0.5) * 0.3,
            -0.15 + Math.random() * 0.3, 0.3 + Math.random() * 0.9, (Math.random() - 0.5) * 0.6, 0.7 + Math.random() * 0.8, 0.06 + Math.random() * 0.1, Math.random() < 0.3 ? this.pal[(Math.random() * this.pal.length) | 0] : g);
        }
      }
    }
    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) { this.rings[i].age += dt / 0.9; if (this.rings[i].age >= 1) this.rings.splice(i, 1); }

    // camera: auto-framed so the playhead sits near the left of the screen at any aspect ratio
    const sc = aspect < 1.4 ? Math.pow(1.4 / aspect, 0.42) : 1;
    const sway = Math.sin(this.time * 0.22), sway2 = Math.sin(this.time * 0.15 + 1);
    const desired = aspect < 1 ? -0.3 : -0.48;
    const est = 3.6 * sc * Math.min(aspect, 1.8);
    const proj = perspective((48 * Math.PI) / 180, aspect, 0.1, 260);
    let off = this.camOff === undefined ? 2 : this.camOff, target, eye, vp;
    for (let it = 0; it < 3; it++) {
      target = [px + off, 0, -0.5];
      eye = [target[0] - 2.4 * sc + sway * 0.7, 4.4 * sc * (0.95 + 0.07 * sway2), 8.2 * sc + sway2 * 0.4];
      vp = mul(proj, lookAt(eye, target, [0, 1, 0]));
      const cx = vp[0] * px + vp[12], cw = vp[3] * px + vp[15];
      off += (cx / cw - desired) * est * 0.8;
    }
    this.camOff = off;
    target = [px + off, 0, -0.5];
    eye = [target[0] - 2.4 * sc + sway * 0.7, 4.4 * sc * (0.95 + 0.07 * sway2), 8.2 * sc + sway2 * 0.4];
    vp = mul(proj, lookAt(eye, target, [0, 1, 0]));

    // ---- pass 1: scene ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, (this.msaa || this.fbScene).fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    let pr = this.prog.floor;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uVP, false, vp);
    gl.uniform2f(pr.u.uCenter, target[0], target[2]);
    gl.uniform3f(pr.u.uPlay, px, 0, 0);
    gl.uniform3f(pr.u.uCam, eye[0], eye[1], eye[2]);
    gl.uniform3f(pr.u.uTint, this.tint[0], this.tint[1], this.tint[2]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.marble); gl.uniform1i(pr.u.uTex, 0);
    gl.bindVertexArray(this.vaoFloor);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    pr = this.prog.line;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uVP, false, vp);
    gl.uniform3f(pr.u.uPlay, px, 0, 0);
    gl.bindVertexArray(this.vaoLines);
    gl.drawArrays(gl.TRIANGLES, 0, this.lineCount);

    if (i1 > i0) {
      pr = this.prog.note;
      gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uVP, false, vp);
      gl.bindVertexArray(this.vaoNotes);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.noteBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, i0 * 24, inst.subarray(i0 * 6, i1 * 6));
      const base = i0 * 24;
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, base); gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, base + 8); gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 24, base + 20); gl.vertexAttribDivisor(3, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, i1 - i0);
    }

    gl.blendFunc(gl.ONE, gl.ONE); // additive from here on
    if (this.rings.length) {
      const rd = new Float32Array(this.rings.length * 6);
      this.rings.forEach((r, i) => { rd.set([r.x, r.z, r.age, r.c[0], r.c[1], r.c[2]], i * 6); });
      pr = this.prog.ring;
      gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uVP, false, vp);
      gl.bindVertexArray(this.vaoRings);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, rd);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.rings.length);
    }

    // sprites: particles + falling dots + glows
    const D = this.ptData;
    let c = 0;
    const put = (x, y, z, r, g, b, a, s) => { if (c >= this.maxPts) return; const o = c++ * 8; D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = r; D[o + 4] = g; D[o + 5] = b; D[o + 6] = a; D[o + 7] = s; };
    for (let i = 0; i < this.pc; i++) {
      const f = P.life[i] / P.max[i];
      put(P.x[i], P.y[i], P.z[i], P.r[i], P.g[i], P.b[i], Math.min(1, f * 1.6), P.size[i] * (0.4 + 0.6 * f));
    }
    const o0 = lowerBound(this.starts, t, this.n), o1 = lowerBound(this.starts, t + LEAD, this.n);
    for (let i = o0, cnt = 0; i < o1 && cnt < 160; i++, cnt++) {
      const k = (this.starts[i] - t) / LEAD, y = 0.08 + k * k * 4.6, g = this.pal[this.gi[i]], x = this.starts[i] * SPEED, z = this.nz[i];
      put(x, y, z, g[0], g[1], g[2], 1, 0.46);
      put(x, y + 0.5 * k + 0.2, z, g[0], g[1], g[2], 0.5, 0.3);
      put(x, y + 1.1 * k + 0.45, z, g[0], g[1], g[2], 0.25, 0.2);
    }
    for (const i of active) {
      const g = this.pal[this.gi[i]], fl = 0.75 + 0.25 * Math.sin(this.time * 30 + i);
      put(this.starts[i] * SPEED, 0.12, this.nz[i], g[0], g[1], g[2], 0.2 * fl, 0.85);
    }
    pr = this.prog.pt;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uVP, false, vp);
    gl.uniform1f(pr.u.uScale, this.H / (2 * Math.tan((48 * Math.PI) / 360)));
    gl.bindVertexArray(this.vaoPts);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, D.subarray(0, c * 8));
    gl.drawArrays(gl.POINTS, 0, c);
    gl.disable(gl.BLEND);

    // resolve MSAA into the scene texture
    if (this.msaa) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaa.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbScene.fbo);
      gl.blitFramebuffer(0, 0, this.W, this.H, 0, 0, this.W, this.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    // ---- bloom ----
    gl.bindVertexArray(this.vaoEmpty);
    const pass = (prog, dstF, w, h, bind) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstF ? dstF.fbo : null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog.p);
      bind(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const tex = (unit, t, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc, unit); };
    pass(this.prog.bright, this.fbBright, this.fbBright.w, this.fbBright.h, (p) => tex(0, this.fbScene.tex, p.u.uTex));
    let src = this.fbBright;
    for (const L of this.levels) {
      pass(this.prog.copy, L.a, L.w, L.h, (p) => tex(0, src.tex, p.u.uTex));
      pass(this.prog.blur, L.b, L.w, L.h, (p) => { tex(0, L.a.tex, p.u.uTex); gl.uniform2f(p.u.uDir, 1 / L.w, 0); });
      pass(this.prog.blur, L.a, L.w, L.h, (p) => { tex(0, L.b.tex, p.u.uTex); gl.uniform2f(p.u.uDir, 0, 1 / L.h); });
      src = L.a;
    }
    pass(this.prog.comp, null, this.W, this.H, (p) => {
      tex(0, this.fbScene.tex, p.u.uScene);
      tex(1, this.levels[0].a.tex, p.u.uB0);
      tex(2, this.levels[1].a.tex, p.u.uB1);
      tex(3, this.levels[2].a.tex, p.u.uB2);
      gl.uniform1f(p.u.uBloom, this.bloom);
    });
  }
}
