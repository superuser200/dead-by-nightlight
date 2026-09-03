/* Client load + player-creation regression test (headless).
 *
 * The server smoke suite can't catch client-side regressions. This loads the
 * real public/client.js in a sandboxed vm with minimal browser/THREE stubs and
 * asserts:
 *   1. The whole script initializes WITHOUT throwing (catches e.g. a
 *      ReferenceError on an undeclared global like 'pickedOutfit' that would
 *      abort the client at load -> "can't move / can't be seen").
 *   2. ensurePlayer() builds BOTH a survivor and a killer mesh without throwing
 *      (catches the missing makeNameSprite 'name' regression).
 *   3. ifMenu() applies a match state with items/keys/gens/gates without throwing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');

const listeners = {};
const els = {};
function makeEl(id) {
  return {
    id, style: {}, textContent: '', innerHTML: '', display: '', value: '', title: '',
    classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
    appendChild(){}, addEventListener(){}, remove(){}, focus(){}, blur(){},
    setAttribute(){}, closest(){ return null; }, querySelector(){ return makeEl(id+'_q'); },
    getContext(){ return { font:'', textAlign:'', textBaseline:'', fillStyle:'', fillText(){}, measureText(){ return {width:10}; } }; },
    width: 0, height: 0, offsetWidth: 0,
  };
}
const doc = {
  getElementById(id){ if(!els[id]) els[id]=makeEl(id); return els[id]; },
  createElement(tag){ return makeEl(tag); },
  addEventListener(t,f){ (listeners[t]=listeners[t]||[]).push(f); },
  activeElement: null, pointerLockElement: null,
  body: { requestPointerLock(){} },
  documentElement: {}, querySelector(){ return makeEl('qs'); }, querySelectorAll(){ return []; },
};
const THREE = (() => {
  function El3(){ this.children=[]; this.position={x:0,y:0,z:0,set(){},setScalar(){},lerp(){}}; this.rotation={x:0,y:0,z:0}; this.scale={x:1,y:1,z:1,set(){},setScalar(){}}; this.visible=true; this.material={color:{setHex(){}},transparent:false}; this.userData={}; }
  El3.prototype.add=function(){ for(const a of arguments) this.children.push(a); return this; };
  El3.prototype.remove=function(){};
  El3.prototype.clone=function(){ return new El3(); };
  function mat(){ this.color = { setHex(){} }; this.transparent = false; this.map = null; }
  return {
    Group: El3, Mesh: El3, Sprite: El3,
    PlaneGeometry: function(){}, BoxGeometry: function(){}, CylinderGeometry: function(){},
    SphereGeometry: function(){}, TorusGeometry: function(){},
    MeshLambertMaterial: mat, MeshBasicMaterial: mat,
    SpriteMaterial: function(){ this.map = null; }, CanvasTexture: function(){},
    Color: function(){ return { setHex(){} }; }, Vector3: function(){ return { lerp(){} }; },
    Fog: function(){}, PerspectiveCamera: function(){ return { updateProjectionMatrix(){} }; },
    HemisphereLight: function(){}, DirectionalLight: function(){}, AmbientLight: function(){},
    WebGLRenderer: function(){ return { setSize(){}, setPixelRatio(){}, render(){}, domElement: { width:0, height:0, getContext(){return null;} }, shadowMap:{ enabled:true } }; },
  };
})();
const sandbox = {
  document: doc, window: { addEventListener(t,f){ (listeners[t]=listeners[t]||[]).push(f); } },
  requestAnimationFrame: () => 0, performance: { now: () => 0 },
  THREE, location: { protocol:'https:', host:'x', href:'x' }, navigator: {},
  matchMedia: () => ({ matches:false }), innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  console: { log(){}, warn(){}, error(){}, info(){} },
  setTimeout: () => 0, clearTimeout: () => 0, setInterval: () => 0, clearInterval: () => 0,
  Math, JSON, Date, WebSocket: function(){ this.readyState = 0; },
  localStorage: { getItem(){ return null; }, setItem(){} },
};
vm.createContext(sandbox);

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name); } };

try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  ok('client.js loads without throwing', true);

  vm.runInContext("scene = new THREE.Group(); matchGroup = new THREE.Group(); matchState = 'match'; matchKillerId = 'umbra';", sandbox);
  vm.runInContext("ensurePlayer({ id:'s', name:'Sur', role:'survivor', outfit: 1 });", sandbox);
  ok('ensurePlayer builds a survivor mesh', true);
  vm.runInContext("ensurePlayer({ id:'k', name:'Kill', role:'killer' });", sandbox);
  ok('ensurePlayer builds a killer mesh (weapon/hair paths)', true);

  vm.runInContext(
    "matchMap = { items:[{id:'i0',type:'medkit',x:1,z:1,taken:false}], keys:[{id:'hatch',x:2,z:2,open:false}], gens:[{id:'g0',done:false,prog:0}], hooks:[], gates:[] }; ifMenu();",
    sandbox);
  ok('ifMenu applies match state with items/keys/gens without throwing', true);

  const kd = listeners['keydown'] || [];
  let moved = false;
  for (const f of kd) { try { f({ key:'w', preventDefault(){}, repeat:false }); moved = true; } catch (e) {} }
  ok('keydown handler runs without throwing', moved);

  if (src.indexOf('let pickedOutfit = 0;') >= 0) ok('pickedOutfit is declared', true);
  else ok('pickedOutfit is declared', false);
  if (src.indexOf('const name = makeNameSprite(p.name)') >= 0) ok("makeNameSprite 'name' assigned in ensurePlayer", true);
  else ok("makeNameSprite 'name' assigned in ensurePlayer", false);
} catch (e) {
  fail++;
  console.log('FAIL  client.js load/run threw: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0,5).join('\n'));
}

console.log(fail === 0 ? '\nCLIENT LOAD TEST OK' : '\nCLIENT LOAD TEST FAILED');
process.exit(fail === 0 ? 0 : 1);
