import { getUiPreferences } from "./uiPreferences.js";
import { GLASS_FRAGMENT, ROUND_FRAGMENT } from "./shaders/pomodoroGlass.js";
import { BLUR_FRAGMENT } from "./shaders/pomodoroGlassBlur.js";
import { mountPomodoroGlassControls } from "./pomodoroGlassControls.js";

const COPY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 fragTexCoord;
uniform sampler2D texture0;
out vec4 finalColor;
void main() { finalColor = texture(texture0, fragTexCoord); }`;
const SLICE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 fragTexCoord;
uniform sampler2D texture0;
out vec4 finalColor;
void main() {
  vec3 color = texture(texture0, fragTexCoord).rgb;
  finalColor = vec4(mix(color, vec3(.86, .96, .94), .18), 1.0);
}`;

// The timer remains ordinary DOM. Only its decorative material is rendered on the GPU.
export function pomodoroGlassState(prefs, hidden, systemReduced, visible = true) {
  if (prefs.pomodoroLiquidGlass !== true) return "off";
  if (hidden || !visible) return "paused";
  if (prefs.motion === "reduced" || (prefs.motion !== "full" && systemReduced)) return "static";
  return "running";
}

export function attachPomodoroGlass(card, {
  doc = document, browserWindow = window, preferences = getUiPreferences,
} = {}) {
  let prefs = preferences(), disposed = false, hidden = false, visible = true;
  let canvas = null, gpu = null, raf = 0, failed = false, dirty = true, lastFrame = 0, time = 0;
  const controls = mountPomodoroGlassControls(card, doc);
  controls?.sync(prefs);
  const media = browserWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
  const vertex = `#version 300 es
    in vec2 position; out vec2 fragTexCoord; out vec4 fragColor;
    void main(){fragTexCoord=(position+1.0)*0.5;fragColor=vec4(1.0);gl_Position=vec4(position,0.0,1.0);}`;
  const originalStyle = { position: card.style.position, isolation: card.style.isolation };
  function cancel() { if (raf) browserWindow.cancelAnimationFrame(raf); raf = 0; lastFrame = 0; }
  function release() {
    cancel();
    canvas?.removeEventListener("webglcontextlost", onContextLost);
    if (gpu) {
      const { gl, programs, textures, buffer, framebuffer } = gpu;
      for (const p of Object.values(programs)) gl.deleteProgram(p.object);
      for (const texture of textures) gl.deleteTexture(texture);
      gl.deleteBuffer(buffer); gl.deleteFramebuffer(framebuffer);
      // Disabled cards must not keep an idle WebGL context allocated.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    gpu = null;
    canvas?.remove(); canvas = null;
    card.style.position = originalStyle.position;
    card.style.isolation = originalStyle.isolation;
  }
  function fallback() {
    failed = true; release(); card.dataset.liquidGlassState = "fallback";
  }
  function initialize() {
    if (gpu || failed) return;
    const resources = { shaders: [], programs: [], textures: [] };
    let gl;
    try {
      canvas = doc.createElement("canvas");
      canvas.className = "pomodoro-glass-canvas";
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:-1;border-radius:inherit;pointer-events:none";
      gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false });
      if (!gl) { fallback(); return; }
      function compile(type, source) {
        const shader = gl.createShader(type); resources.shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      }
      function program(fragment) {
        const object = gl.createProgram(); resources.programs.push(object);
        gl.attachShader(object, compile(gl.VERTEX_SHADER, vertex));
        gl.attachShader(object, compile(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(object);
        if (!gl.getProgramParameter(object, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(object));
        const uniforms = {};
        for (let i = 0; i < gl.getProgramParameter(object, gl.ACTIVE_UNIFORMS); i++) {
          const info = gl.getActiveUniform(object, i);
          uniforms[info.name] = { location: gl.getUniformLocation(object, info.name), type: info.type };
        }
        return { object, uniforms, position: gl.getAttribLocation(object, "position") };
      }
      const programs = {
        glass: program(GLASS_FRAGMENT), blur: program(BLUR_FRAGMENT),
        roundSlice: program(SLICE_FRAGMENT), clip: program(ROUND_FRAGMENT), copy: program(COPY_FRAGMENT),
      };
      for (const shader of resources.shaders) gl.deleteShader(shader);
      resources.shaders = [];
      const buffer = gl.createBuffer(); resources.buffer = buffer;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
      const textures = [0, 1].map(() => {
        const texture = gl.createTexture(); resources.textures.push(texture);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, axis, gl.CLAMP_TO_EDGE);
        for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR);
        return texture;
      });
      const framebuffer = gl.createFramebuffer(); resources.framebuffer = framebuffer;
      const artwork = doc.createElement("canvas"), ctx = artwork.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D unavailable");
      gpu = { gl, programs, textures, buffer, framebuffer, artwork, ctx, w: 0, h: 0 };
      card.style.position = "relative"; card.style.isolation = "isolate";
      card.prepend(canvas);
      canvas.addEventListener("webglcontextlost", onContextLost);
      dirty = true;
    } catch {
      if (gl && !gpu) {
        for (const shader of resources.shaders) gl.deleteShader(shader);
        for (const p of resources.programs) gl.deleteProgram(p);
        for (const t of resources.textures) gl.deleteTexture(t);
        if (resources.buffer) gl.deleteBuffer(resources.buffer);
        if (resources.framebuffer) gl.deleteFramebuffer(resources.framebuffer);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
      fallback();
    }
  }
  function onContextLost(event) { event.preventDefault(); if (gpu) fallback(); }
  function resolvedColor(token, fallbackColor) {
    const probe = doc.createElement("span"); probe.style.color = `var(${token},${fallbackColor})`;
    probe.style.display = "none"; card.append(probe);
    const color = browserWindow.getComputedStyle(probe).color; probe.remove();
    return color || fallbackColor;
  }
  function prepare() {
    const { gl, textures, framebuffer, artwork, ctx } = gpu;
    const mobile = browserWindow.innerWidth <= 900;
    const scale = Math.min(browserWindow.devicePixelRatio || 1, mobile ? .85 : 1.25, 900 / Math.max(card.clientWidth, card.clientHeight, 1));
    const w = Math.max(1, Math.round(card.clientWidth * scale)), h = Math.max(1, Math.round(card.clientHeight * scale));
    canvas.width = w; canvas.height = h; artwork.width = w; artwork.height = h;
    gpu.w = w; gpu.h = h; gpu.scale = scale;
    gpu.dark = doc.documentElement.dataset.themeMode === "dark";
    const panel = resolvedColor("--panel", "#fbf8ff"), deep = resolvedColor("--deep", "#81559b");
    const mint = resolvedColor("--mint", "#7fafb4");
    ctx.fillStyle = panel; ctx.fillRect(0, 0, w, h);
    // A local texture gives the refraction real pixels without capturing task text or the desktop.
    ctx.globalAlpha = gpu.dark ? .16 : .24;
    for (const [x, y, color] of [[.12,.13,deep],[.9,.58,mint],[.35,.95,deep]]) {
      const radius = Math.max(w, h) * .66;
      const cloud = ctx.createRadialGradient(w*x,h*y,0,w*x,h*y,radius);
      cloud.addColorStop(0,color); cloud.addColorStop(1,panel); ctx.fillStyle=cloud;ctx.fillRect(0,0,w,h);
    }
    ctx.globalAlpha = gpu.dark ? .12 : .13;ctx.strokeStyle = deep;ctx.lineWidth = Math.max(18,w*.065);
    for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(w*.86,h*.46,w*(.30+i*.07),h*(.27+i*.055),-.35,0,Math.PI*2);ctx.stroke();}
    ctx.globalAlpha = 1;
    gl.bindTexture(gl.TEXTURE_2D,textures[0]);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,artwork);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.bindTexture(gl.TEXTURE_2D,textures[1]);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,textures[1],0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error("Framebuffer unavailable");
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);dirty=false;
  }
  function draw(program, texture, values) {
    const { gl, buffer } = gpu;
    gl.useProgram(program.object);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.enableVertexAttribArray(program.position);gl.vertexAttribPointer(program.position,2,gl.FLOAT,false,0,0);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
    for(const [name,value] of Object.entries({texture0:0,...values})){
      const u=program.uniforms[name];if(!u)continue;
      if(Array.isArray(value)){if(value.length===2)gl.uniform2fv(u.location,value);else gl.uniform4fv(u.location,value);}
      else if(u.type===gl.INT||u.type===gl.SAMPLER_2D)gl.uniform1i(u.location,value);else gl.uniform1f(u.location,value);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  }
  function frame(now) {
    raf=0;
    const state=pomodoroGlassState(prefs,doc.hidden||hidden,media?.matches===true,visible);
    if(disposed||!gpu||state==="off"||state==="paused")return;
    if(!card.isConnected){dispose();return;}
    if(lastFrame && now-lastFrame<1000/30){schedule();return;}
    if(state==="running")time+=lastFrame?Math.min((now-lastFrame)/1000,.1):0;
    lastFrame=now;
    try {
      if(dirty)prepare();
      const { gl, programs, textures, framebuffer, w, h, scale, dark }=gpu;
      const resolution=[w,h];
      const lens=controls?.lens;
      const left=Math.round((lens?.offsetLeft||0)*scale), top=Math.round((lens?.offsetTop||0)*scale);
      const width=Math.max(1,Math.round((lens?.offsetWidth||card.clientWidth)*scale));
      const height=Math.max(1,Math.round((lens?.offsetHeight||card.clientHeight)*scale));
      const radius=Math.min(prefs.pomodoroGlassRadius*scale,Math.min(width,height)/2);
      const rect=[left,h-top-height,width,height];
      gl.viewport(0,0,w,h);
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.max(0,left-2),Math.max(0,h-top-height-2),width+4,height+4);
      if(prefs.pomodoroGlassMaterial==="glass") {
        draw(programs.glass,textures[0],{resolution,rectPx:rect,cornerRadiusPx:radius,thicknessPx:16*scale,
          distortionPx:prefs.pomodoroGlassDistortion,highlightStrength:prefs.pomodoroGlassHighlight*(dark?.45:.7),
          edgeWidthPx:22*scale,ior:1.46,brightness:dark?.65:1.05,exemptPx:[0,0,0,0],time,
          flowStrength:state==="static"?0:prefs.pomodoroGlassFlow,flowScale:65*scale,
          scatterSizePx:prefs.pomodoroGlassScatter*scale,
          scatterDirections:browserWindow.innerWidth<=900||!prefs.pomodoroGlassScatter?0:4,scatterQuality:2});
      } else if(prefs.pomodoroGlassMaterial==="blur") {
        draw(programs.blur,textures[0],{resolution,blurRadius:prefs.pomodoroGlassScatter*scale});
      } else draw(programs.roundSlice,textures[0],{resolution});
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      draw(programs.copy,textures[0],{resolution});
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      draw(programs.clip,textures[1],{resolution,size:[width,height],roundness:radius*2/Math.min(width,height),
        feather:Math.max(1,scale),destMin:[left,top],destMax:[left+width,top+height],uvMin:[0,0],uvMax:[1,1]});
      gl.disable(gl.BLEND);
      card.dataset.liquidGlassState=state;
      if(gl.getError()!==gl.NO_ERROR)throw new Error("WebGL render failed");
    } catch { fallback(); return; }
    if(state==="running"&&prefs.pomodoroGlassMaterial==="glass"&&prefs.pomodoroGlassFlow>0)schedule();
  }
  function schedule(){if(!raf&&!disposed&&gpu)raf=browserWindow.requestAnimationFrame(frame);}
  function sync() {
    if(disposed)return;
    const state=pomodoroGlassState(prefs,doc.hidden||hidden,media?.matches===true,visible);
    if(state==="off"){failed=false;release();card.dataset.liquidGlassState="off";return;}
    if(state==="paused"){cancel();card.dataset.liquidGlassState="paused";return;}
    initialize();if(gpu){cancel();schedule();}
  }
  function onPreferences(event){prefs=event.detail||preferences();controls?.sync(prefs);dirty=true;sync();}
  function onHide(){hidden=true;sync();}
  function onShow(){hidden=false;dirty=true;sync();}
  function redraw(){dirty=true;controls?.sync(prefs);sync();}
  function moved(){if(gpu){cancel();schedule();}}
  const resize=browserWindow.ResizeObserver?new browserWindow.ResizeObserver(redraw):null;
  const theme=browserWindow.MutationObserver?new browserWindow.MutationObserver(redraw):null;
  const intersection=browserWindow.IntersectionObserver?new browserWindow.IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting!==false;sync();}):null;
  resize?.observe(card);theme?.observe(doc.documentElement,{attributes:true,attributeFilter:["data-theme","data-theme-mode","data-nephele-settings"]});intersection?.observe(card);
  browserWindow.addEventListener("tide:ui-preferences-changed",onPreferences);
  card.addEventListener?.("pomodoro:glass-moved",moved);
  browserWindow.addEventListener("pagehide",onHide);browserWindow.addEventListener("pageshow",onShow);
  doc.addEventListener("visibilitychange",sync);media?.addEventListener?.("change",redraw);
  function dispose(){
    if(disposed)return;disposed=true;release();
    resize?.disconnect();theme?.disconnect();intersection?.disconnect();
    browserWindow.removeEventListener("tide:ui-preferences-changed",onPreferences);
    card.removeEventListener?.("pomodoro:glass-moved",moved);
    browserWindow.removeEventListener("pagehide",onHide);browserWindow.removeEventListener("pageshow",onShow);
    doc.removeEventListener("visibilitychange",sync);media?.removeEventListener?.("change",redraw);
    controls?.dispose();
    delete card.dataset.liquidGlassState;
  }
  sync();return dispose;
}
