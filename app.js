
/* ==========================================================================
   RealityScan メッシュ補正 — app.js
   Stable OBJ-first pipeline: import -> preview -> shape finishing -> save.
   All processing runs client-side. Large meshes are processed in chunks
   across animation frames so the tab never freezes.
   ========================================================================== */

/* ---------- DOM refs ---------- */
const fileInput   = document.getElementById('fileInput');
const dropZone    = document.getElementById('dropZone');
const fileList     = document.getElementById('fileList');
const fileItems    = document.getElementById('fileItems');
const warnBanner   = document.getElementById('warnBanner');

const previewWrap      = document.getElementById('previewWrap');
const previewEmptyWrap = document.getElementById('previewEmptyWrap');
const previewCanvas    = document.getElementById('previewCanvas');
const previewStats     = document.getElementById('previewStats');
const tabBefore = document.getElementById('tabBefore');
const tabAfter  = document.getElementById('tabAfter');
const wireToggle = document.getElementById('wireToggle');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const resetViewBtn = document.getElementById('resetViewBtn');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');

const weldDistEl    = document.getElementById('weldDist');
const weldDistVal   = document.getElementById('weldDistVal');
const spikeRatioEl  = document.getElementById('spikeRatio');
const spikeRatioVal = document.getElementById('spikeRatioVal');
const smoothIterEl  = document.getElementById('smoothIter');
const smoothIterVal = document.getElementById('smoothIterVal');
const keepLargestEl = document.getElementById('keepLargest');
const lowpolyDegreeGroup = document.getElementById('lowpolyDegreeGroup');
const lowpolyStyleGroup  = document.getElementById('lowpolyStyleGroup');
const lowpolyTexGroup    = document.getElementById('lowpolyTexGroup');

const convertBtn = document.getElementById('convertBtn');
const resetBtn    = document.getElementById('resetBtn');
const progressWrap= document.getElementById('progressWrap');
const progressFill= document.getElementById('progressFill');
const progressPct = document.getElementById('progressPct');
const progressStage=document.getElementById('progressStage');
const logBox      = document.getElementById('logBox');
const statsBox    = document.getElementById('stats');

const saveObjBtn    = document.getElementById('saveObjBtn');
const saveObjTexBtn = document.getElementById('saveObjTexBtn');
const saveGlbBtn    = document.getElementById('saveGlbBtn');
const saveUsdzBtn   = document.getElementById('saveUsdzBtn');
const chunkedOutputEl = document.getElementById('chunkedOutput');
const chunkedOpts     = document.getElementById('chunkedOpts');
const chunkFaceCountEl  = document.getElementById('chunkFaceCount');
const chunkFaceCountVal = document.getElementById('chunkFaceCountVal');
const chunkList = document.getElementById('chunkList');
const saveLogBox = document.getElementById('saveLogBox');

/* ---------- State ---------- */
let rawFiles = {};          // { obj, mtl, textures:[File,...] }
let originalMesh = null;    // { positions, faces, uv, hasTexture }
let fixedMesh = null;
let lowpolyDegree = 0;
let lowpolyStyle = 'standard';
let lowpolyTexDegree = 0;
let previewMode = 'before'; // before | after
let wireframeOn = false;

/* ---------- Slider labels ---------- */
function weldDistMeters(){ return weldDistEl.value / 10000; }
function chunkOverlapMeters(){ return 0.002; } // fixed sane default, no separate UI now
weldDistEl.addEventListener('input', () => weldDistVal.textContent = weldDistMeters().toFixed(4));
spikeRatioEl.addEventListener('input', () => spikeRatioVal.textContent = spikeRatioEl.value);
smoothIterEl.addEventListener('input', () => smoothIterVal.textContent = smoothIterEl.value);
weldDistVal.textContent = weldDistMeters().toFixed(4);
spikeRatioVal.textContent = spikeRatioEl.value;
smoothIterVal.textContent = smoothIterEl.value;
chunkFaceCountEl.addEventListener('input', () => chunkFaceCountVal.textContent = parseInt(chunkFaceCountEl.value,10).toLocaleString());
chunkFaceCountVal.textContent = parseInt(chunkFaceCountEl.value,10).toLocaleString();

function bindSegGroup(group, onSelect){
  group.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onSelect(btn.dataset.val);
    });
  });
}
bindSegGroup(lowpolyDegreeGroup, v => lowpolyDegree = parseFloat(v));
bindSegGroup(lowpolyStyleGroup, v => lowpolyStyle = v);
bindSegGroup(lowpolyTexGroup, v => lowpolyTexDegree = parseInt(v,10));

chunkedOutputEl.addEventListener('change', () => {
  chunkedOpts.style.display = chunkedOutputEl.checked ? 'block' : 'none';
});

/* ---------- Logging / progress ---------- */
function log(msg, cls='log-info'){
  const l = document.createElement('div'); l.className = cls; l.textContent = msg;
  logBox.appendChild(l); logBox.scrollTop = logBox.scrollHeight; logBox.classList.add('visible');
}
function saveLog(msg, cls='log-info'){
  const l = document.createElement('div'); l.className = cls; l.textContent = msg;
  saveLogBox.appendChild(l); saveLogBox.scrollTop = saveLogBox.scrollHeight; saveLogBox.classList.add('visible');
}
function setProgress(stage, pct){
  progressWrap.classList.add('visible');
  progressStage.textContent = stage;
  progressPct.textContent = Math.round(pct) + '%';
  progressFill.style.width = Math.min(100, Math.max(0,pct)) + '%';
}
function yieldFrame(){ return new Promise(r => requestAnimationFrame(() => setTimeout(r,0))); }

/* ==========================================================================
   FILE HANDLING
   ========================================================================== */
['dragover'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('drag-over'); }));
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  handleFiles(Array.from(e.dataTransfer.files));
});
fileInput.addEventListener('change', () => handleFiles(Array.from(fileInput.files)));

const WARN_FACE_COUNT = 400000;
const HARD_FACE_COUNT = 2000000;

function quickEstimateCounts(text){
  let v=0, f=0, i=0; const len=text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c===118 && text.charCodeAt(i+1)===32) v++;
    else if (c===102 && text.charCodeAt(i+1)===32) f++;
    const nl = text.indexOf('\n', i);
    if (nl === -1) break;
    i = nl+1;
  }
  return {v,f};
}

async function handleFiles(files){
    // --- glTF folder (scene.gltf + scene.bin + textures) detection ---
    const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
    const glbFile  = files.find(f => f.name.toLowerCase().endsWith('.glb'));

    if (gltfFile || glbFile) {
      await handleGltfFolder(files, gltfFile, glbFile);
      return;
    }

    // --- classic OBJ + MTL + textures flow ---
    const obj = files.find(f => f.name.toLowerCase().endsWith('.obj'));
    const mtl = files.find(f => f.name.toLowerCase().endsWith('.mtl'));
    const textures = files.filter(f => /\.(png|jpe?g)$/i.test(f.name));
    if (!obj) { log('OBJ・glTFファイルが見つかりませんでした。フォルダを選び直してください。', 'log-warn'); return; }

    rawFiles = { obj, mtl, textures };
    fileItems.innerHTML = '';
    [obj, mtl, ...textures].filter(Boolean).forEach(f => {
      const ext = f.name.split('.').pop().toUpperCase();
      const div = document.createElement('div');
      div.className = 'file-item';
      div.innerHTML = `<span><span class="badge">${ext}</span>${f.name}</span><span>${(f.size/1024/1024).toFixed(1)} MB</span>`;
      fileItems.appendChild(div);
    });
    fileList.classList.add('visible');

    const text = await obj.text();
    rawFiles.objText = text;
    const { v, f } = quickEstimateCounts(text);
    log(`読み込み: 頂点 約${v.toLocaleString()} / 面 約${f.toLocaleString()}`, 'log-info');
    showSizeWarning((obj.size/1024/1024), f);

    setProgress('解析中 / Parsing OBJ', 0);
    originalMesh = await parseOBJ(text, p => setProgress('解析中', p));
    originalMesh.hasTexture = !!(mtl && textures.length);
    fixedMesh = null;

    convertBtn.disabled = false;
    resetBtn.disabled = true;
    [saveObjBtn, saveGlbBtn, saveUsdzBtn].forEach(b => b.disabled = false);
    saveObjTexBtn.disabled = !originalMesh.hasTexture;
    if (!originalMesh.hasTexture) saveObjTexBtn.title = 'テクスチャファイルが読み込まれていません';

    initPreview();
    showPreviewMesh(originalMesh, 'before');
    log(`解析完了: 頂点 ${(originalMesh.positions.length/3).toLocaleString()} / 面 ${(originalMesh.faces.length/3).toLocaleString()}`, 'log-ok');
  }

  /* ---------- glTF/GLB folder import: merge scene.gltf + scene.bin + textures into one mesh ---------- */
  async function handleGltfFolder(files, gltfFile, glbFile){
    fileItems.innerHTML = '';
    files.forEach(f => {
      const ext = f.name.split('.').pop().toUpperCase();
      const div = document.createElement('div');
      div.className = 'file-item';
      div.innerHTML = `<span><span class="badge">${ext}</span>${f.webkitRelativePath || f.name}</span><span>${(f.size/1024/1024).toFixed(1)} MB</span>`;
      fileItems.appendChild(div);
    });
    fileList.classList.add('visible');

    rawFiles = { obj:null, mtl:null, textures: files.filter(f => /\.(png|jpe?g)$/i.test(f.name)), gltfFiles: files };

    log(`読み込み: ${gltfFile ? gltfFile.name : glbFile.name}（フォルダ一式 ${files.length} 個のファイル）`, 'log-info');
    setProgress('解析中 / Parsing glTF', 0);

    try {
      // Build a blob URL map so THREE.GLTFLoader can resolve scene.bin / texture URIs by filename
      const urlMap = new Map();
      files.forEach(f => {
        const url = URL.createObjectURL(f);
        urlMap.set(f.name, url);
        if (f.webkitRelativePath) {
          const parts = f.webkitRelativePath.split('/');
          for (let i = 1; i < parts.length; i++) urlMap.set(parts.slice(i).join('/'), url);
        }
      });

      const manager = new THREE.LoadingManager();
      manager.setURLModifier(url => {
        const decoded = decodeURIComponent(url).replace(/\\/g, '/');
        const fname = decoded.split('/').pop();
        return urlMap.get(decoded) || urlMap.get(fname) || url;
      });

      const loader = new THREE.GLTFLoader(manager);
      const rootUrl = URL.createObjectURL(gltfFile || glbFile);

      const gltf = await new Promise((resolve, reject) => loader.load(rootUrl, resolve, undefined, reject));

      // Merge all meshes in the scene into one positions/faces buffer
      const positions = [], faces = [];
      let vOffset = 0;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(obj3d => {
        if (!obj3d.isMesh || !obj3d.geometry) return;
        const geo = obj3d.geometry;
        const posAttr = geo.attributes.position;
        if (!posAttr) return;
        const m = obj3d.matrixWorld;
        const v3 = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i++) {
          v3.fromBufferAttribute(posAttr, i).applyMatrix4(m);
          positions.push(v3.x, v3.y, v3.z);
        }
        if (geo.index) {
          for (let i = 0; i < geo.index.count; i++) faces.push(geo.index.array[i] + vOffset);
        } else {
          for (let i = 0; i < posAttr.count; i++) faces.push(i + vOffset);
        }
        vOffset += posAttr.count;
      });

      if (positions.length === 0) throw new Error('メッシュデータが見つかりませんでした');

      originalMesh = {
        positions: new Float32Array(positions),
        faces: new Uint32Array(faces),
        uvs: [], faceUV: [],
        hasTexture: false
      };
      fixedMesh = null;

      // Fake an "obj" reference so save functions keep working (baseName only)
      const baseName = (gltfFile || glbFile).name.replace(/\.(gltf|glb)$/i,'');
      rawFiles.obj = { name: baseName + '.obj' };

      convertBtn.disabled = false;
      resetBtn.disabled = true;
      [saveObjBtn, saveGlbBtn, saveUsdzBtn].forEach(b => b.disabled = false);
      saveObjTexBtn.disabled = true;
      saveObjTexBtn.title = 'glTF取り込みではテクスチャ付きOBJ出力は未対応です';

      initPreview();
      showPreviewMesh(originalMesh, 'before');
      setProgress('完了', 100);
      log(`glTF解析完了: 頂点 ${(originalMesh.positions.length/3).toLocaleString()} / 面 ${(originalMesh.faces.length/3).toLocaleString()}`, 'log-ok');
    } catch (err) {
      log('glTF読み込みエラー: ' + err.message, 'log-err');
      console.error(err);
    }
  }

function showSizeWarning(fileSizeMB, estF){
  let msg = '', color = null;
  if (estF > HARD_FACE_COUNT) {
    msg = `⚠ 約${estF.toLocaleString()}面と非常に大規模です。処理・保存に時間がかかります。「5. 保存」の「分割出力」を使うことをおすすめします。`;
    color = { bg:'#3a1420', border:'#a13544', text:'#f9a8b8' };
    chunkedOutputEl.checked = true;
    chunkedOpts.style.display = 'block';
  } else if (estF > WARN_FACE_COUNT || fileSizeMB > 60) {
    msg = `約${estF.toLocaleString()}面（${fileSizeMB.toFixed(1)}MB）です。処理に少し時間がかかる場合があります。`;
    color = { bg:'#3a2a12', border:'#8a5a1e', text:'#fbbf24' };
  }
  if (msg) {
    warnBanner.textContent = msg;
    warnBanner.style.background = color.bg;
    warnBanner.style.border = '1px solid ' + color.border;
    warnBanner.style.color = color.text;
    warnBanner.classList.add('visible');
  } else {
    warnBanner.classList.remove('visible');
  }
}

/* ==========================================================================
   OBJ PARSE / EXPORT
   ========================================================================== */
async function parseOBJ(text, onProgress){
  const positions = [], uvs = [], faces = [], faceUV = [];
  const lines = text.split('\n');
  const total = lines.length;
  const CHUNK = 20000;
  for (let i=0;i<total;i++){
    const line = lines[i];
    if (line.length < 2) continue;
    const c0 = line.charCodeAt(0), c1 = line.charCodeAt(1);
    if (c0===118 && c1===32) { // v
      const p = line.split(/\s+/);
      positions.push(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]));
    } else if (c0===118 && c1===116) { // vt
      const p = line.split(/\s+/);
      uvs.push(parseFloat(p[1]), parseFloat(p[2] || 0));
    } else if (c0===102 && c1===32) { // f
      const p = line.split(/\s+/);
      const idx = [], uvIdx = [];
      for (let k=1;k<p.length;k++){
        if (!p[k]) continue;
        const parts = p[k].split('/');
        let vi = parseInt(parts[0],10);
        if (vi < 0) vi = positions.length/3 + vi + 1;
        idx.push(vi-1);
        if (parts[1]) {
          let ti = parseInt(parts[1],10);
          if (ti < 0) ti = uvs.length/2 + ti + 1;
          uvIdx.push(ti-1);
        } else uvIdx.push(-1);
      }
      for (let k=1;k<idx.length-1;k++){
        faces.push(idx[0], idx[k], idx[k+1]);
        faceUV.push(uvIdx[0], uvIdx[k], uvIdx[k+1]);
      }
    }
    if (i % CHUNK === 0) { onProgress && onProgress(i/total*100); await yieldFrame(); }
  }
  return {
    positions: new Float32Array(positions),
    faces: new Uint32Array(faces),
    uvs: new Float32Array(uvs),
    faceUV: new Int32Array(faceUV)
  };
}

async function exportOBJText(mesh, onProgress){
  const { positions, faces } = mesh;
  const vCount = positions.length/3, triCount = faces.length/3;
  const parts = ['# Fixed with RealityScan Mesh Fixer\n'];
  const CHUNK = 30000;
  let buf = '';
  for (let i=0;i<vCount;i++){
    buf += 'v ' + positions[i*3].toFixed(6) + ' ' + positions[i*3+1].toFixed(6) + ' ' + positions[i*3+2].toFixed(6) + '\n';
    if (i % CHUNK === 0) { parts.push(buf); buf=''; onProgress && onProgress(i/(vCount+triCount)*100); await yieldFrame(); }
  }
  parts.push(buf); buf='';
  for (let t=0;t<triCount;t++){
    buf += 'f ' + (faces[t*3]+1) + ' ' + (faces[t*3+1]+1) + ' ' + (faces[t*3+2]+1) + '\n';
    if (t % CHUNK === 0) { parts.push(buf); buf=''; onProgress && onProgress((vCount+t)/(vCount+triCount)*100); await yieldFrame(); }
  }
  parts.push(buf);
  return parts.join('');
}

/* ==========================================================================
   4. 形の仕上げ — core algorithms
   ========================================================================== */
async function weldVertices(mesh, dist, onProgress){
  const { positions, faces } = mesh;
  const vCount = positions.length/3;
  if (dist <= 0 || vCount === 0) return mesh;
  const cell = Math.max(dist, 1e-6);
  const grid = new Map();
  const key = (x,y,z) => x+'_'+y+'_'+z;
  const remap = new Int32Array(vCount).fill(-1);
  const newPositions = [];
  let newCount = 0;
  const CHUNK = 15000;
  for (let i=0;i<vCount;i++){
    const x=positions[i*3], y=positions[i*3+1], z=positions[i*3+2];
    const ix=Math.round(x/cell), iy=Math.round(y/cell), iz=Math.round(z/cell);
    let found = -1;
    for (let dx=-1;dx<=1 && found<0;dx++)
      for (let dy=-1;dy<=1 && found<0;dy++)
        for (let dz=-1;dz<=1 && found<0;dz++){
          const bucket = grid.get(key(ix+dx,iy+dy,iz+dz));
          if (!bucket) continue;
          for (const j of bucket){
            const dxp=newPositions[j*3]-x, dyp=newPositions[j*3+1]-y, dzp=newPositions[j*3+2]-z;
            if (dxp*dxp+dyp*dyp+dzp*dzp <= dist*dist) { found=j; break; }
          }
        }
    if (found >= 0) remap[i] = found;
    else {
      const j = newCount++;
      newPositions.push(x,y,z);
      remap[i] = j;
      const k = key(ix,iy,iz);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(j);
    }
    if (i % CHUNK === 0) { onProgress && onProgress(i/vCount*100); await yieldFrame(); }
  }
  const newFaces = new Uint32Array(faces.length);
  for (let i=0;i<faces.length;i++) newFaces[i] = remap[faces[i]];
  return { positions: new Float32Array(newPositions), faces: newFaces, weldedFrom: vCount, weldedTo: newCount, uvs: mesh.uvs, faceUV: mesh.faceUV };
}

async function removeSpikes(mesh, ratioThreshold, onProgress){
  const { positions, faces } = mesh;
  const triCount = faces.length/3;
  const keep = new Uint8Array(triCount).fill(1);
  let removed = 0;
  const CHUNK = 20000;
  const a=[0,0,0], b=[0,0,0], c=[0,0,0];
  function vec(i,out){ out[0]=positions[i*3]; out[1]=positions[i*3+1]; out[2]=positions[i*3+2]; }
  for (let t=0;t<triCount;t++){
    const ia=faces[t*3], ib=faces[t*3+1], ic=faces[t*3+2];
    vec(ia,a); vec(ib,b); vec(ic,c);
    const ab=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
    const bc=Math.hypot(b[0]-c[0],b[1]-c[1],b[2]-c[2]);
    const ca=Math.hypot(c[0]-a[0],c[1]-a[1],c[2]-a[2]);
    const longest=Math.max(ab,bc,ca), shortest=Math.max(1e-9,Math.min(ab,bc,ca));
    const s=(ab+bc+ca)/2;
    const areaSq=Math.max(0, s*(s-ab)*(s-bc)*(s-ca));
    const area=Math.sqrt(areaSq);
    const aspect=longest/shortest;
    const flatness=area/(longest*longest+1e-9);
    if (aspect > ratioThreshold && flatness < 0.02) { keep[t]=0; removed++; }
    if (t % CHUNK === 0) { onProgress && onProgress(t/triCount*100); await yieldFrame(); }
  }
  const newFaces = [];
  for (let t=0;t<triCount;t++) if (keep[t]) newFaces.push(faces[t*3],faces[t*3+1],faces[t*3+2]);
  return { positions: mesh.positions, faces: new Uint32Array(newFaces), spikesRemoved: removed, uvs: mesh.uvs, faceUV: mesh.faceUV };
}

async function keepLargestComponent(mesh, onProgress){
  const { positions, faces } = mesh;
  const vCount = positions.length/3;
  const parent = new Int32Array(vCount);
  for (let i=0;i<vCount;i++) parent[i]=i;
  function find(x){ while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];} return x; }
  function union(a,b){ a=find(a); b=find(b); if(a!==b) parent[a]=b; }
  const triCount = faces.length/3;
  const CHUNK = 20000;
  for (let t=0;t<triCount;t++){
    union(faces[t*3],faces[t*3+1]); union(faces[t*3+1],faces[t*3+2]);
    if (t % CHUNK === 0) { onProgress && onProgress(t/triCount*50); await yieldFrame(); }
  }
  const compSize = new Map();
  for (let i=0;i<vCount;i++){ const r=find(i); compSize.set(r,(compSize.get(r)||0)+1); }
  let bestRoot=-1, bestSize=-1;
  for (const [root,size] of compSize) if (size>bestSize){bestSize=size;bestRoot=root;}
  const keepVert = new Uint8Array(vCount);
  for (let i=0;i<vCount;i++) if (find(i)===bestRoot) keepVert[i]=1;
  const remap = new Int32Array(vCount).fill(-1);
  const newPositions = []; let newCount=0;
  for (let i=0;i<vCount;i++) if (keepVert[i]) { remap[i]=newCount++; newPositions.push(positions[i*3],positions[i*3+1],positions[i*3+2]); }
  const newFaces=[]; let droppedFaces=0;
  for (let t=0;t<triCount;t++){
    const ia=faces[t*3],ib=faces[t*3+1],ic=faces[t*3+2];
    if (keepVert[ia]&&keepVert[ib]&&keepVert[ic]) newFaces.push(remap[ia],remap[ib],remap[ic]);
    else droppedFaces++;
    if (t % CHUNK === 0) { onProgress && onProgress(50+t/triCount*50); await yieldFrame(); }
  }
  return { positions: new Float32Array(newPositions), faces: new Uint32Array(newFaces),
    componentsFound: compSize.size, verticesDropped: vCount-newCount, facesDropped: droppedFaces };
}

async function taubinSmooth(mesh, iterations, onProgress){
  if (iterations <= 0) return mesh;
  const { positions, faces } = mesh;
  const vCount = positions.length/3;
  const neighborSets = Array.from({length:vCount}, () => new Set());
  const triCount = faces.length/3;
  for (let t=0;t<triCount;t++){
    const ia=faces[t*3],ib=faces[t*3+1],ic=faces[t*3+2];
    neighborSets[ia].add(ib); neighborSets[ia].add(ic);
    neighborSets[ib].add(ia); neighborSets[ib].add(ic);
    neighborSets[ic].add(ia); neighborSets[ic].add(ib);
  }
  const neighbors = neighborSets.map(s => Array.from(s));
  let pos = Float32Array.from(positions);
  const lambda=0.5, mu=-0.53;
  const CHUNK = 15000;
  async function pass(coeff){
    const next = Float32Array.from(pos);
    for (let i=0;i<vCount;i++){
      const nb = neighbors[i];
      if (!nb.length) continue;
      let sx=0,sy=0,sz=0;
      for (const j of nb){ sx+=pos[j*3]; sy+=pos[j*3+1]; sz+=pos[j*3+2]; }
      const ax=sx/nb.length, ay=sy/nb.length, az=sz/nb.length;
      next[i*3]=pos[i*3]+coeff*(ax-pos[i*3]);
      next[i*3+1]=pos[i*3+1]+coeff*(ay-pos[i*3+1]);
      next[i*3+2]=pos[i*3+2]+coeff*(az-pos[i*3+2]);
      if (i % CHUNK === 0) await yieldFrame();
    }
    pos = next;
  }
  for (let it=0; it<iterations; it++){
    await pass(lambda); await pass(mu);
    onProgress && onProgress((it+1)/iterations*100);
    await yieldFrame();
  }
  return { positions: pos, faces, uvs: mesh.uvs, faceUV: mesh.faceUV };
}

/* Lowpoly: quadric-ish edge collapse approximation via vertex clustering.
   degree 0..1 controls grid cell size relative to bounding box diagonal. */
async function lowpolyReduce(mesh, degree, style, onProgress){
  if (degree <= 0) return mesh;
  const { positions, faces } = mesh;
  const vCount = positions.length/3;
  let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for (let i=0;i<vCount;i++){
    const x=positions[i*3],y=positions[i*3+1],z=positions[i*3+2];
    if(x<minX)minX=x; if(x>maxX)maxX=x;
    if(y<minY)minY=y; if(y>maxY)maxY=y;
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z;
  }
  const diag = Math.hypot(maxX-minX, maxY-minY, maxZ-minZ) || 1;
  // degree 0.2 -> fine grid (subtle), degree 0.75 -> coarse grid (strong lowpoly)
  const cell = diag * (0.004 + degree*0.05);

  const effectiveCell = style === 'sphere' ? cell * 0.4 : cell; // sphere: finer grid, keep more vertices for smooth curvature
  const cellOf = (x,y,z) => {
    let ix = Math.round(x/effectiveCell), iy = Math.round(y/effectiveCell), iz = Math.round(z/effectiveCell);
    if (style === 'cube') { /* snap harder to axis grid -> blockier */ }
    if (style === 'crystal') { ix = Math.round(ix/2)*2; iz = Math.round(iz/2)*2; }
    return ix+'_'+iy+'_'+iz;
  };

  const clusterMap = new Map();
  const clusterOf = new Int32Array(vCount);
  const clusterSum = []; const clusterCount = [];
  const CHUNK = 20000;
  for (let i=0;i<vCount;i++){
    const x=positions[i*3],y=positions[i*3+1],z=positions[i*3+2];
    const k = cellOf(x,y,z);
    let cIdx = clusterMap.get(k);
    if (cIdx === undefined) {
      cIdx = clusterSum.length/3;
      clusterMap.set(k, cIdx);
      clusterSum.push(x,y,z);
      clusterCount.push(1);
    } else {
      clusterSum[cIdx*3]+=x; clusterSum[cIdx*3+1]+=y; clusterSum[cIdx*3+2]+=z;
      clusterCount[cIdx]++;
    }
    clusterOf[i] = cIdx;
    if (i % CHUNK === 0) { onProgress && onProgress(i/vCount*60); await yieldFrame(); }
  }
  const newPositions = [];
  for (let c=0;c<clusterCount.length;c++){
    newPositions.push(clusterSum[c*3]/clusterCount[c], clusterSum[c*3+1]/clusterCount[c], clusterSum[c*3+2]/clusterCount[c]);
  }

  const triCount = faces.length/3;
  const newFaces = [];
  const seen = new Set();
  for (let t=0;t<triCount;t++){
    const a=clusterOf[faces[t*3]], b=clusterOf[faces[t*3+1]], c=clusterOf[faces[t*3+2]];
    if (a===b || b===c || a===c) continue; // degenerate after clustering
    const keyArr = [a,b,c].slice().sort((x,y)=>x-y);
    const key = style==='chamfer' ? (a+'_'+b+'_'+c) : keyArr.join('_'); // chamfer keeps orientation duplicates (more faceted look)
    if (seen.has(key) && style !== 'chamfer') continue;
    seen.add(key);
    newFaces.push(a,b,c);
    if (t % CHUNK === 0) { onProgress && onProgress(60 + t/triCount*40); await yieldFrame(); }
  }

  let resultMesh = {
    positions: new Float32Array(newPositions),
    faces: new Uint32Array(newFaces),
    lowpolyFrom: vCount, lowpolyTo: clusterCount.length
  };

  if (style === 'sphere') {
    // Extra rounding pass: keeps the higher vertex count but relaxes faceting into smooth curvature
    const roundIterations = 2 + Math.round(degree * 3);
    resultMesh = await taubinSmooth(resultMesh, roundIterations, () => {});
    resultMesh.lowpolyFrom = vCount;
    resultMesh.lowpolyTo = clusterCount.length;
  }

  return resultMesh;
}

/* ==========================================================================
   MAIN "自動補正を実行" PIPELINE
   ========================================================================== */
convertBtn.addEventListener('click', async () => {
  if (!originalMesh) return;
  logBox.innerHTML = ''; logBox.classList.add('visible');
  statsBox.classList.remove('visible');
  convertBtn.disabled = true;
  const t0 = performance.now();

  const weldDist = weldDistMeters();
  const spikeRatio = parseFloat(spikeRatioEl.value);
  const smoothIter = parseInt(smoothIterEl.value,10);
  const keepLargest = keepLargestEl.checked;

  try {
    let mesh = { positions: originalMesh.positions, faces: originalMesh.faces, uvs: originalMesh.uvs, faceUV: originalMesh.faceUV };
    const origV = mesh.positions.length/3, origF = mesh.faces.length/3;

    if (weldDist > 0) {
      setProgress('分裂オブジェクトを結合中', 0);
      mesh = await weldVertices(mesh, weldDist, p => setProgress('分裂オブジェクトを結合中', p));
      log(`頂点結合: ${mesh.weldedFrom.toLocaleString()} → ${mesh.weldedTo.toLocaleString()}`, 'log-ok');
    }

    setProgress('針状面を除去中', 0);
    mesh = await removeSpikes(mesh, spikeRatio, p => setProgress('針状面を除去中', p));
    log(`針状の三角形を ${mesh.spikesRemoved.toLocaleString()} 個 除去`, 'log-ok');

    if (keepLargest) {
      setProgress('分裂断片を除去中', 0);
      const res = await keepLargestComponent(mesh, p => setProgress('分裂断片を除去中', p));
      mesh = res;
      log(`最大コンポーネントのみ保持（除去: 頂点${res.verticesDropped.toLocaleString()} / 面${res.facesDropped.toLocaleString()}）`, 'log-ok');
    }

    if (smoothIter > 0) {
      setProgress('平滑化中', 0);
      mesh = await taubinSmooth(mesh, smoothIter, p => setProgress('平滑化中', p));
      log(`平滑化を ${smoothIter} 回 適用`, 'log-ok');
    }

    if (lowpolyDegree > 0) {
      setProgress('ローポリ化中', 0);
      mesh = await lowpolyReduce(mesh, lowpolyDegree, lowpolyStyle, p => setProgress('ローポリ化中', p));
      log(`ローポリ化: 頂点 ${mesh.lowpolyFrom.toLocaleString()} → ${mesh.lowpolyTo.toLocaleString()}（スタイル: ${lowpolyStyle}）`, 'log-ok');
    }

    fixedMesh = mesh;
    const finalV = mesh.positions.length/3, finalF = mesh.faces.length/3;
    const elapsed = ((performance.now()-t0)/1000).toFixed(1);
    setProgress('完了', 100);
    log(`完了しました（${elapsed}秒）。`, 'log-ok');

    statsBox.innerHTML = `<b>頂点:</b> ${origV.toLocaleString()} → ${finalV.toLocaleString()}<br>` +
      `<b>面:</b> ${origF.toLocaleString()} → ${finalF.toLocaleString()}<br><b>処理時間:</b> ${elapsed}秒`;
    statsBox.classList.add('visible');

    resetBtn.disabled = false;
    showPreviewMesh(fixedMesh, 'after');
    setActiveTab('after');
    previewWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });

  } catch (err) {
    log('エラー: ' + err.message, 'log-err');
    console.error(err);
  } finally {
    convertBtn.disabled = false;
  }
});

resetBtn.addEventListener('click', () => {
  fixedMesh = null;
  statsBox.classList.remove('visible');
  resetBtn.disabled = true;
  showPreviewMesh(originalMesh, 'before');
  setActiveTab('before');
  log('補正前の状態に戻しました。', 'log-info');
});

/* ==========================================================================
   PREVIEW (three.js)
   ========================================================================== */
let scene, camera, renderer, currentObject, controlsState = {};
function initPreview(){
  previewEmptyWrap.classList.remove('visible');
  previewWrap.classList.add('visible');
  if (renderer) return; // already initialized

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x08080c);
  camera = new THREE.PerspectiveCamera(45, previewCanvas.clientWidth/280, 0.001, 1000);
  renderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio||1));
  resizeRenderer();

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(2,3,4);
  scene.add(dir);

  let dragging=false, lastX=0, lastY=0;
  let rotX=0.3, rotY=0.6, dist=3;
  controlsState = { rotX, rotY, dist };

  previewCanvas.addEventListener('pointerdown', e => { dragging=true; lastX=e.clientX; lastY=e.clientY; });
  window.addEventListener('pointerup', () => dragging=false);
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    controlsState.rotY += (e.clientX-lastX)*0.008;
    controlsState.rotX += (e.clientY-lastY)*0.008;
    controlsState.rotX = Math.max(-1.4, Math.min(1.4, controlsState.rotX));
    lastX=e.clientX; lastY=e.clientY;
  });
  previewCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    controlsState.dist = Math.max(0.5, Math.min(20, controlsState.dist + e.deltaY*0.002));
  }, { passive:false });

  function animate(){
    requestAnimationFrame(animate);
    const { rotX, rotY, dist } = controlsState;
    camera.position.set(Math.sin(rotY)*Math.cos(rotX)*dist, Math.sin(rotX)*dist, Math.cos(rotY)*Math.cos(rotX)*dist);
    camera.lookAt(0,0,0);
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', resizeRenderer);
}
function resizeRenderer(){
  if (!renderer) return;
    const isFs = previewWrap.classList.contains('fullscreen');
    const w = previewCanvas.clientWidth || 300, h = isFs ? window.innerHeight : 280; 
     renderer.setSize(w, h, false);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}

function showPreviewMesh(mesh, mode){
  if (!scene) return;
  if (currentObject) { scene.remove(currentObject); currentObject.geometry.dispose(); currentObject.material.dispose(); }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.faces, 1));
  geo.computeVertexNormals();
  geo.center();

  // Normalize scale to fit view
  geo.computeBoundingSphere();
  const scale = geo.boundingSphere ? 1.2 / (geo.boundingSphere.radius || 1) : 1;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x9b8cf0, metalness:0.05, roughness:0.7,
    wireframe: wireframeOn, flatShading: true
  });
  currentObject = new THREE.Mesh(geo, mat);
  currentObject.scale.setScalar(scale);
  scene.add(currentObject);

  previewMode = mode;
  previewStats.textContent = `頂点 ${(mesh.positions.length/3).toLocaleString()} / 面 ${(mesh.faces.length/3).toLocaleString()}`;
}

function setActiveTab(mode){
  tabBefore.classList.toggle('active', mode==='before');
  tabAfter.classList.toggle('active', mode==='after');
}
tabBefore.addEventListener('click', () => { if (originalMesh) { showPreviewMesh(originalMesh,'before'); setActiveTab('before'); } });
tabAfter.addEventListener('click', () => {
  if (fixedMesh) { showPreviewMesh(fixedMesh,'after'); setActiveTab('after'); }
  else log('先に「自動補正を実行」を押してください。', 'log-warn');
});
wireToggle.addEventListener('click', () => {
  wireframeOn = !wireframeOn;
  wireToggle.classList.toggle('active', wireframeOn);
  if (currentObject) currentObject.material.wireframe = wireframeOn;
});

    fullscreenBtn.addEventListener('click', () => {
      const isFs = previewWrap.classList.toggle('fullscreen');
      fullscreenBtn.classList.toggle('active', isFs);
      fullscreenBtn.textContent = isFs ? '✕ 閉じる' : '⛶ 拡大';
      resizeRenderer();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && previewWrap.classList.contains('fullscreen')) {
        previewWrap.classList.remove('fullscreen');
        fullscreenBtn.classList.remove('active');
        fullscreenBtn.textContent = '⛶ 拡大';
        resizeRenderer();
      }
    });
resetViewBtn.addEventListener('click', () => {
  controlsState.rotX = 0.3;
  controlsState.rotY = 0.6;
  controlsState.dist = 3;
});
const ZOOM_MIN = 0.15, ZOOM_MAX = 20, ZOOM_STEP = 0.82;
function applyZoom(factor){
  controlsState.dist = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, controlsState.dist * factor));
}
zoomInBtn.addEventListener('click', () => applyZoom(ZOOM_STEP));
zoomOutBtn.addEventListener('click', () => applyZoom(1 / ZOOM_STEP));

/* ==========================================================================
   5. 保存 — export in multiple formats, with optional chunked split
   ========================================================================== */
function activeMeshForSave(){ return fixedMesh || originalMesh; }

function splitFacesIntoChunks(mesh, targetFaces){
  const triCount = mesh.faces.length/3;
  const numChunks = Math.max(1, Math.ceil(triCount/targetFaces));
  const chunks = [];
  const perChunk = Math.ceil(triCount/numChunks);
  for (let c=0;c<numChunks;c++){
    const startTri = c*perChunk, endTri = Math.min(triCount, startTri+perChunk);
    if (startTri>=endTri) continue;
    const usedVerts = new Map();
    const newPositions = [], newFaces = [];
    for (let t=startTri;t<endTri;t++){
      const tri=[mesh.faces[t*3],mesh.faces[t*3+1],mesh.faces[t*3+2]];
      const localTri=[];
      for (const vi of tri){
        if (!usedVerts.has(vi)){
          usedVerts.set(vi, newPositions.length/3);
          newPositions.push(mesh.positions[vi*3], mesh.positions[vi*3+1], mesh.positions[vi*3+2]);
        }
        localTri.push(usedVerts.get(vi));
      }
      newFaces.push(...localTri);
    }
    chunks.push({ positions: new Float32Array(newPositions), faces: new Uint32Array(newFaces) });
  }
  return chunks;
}

function downloadBlob(blob, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function saveAsOBJ(){
  const mesh = activeMeshForSave();
  if (!mesh) return;
  saveLogBox.innerHTML = '';
  const baseName = rawFiles.obj ? rawFiles.obj.name.replace(/\.obj$/i,'') : 'model';

  if (chunkedOutputEl.checked) {
    const targetFaces = parseInt(chunkFaceCountEl.value,10);
    const chunks = splitFacesIntoChunks(mesh, targetFaces);
    chunkList.innerHTML = '';
    saveLog(`${chunks.length} 個のファイルに分割して出力します。`, 'log-info');
    for (let i=0;i<chunks.length;i++){
      const text = await exportOBJText(chunks[i], ()=>{});
      const blob = new Blob([text], { type:'text/plain' });
      const name = `${baseName}_part${String(i+1).padStart(2,'0')}.obj`;
      const item = document.createElement('div');
      item.className = 'chunk-item';
      item.innerHTML = `<span>${name}（面 ${(chunks[i].faces.length/3).toLocaleString()}）</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'ダウンロード';
      btn.addEventListener('click', () => downloadBlob(blob, name));
      item.appendChild(btn);
      chunkList.appendChild(item);
    }
    saveLog('すべてのファイルを個別にダウンロードしてください。「6. 分割ファイルの統合」で後から1つに戻せます。', 'log-ok');
  } else {
    const text = await exportOBJText(mesh, ()=>{});
    downloadBlob(new Blob([text], {type:'text/plain'}), baseName + '_fixed.obj');
    saveLog('OBJを保存しました。', 'log-ok');
  }
}

async function saveAsOBJWithTexture(){
  const mesh = activeMeshForSave();
  if (!mesh || !rawFiles.mtl) { saveLog('テクスチャファイルが見つかりません。', 'log-warn'); return; }
  saveLogBox.innerHTML = '';
  saveLog('テクスチャ付きOBJをZIPにまとめています...', 'log-info');
  const baseName = rawFiles.obj.name.replace(/\.obj$/i,'');
  const zip = new JSZip();
  const objText = await exportOBJText(mesh, ()=>{});
  zip.file(baseName + '_fixed.obj', objText);
  zip.file(rawFiles.mtl.name, await rawFiles.mtl.text());
  for (const tex of rawFiles.textures) {
    zip.file(tex.name, await tex.arrayBuffer());
  }
  const blob = await zip.generateAsync({ type:'blob' });
  downloadBlob(blob, baseName + '_fixed_textured.zip');
  saveLog('テクスチャ付きOBJ(.zip)を保存しました。', 'log-ok');
}

async function saveAsGLB(){
  const mesh = activeMeshForSave();
  if (!mesh) return;
  saveLogBox.innerHTML = '';
  saveLog('GLBを生成しています...', 'log-info');
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.faces, 1));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness:0.8 });
  const meshObj = new THREE.Mesh(geo, mat);
  const exporter = new THREE.GLTFExporter();
  try {
    exporter.parse(meshObj, (result) => {
      const blob = new Blob([result], { type:'application/octet-stream' });
      const baseName = rawFiles.obj ? rawFiles.obj.name.replace(/\.obj$/i,'') : 'model';
      downloadBlob(blob, baseName + '_fixed.glb');
      saveLog('GLBを保存しました。', 'log-ok');
    }, { binary: true }); // 3引数構成に修正
  } catch (err) {
    saveLog('GLB生成エラー: ' + err.message, 'log-err');
  }
}

async function saveAsUSDZ(){
  saveLogBox.innerHTML = '';
  saveLog('USDZ書き出しは試験的機能です。まずGLBを生成し、iPadのクイックルックで変換する方法をご案内します。', 'log-warn');
  saveLog('現バージョンではUSDZの直接書き出しは未対応です。GLB保存 → 「ファイル」アプリでAR QuickLook経由の変換、または他のUSDZ変換ツールをご利用ください。', 'log-info');
}

saveObjBtn.addEventListener('click', saveAsOBJ);
saveObjTexBtn.addEventListener('click', saveAsOBJWithTexture);
saveGlbBtn.addEventListener('click', saveAsGLB);
saveUsdzBtn.addEventListener('click', saveAsUSDZ);

/* ==========================================================================
   6. MERGE TOOL (kept from previous version)
   ========================================================================== */
const mergeDropZone = document.getElementById('mergeDropZone');
const mergeFileInput= document.getElementById('mergeFileInput');
const mergeFileList = document.getElementById('mergeFileList');
const mergeFileItems= document.getElementById('mergeFileItems');
const mergeBtn = document.getElementById('mergeBtn');
const mergeLogBox = document.getElementById('mergeLogBox');
const mergeStats = document.getElementById('mergeStats');
const mergeDownloadBtn = document.getElementById('mergeDownloadBtn');
const mergeProgressWrap = document.getElementById('mergeProgressWrap');
const mergeProgressFill = document.getElementById('mergeProgressFill');
const mergeProgressPct  = document.getElementById('mergeProgressPct');
const mergeProgressStage= document.getElementById('mergeProgressStage');
const mergeWeldDistEl = document.getElementById('mergeWeldDist');
const mergeWeldDistVal= document.getElementById('mergeWeldDistVal');

let mergeSelectedFiles = [];
let mergeResultBlob = null;

function mergeWeldMeters(){ return mergeWeldDistEl.value/10000; }
mergeWeldDistEl.addEventListener('input', () => mergeWeldDistVal.textContent = mergeWeldMeters().toFixed(4));
mergeWeldDistVal.textContent = mergeWeldMeters().toFixed(4);

['dragover'].forEach(ev => mergeDropZone.addEventListener(ev, e => { e.preventDefault(); mergeDropZone.classList.add('drag-over'); }));
mergeDropZone.addEventListener('dragleave', () => mergeDropZone.classList.remove('drag-over'));
mergeDropZone.addEventListener('drop', e => {
  e.preventDefault(); mergeDropZone.classList.remove('drag-over');
  handleMergeFiles(Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.obj')));
});
mergeFileInput.addEventListener('change', () => handleMergeFiles(Array.from(mergeFileInput.files)));

function handleMergeFiles(files){
  mergeSelectedFiles = files;
  mergeFileItems.innerHTML = '';
  files.forEach(f => {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `<span>${f.name}</span><span>${(f.size/1024/1024).toFixed(1)} MB</span>`;
    mergeFileItems.appendChild(div);
  });
  mergeFileList.classList.toggle('visible', files.length>0);
  mergeBtn.disabled = files.length < 2;
}

function mergeLog(msg, cls='log-info'){
  const l=document.createElement('div'); l.className=cls; l.textContent=msg;
  mergeLogBox.appendChild(l); mergeLogBox.scrollTop=mergeLogBox.scrollHeight; mergeLogBox.classList.add('visible');
}
function setMergeProgress(stage, pct){
  mergeProgressWrap.classList.add('visible');
  mergeProgressStage.textContent = stage;
  mergeProgressPct.textContent = Math.round(pct)+'%';
  mergeProgressFill.style.width = Math.min(100,Math.max(0,pct))+'%';
}

async function removeDuplicateFaces(mesh, onProgress){
  const { positions, faces } = mesh;
  const triCount = faces.length/3;
  const seen = new Set();
  const newFaces = [];
  let dup=0;
  const CHUNK=20000;
  for (let t=0;t<triCount;t++){
    const idx=[faces[t*3],faces[t*3+1],faces[t*3+2]].slice().sort((a,b)=>a-b);
    const key = idx.join('_');
    if (seen.has(key)) dup++;
    else { seen.add(key); newFaces.push(faces[t*3],faces[t*3+1],faces[t*3+2]); }
    if (t % CHUNK === 0) { onProgress && onProgress(t/triCount*100); await yieldFrame(); }
  }
  return { positions, faces: new Uint32Array(newFaces), duplicatesRemoved: dup };
}

mergeBtn.addEventListener('click', async () => {
  mergeLogBox.innerHTML=''; mergeLogBox.classList.add('visible');
  mergeStats.classList.remove('visible');
  mergeDownloadBtn.style.display = 'none';
  mergeBtn.disabled = true;
  const t0 = performance.now();
  try {
    let allPositions=[], allFaces=[], vOffset=0;
    for (let i=0;i<mergeSelectedFiles.length;i++){
      const f = mergeSelectedFiles[i];
      setMergeProgress(`読み込み中 (${i+1}/${mergeSelectedFiles.length})`, i/mergeSelectedFiles.length*40);
      const text = await f.text();
      const m = await parseOBJ(text, ()=>{});
      const vCount = m.positions.length/3;
      for (let k=0;k<m.positions.length;k++) allPositions.push(m.positions[k]);
      for (let k=0;k<m.faces.length;k++) allFaces.push(m.faces[k]+vOffset);
      vOffset += vCount;
      mergeLog(`読み込み完了: ${f.name}（頂点 ${vCount.toLocaleString()}）`, 'log-ok');
      await yieldFrame();
    }
    let mesh = { positions: new Float32Array(allPositions), faces: new Uint32Array(allFaces) };
    const weldDist = mergeWeldMeters();
    setMergeProgress('境界を結合中', 0);
    mesh = await weldVertices(mesh, weldDist, p => setMergeProgress('境界を結合中', 40+p*0.4));
    mergeLog(`境界溶接: ${mesh.weldedFrom.toLocaleString()} → ${mesh.weldedTo.toLocaleString()}`, 'log-ok');
    setMergeProgress('重複面を除去中', 80);
    mesh = await removeDuplicateFaces(mesh, p => setMergeProgress('重複面を除去中', 80+p*0.1));
    mergeLog(`重複面を ${mesh.duplicatesRemoved.toLocaleString()} 個 除去`, 'log-ok');
    setMergeProgress('書き出し中', 90);
    const text = await exportOBJText(mesh, p => setMergeProgress('書き出し中', 90+p*0.1));
    mergeResultBlob = new Blob([text], { type:'text/plain' });

    const elapsed = ((performance.now()-t0)/1000).toFixed(1);
    setMergeProgress('完了', 100);
    mergeLog(`統合完了（${elapsed}秒）。`, 'log-ok');
    mergeStats.innerHTML = `<b>統合後頂点:</b> ${(mesh.positions.length/3).toLocaleString()}<br><b>統合後面:</b> ${(mesh.faces.length/3).toLocaleString()}<br><b>処理時間:</b> ${elapsed}秒`;
    mergeStats.classList.add('visible');
    mergeDownloadBtn.style.display = 'block';
  } catch (err) {
    mergeLog('エラー: ' + err.message, 'log-err');
    console.error(err);
  } finally {
    mergeBtn.disabled = false;
  }
});

mergeDownloadBtn.addEventListener('click', () => {
  if (!mergeResultBlob) return;
  downloadBlob(mergeResultBlob, 'merged_model.obj');
});
