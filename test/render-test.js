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
    children: [], firstChild: null,
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
  ['translateX','translateY','translateZ','rotateX','rotateY','rotateZ','lookAt','scaleX','scaleY','scaleZ'].forEach(m => { El3.prototype[m]=function(){ return this; }; });
  function mat(){ this.color = { setHex(){} }; this.transparent = false; this.map = null; }
  const v3 = () => ({ x:0,y:0,z:0, set(){}, setScalar(){}, lerp(){}, clone(){ return v3(); } });
  return {
    Group: El3, Mesh: El3, Sprite: El3,
    PlaneGeometry: function(){}, BoxGeometry: function(){}, CylinderGeometry: function(){},
    SphereGeometry: function(){}, TorusGeometry: function(){}, ConeGeometry: function(){},
    TorusKnotGeometry: function(){}, RingGeometry: function(){}, BufferGeometry: function(){},
    MeshLambertMaterial: mat, MeshBasicMaterial: mat, SpriteMaterial: function(){ this.map=null; },
    CanvasTexture: function(){}, Color: function(){ return { setHex(){} }; }, Vector3: v3,
    Fog: function(){}, PerspectiveCamera: function(){ return { updateProjectionMatrix(){}, position: v3(), rotation: {x:0,y:0,z:0} }; },
    HemisphereLight: function(){}, DirectionalLight: function(){}, AmbientLight: function(){},
    WebGLRenderer: function(){ return { setSize(){}, setPixelRatio(){}, render(){}, domElement:{ width:0,height:0,getContext(){return null;} }, shadowMap:{enabled:true} }; },
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
let fail = 0;
const ok = (n,c,d) => { console.log((c?'PASS':'FAIL')+'  '+n+(d?'  ['+d+']':'')); if(!c) fail++; };

vm.runInContext(src, sandbox, { filename: 'client.js' });
ok('client.js loads', true);

// Build a matchView-shaped map identical to what server sends
const realMap = {
  id: 'M1', state: 'running', w: 90, theme: 'hollow', mapName: 'The Hollow',
  gens: [{id:'g0',x:-10,z:-10,prog:0,done:false},{id:'g1',x:10,z:10,prog:0,done:false}],
  gates: [{id:'A',x:0,z:43.8,dir:'north',zone:{rect:{x:-4,z:43.5,w:8,d:2.5}},open:false,prog:0},{id:'B',x:43.8,z:0,dir:'east',zone:{rect:{x:43.5,z:-4,w:2.5,d:8}},open:false,prog:0}],
  hooks: [{x:5,z:5},{x:-5,z:6}],
  walls: [{x:-20,z:-8,w:7,d:0.8,h:1.7},{x:22,z:14,w:0.8,d:7,h:1.7}],
  power: {x:4,z:4,on:false,prog:0},
  gensDone: 0, gensReady: false, gatesPowered: false, clock: 240, killerId: 'umbra',
  items: [{id:'i0',type:'medkit',name:'Medkit',x:1,z:1,taken:false}],
  keys: [{id:'hatch',x:2,z:2,open:false}],
};
vm.runInContext("scene = new THREE.Group(); matchState='hub'; matchKillerId='umbra'; my={};", sandbox);
vm.runInContext("matchMap=" + JSON.stringify(realMap) + "; handle({t:'matchStart', match:{role:'survivor', killerId:'umbra', map:matchMap}});", sandbox);
ok('matchStart renders (enterMatch with walls+power)', true);

const players = [
  {id:'ME',name:'Me',role:'survivor',x:0,y:0,z:0,yaw:0,outfit:1,item:null,hp:2,status:'alive'},
  {id:'K',name:'Kill',role:'killer',x:3,y:0,z:3,yaw:0,outfit:0,item:null,hp:2,status:'alive'},
];
for (let i=0;i<5;i++) {
  vm.runInContext("matchMap=" + JSON.stringify(realMap) + "; handle({t:'state', type:'match', id:'M1', state:'running', map:matchMap, players:" + JSON.stringify(players) + "});", sandbox);
}
const nAfter = vm.runInContext("playerMeshes ? playerMeshes.size : -1", sandbox);
const diag = vm.runInContext("({mp: matchPlayers ? matchPlayers.length : -1, st: matchState, self: selfId})", sandbox);
console.log('  diag:', JSON.stringify(diag));
const n = nAfter;
ok('player bodies created after state frames (2)', n === 2, 'playerMeshes.size=' + n);

// powered gates render fine
const realMap2 = Object.assign({}, realMap, { gatesPowered:true, power:{...realMap.power, on:true}, gates: realMap.gates.map(g=>({...g})) });
vm.runInContext("matchMap=" + JSON.stringify(realMap2) + "; handle({t:'state', type:'match', id:'M1', state:'running', map:matchMap, players:" + JSON.stringify(players) + "}); matchMap.power.on=true; updatePrompt(); updateHud();", sandbox);
ok('state handler with powered gates (prompt+HUD) runs', true);

console.log(fail === 0 ? '\nCOMBINED RENDER TEST OK' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
