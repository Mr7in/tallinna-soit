import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { World, toWorld } from './world.js';
import { Vehicle, CAR_SPECS } from './vehicle.js';
import { buildCar, rumble, carModelsReady } from './car.js';
import { toLest } from './lest.js';
import { Roads } from './roads.js';
import { Facades } from './facades.js';
import { Skids } from './skids.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = id => document.getElementById( id );
const UP = new THREE.Vector3( 0, 1, 0 );
const BOUNDARY = 11000; // metres from the city centre

// ---------- prefs ----------
const store = {
	get( k, d ) { try { const v = localStorage.getItem( 'tsoit2.' + k ); return v === null ? d : JSON.parse( v ); } catch { return d; } },
	set( k, v ) { try { localStorage.setItem( 'tsoit2.' + k, JSON.stringify( v ) ); } catch { /* private mode */ } },
};

// ---------- places ----------
const PLACES = [
	{ name: 'Kristiine', lat: 59.42735, lon: 24.72105 },
	{ name: 'Raekoja plats', lat: 59.43717, lon: 24.74535 },
	{ name: 'Vabaduse väljak', lat: 59.43353, lon: 24.7443 },
	{ name: 'Telliskivi', lat: 59.44006, lon: 24.72893 },
	{ name: 'Kadriorg', lat: 59.43808, lon: 24.78886 },
	{ name: 'Pirita tee', lat: 59.4473, lon: 24.8022 },
	{ name: 'Lennusadam', lat: 59.4516, lon: 24.738 },
	{ name: 'Ülemiste', lat: 59.4223, lon: 24.7985 },
	{ name: 'Mustamäe', lat: 59.4048, lon: 24.6885 },
];
{

	// private home spot: open once with ?home=LAT,LON (kept in this browser only)
	const hp = new URLSearchParams( location.search ).get( 'home' );
	if ( hp && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test( hp ) ) {

		store.set( 'home', hp );
		history.replaceState( null, '', location.pathname );

	}

	const saved = store.get( 'home', null ) || ( () => { try { return JSON.parse( localStorage.getItem( 'tsoit.home' ) ); } catch { return null; } } )();
	if ( saved ) {

		const [ lat, lon ] = saved.split( ',' ).map( Number );
		PLACES.unshift( { name: 'Kodu', lat, lon } );

	}

}

const placeVec = p => { const { E, N } = toLest( p.lat, p.lon ); return toWorld( E, N ); };

// ---------- settings ----------
const isTouch = matchMedia( '(pointer: coarse)' ).matches;
const S = {
	car: store.get( 'car', 'rally' ),
	mode: store.get( 'mode', 'arcade' ),
	auto: store.get( 'auto', true ),
	place: Math.min( store.get( 'place', 0 ), PLACES.length - 1 ),
	detail: store.get( 'detail', isTouch ? 2 : 3 ),
	cam: 0,
	muted: store.get( 'muted', false ),
	colors: store.get( 'colors', {} ),
};
if ( ! CAR_SPECS.find( c => c.id === S.car ) ) S.car = 'rally';
const specOf = id => CAR_SPECS.find( c => c.id === id );

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer( { canvas: $( 'c' ), antialias: true, powerPreference: 'high-performance' } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 1.75 ) );
renderer.setSize( innerWidth, innerHeight );
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.autoClear = false;

const scene = new THREE.Scene();
const HORIZON = new THREE.Color( 0xc9dcec );
scene.background = HORIZON;
scene.fog = new THREE.Fog( HORIZON, 450, 1250 );
const hemi = new THREE.HemisphereLight( 0xe4f1ff, 0x6b6250, 1.25 );
scene.add( hemi );
const SUN_DIR = new THREE.Vector3( - 0.5, 1, 0.35 ).normalize();
const sun = new THREE.DirectionalLight( 0xfff0d8, 1.7 );
sun.castShadow = true;
sun.shadow.intensity = 0.62;
sun.shadow.bias = - 0.0004;
sun.shadow.normalBias = 0.04;
scene.add( sun, sun.target );

// sky dome: horizon haze, blue zenith and a soft sun glow
const sky = new THREE.Mesh( new THREE.SphereGeometry( 3000, 32, 16 ), new THREE.ShaderMaterial( {
	side: THREE.BackSide, depthWrite: false, fog: false,
	uniforms: { uSun: { value: SUN_DIR }, uHor: { value: HORIZON }, uZen: { value: new THREE.Color( 0x3f7fc8 ) } },
	vertexShader: 'varying vec3 vD; void main(){ vD = normalize( position ); vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); gl_Position = p.xyww; }',
	fragmentShader: `uniform vec3 uSun, uHor, uZen; varying vec3 vD;
		void main(){
			float h = max( vD.y, 0.0 );
			vec3 c = mix( uHor, uZen, pow( h, 0.55 ) );
			c = mix( c, uHor * 0.92, smoothstep( 0.0, -0.08, vD.y ) );
			float s = max( dot( vD, uSun ), 0.0 );
			c += vec3( 1.0, 0.92, 0.75 ) * ( pow( s, 900.0 ) * 6.0 + pow( s, 24.0 ) * 0.25 );
			gl_FragColor = vec4( c, 1.0 );
			#include <tonemapping_fragment>
			#include <colorspace_fragment>
		}`,
} ) );
sky.renderOrder = - 10;
sky.frustumCulled = false;
sky.layers.set( 2 );
scene.add( sky );

const camera = new THREE.PerspectiveCamera( 55, innerWidth / innerHeight, 0.3, 4000 );
camera.layers.enable( 2 );
const mapCam = new THREE.OrthographicCamera( - 160, 160, 160, - 160, 1, 2000 );
mapCam.layers.enable( 1 );

// reflections for car paint and glass
const pmrem = new THREE.PMREMGenerator( renderer );
const envTex = pmrem.fromScene( ( () => {

	const s = new THREE.Scene();
	const m = sky.clone(); m.material = sky.material.clone(); m.layers.set( 0 ); m.scale.setScalar( 0.01 ); s.add( m );
	const g = new THREE.Mesh( new THREE.PlaneGeometry( 200, 200 ), new THREE.MeshBasicMaterial( { color: 0x5c5a55 } ) );
	g.rotation.x = - Math.PI / 2; g.position.y = - 1; s.add( g );
	return s;

} )(), 0.02 ).texture;
const studioEnv = pmrem.fromScene( new RoomEnvironment(), 0.03 ).texture;

function setEnv( car, env, k = 1 ) {

	car.root.traverse( o => { if ( o.isMesh && o.material && o.material.isMeshStandardMaterial ) { o.material.envMap = env; o.material.envMapIntensity = k * ( o.material.envMapIntensity || 1 ); o.material.needsUpdate = true; } } );

}

addEventListener( 'resize', () => {

	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	showCam.aspect = innerWidth / innerHeight;
	showCam.updateProjectionMatrix();
	renderer.setSize( innerWidth, innerHeight );

} );

// ---------- boundary: a see-through grid wall around the city ----------
const wall = new THREE.Mesh( new THREE.CylinderGeometry( BOUNDARY, BOUNDARY, 140, 900, 1, true ), new THREE.ShaderMaterial( {
	transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
	uniforms: { uCar: { value: new THREE.Vector3() } },
	vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4( position, 1.0 ); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
	fragmentShader: `uniform vec3 uCar; varying vec3 vW;
		void main(){
			float a = atan( vW.z, vW.x ) * ${BOUNDARY.toFixed( 1 )};
			vec2 g = vec2( a, vW.y ) / 4.0;
			vec2 d = abs( fract( g - 0.5 ) - 0.5 ) / fwidth( g );
			float line = 1.0 - min( min( d.x, d.y ), 1.0 );
			float near = 1.0 - smoothstep( 20.0, 170.0, distance( vW.xz, uCar.xz ) );
			float a2 = ( line * 0.75 + 0.07 ) * near;
			if ( a2 < 0.005 ) discard;
			gl_FragColor = vec4( 0.45, 0.85, 1.0, a2 );
		}`,
} ) );
wall.position.y = 20;
wall.frustumCulled = false;
wall.renderOrder = 8;
scene.add( wall );

// ---------- world, car ----------
const world = new World( scene );
const vehicle = new Vehicle( world );
world.onTreeFall = h => audio.play( 'treefall.ogg', Math.min( 1, 0.4 + h / 25 ) );
const roads = new Roads( world );
const facades = new Facades( world );
roads.onPropFall = p => { audio.play( 'crash.ogg', p.type === 3 ? 0.9 : 0.45 ); rumble( 0.6, 0.4, 120 ); };
const skids = new Skids( scene );
let car = null;

function makeCar( id ) {

	if ( car ) { scene.remove( car.root, car.shadow ); car.dispose(); }
	car = buildCar( id, S.colors[ id ] || 0 );
	setEnv( car, envTex, 0.9 );
	scene.add( car.root, car.shadow );

}

function selectCar( id ) {

	S.car = id;
	store.set( 'car', id );
	const spec = specOf( id );
	vehicle.setSpec( spec );
	vehicle.setAuto( S.auto );
	makeCar( id );
	if ( started && ! spawning ) vehicle.place( vehicle.pos.x, vehicle.pos.z, vehicle.yaw );
	refreshUI();

}

// minimap marker (only the map camera sees layer 1)
const marker = new THREE.Mesh(
	new THREE.ShapeGeometry( new THREE.Shape( [ new THREE.Vector2( 0, 9 ), new THREE.Vector2( 6, - 6 ), new THREE.Vector2( 0, - 2 ), new THREE.Vector2( - 6, - 6 ) ] ) ).rotateX( - Math.PI / 2 ),
	new THREE.MeshBasicMaterial( { color: 0xffb400, depthTest: false, fog: false } ),
);
marker.geometry.rotateY( Math.PI );
marker.renderOrder = 10;
marker.layers.set( 1 );
scene.add( marker );

// ---------- showroom (main menu) ----------
const show = new THREE.Scene();
const showCam = new THREE.PerspectiveCamera( 30, innerWidth / innerHeight, 0.1, 100 );
show.background = new THREE.Color( 0x0d0e10 );
show.add( new THREE.HemisphereLight( 0xdfe6f0, 0x15161a, 0.5 ) );
const key = new THREE.SpotLight( 0xffffff, 170, 30, 0.55, 0.6 );
key.position.set( 4, 7, 3 ); key.castShadow = true; key.shadow.mapSize.set( 2048, 2048 ); key.shadow.bias = - 0.0002;
show.add( key, key.target );
const rim = new THREE.DirectionalLight( 0x9ec3ff, 1.2 ); rim.position.set( - 5, 3, - 6 ); show.add( rim );
{

	// floor with a soft light pool
	const c = document.createElement( 'canvas' ); c.width = c.height = 512;
	const x = c.getContext( '2d' );
	const g = x.createRadialGradient( 256, 256, 10, 256, 256, 256 );
	g.addColorStop( 0, '#3a3c41' ); g.addColorStop( 0.45, '#1c1d21' ); g.addColorStop( 1, '#0d0e10' );
	x.fillStyle = g; x.fillRect( 0, 0, 512, 512 );
	x.strokeStyle = 'rgba(255,255,255,0.05)'; x.lineWidth = 2;
	for ( let i = 0; i <= 512; i += 32 ) { x.beginPath(); x.moveTo( i, 0 ); x.lineTo( i, 512 ); x.stroke(); x.beginPath(); x.moveTo( 0, i ); x.lineTo( 512, i ); x.stroke(); }
	const t = new THREE.CanvasTexture( c ); t.colorSpace = THREE.SRGBColorSpace;
	const floor = new THREE.Mesh( new THREE.CircleGeometry( 14, 64 ), new THREE.MeshStandardMaterial( { map: t, roughness: 0.35, metalness: 0.2 } ) );
	floor.rotation.x = - Math.PI / 2; floor.receiveShadow = true; show.add( floor );
	const ring = new THREE.Mesh( new THREE.RingGeometry( 3.05, 3.12, 96 ), new THREE.MeshBasicMaterial( { color: 0xe63b2e } ) );
	ring.rotation.x = - Math.PI / 2; ring.position.y = 0.005; show.add( ring );

}

const turntable = new THREE.Group();
show.add( turntable );
let showCar = null;
function makeShowCar() {

	if ( showCar ) { turntable.remove( showCar.root ); showCar.dispose(); }
	showCar = buildCar( S.car, S.colors[ S.car ] || 0 );
	setEnv( showCar, studioEnv, 0.55 );
	showCar.root.position.y = 0.56;
	turntable.add( showCar.root );

}

function renderShowroom( dt ) {

	if ( window.__game && window.__game.turn !== undefined ) turntable.rotation.y = window.__game.turn; else turntable.rotation.y += dt * 0.25;
	const wide = innerWidth > 760;
	showCam.position.set( wide ? 1.2 : 0, 1.55, 8.6 );
	showCam.lookAt( wide ? 1.4 : 0, wide ? 0.55 : 0.1, 0 );
	renderer.setViewport( 0, 0, innerWidth, innerHeight );
	renderer.clear();
	renderer.render( show, showCam );

}

// ---------- state ----------
let spawning = null; // { at: Vector3, t }
let started = false, paused = false, inMenu = true;
const CAMS = [
	{ name: 'Taga', back: 8.5, up: 2.7, look: 4 },
	{ name: 'Kaugel', back: 14, up: 5, look: 3 },
	{ name: 'Kapott', hood: true },
	{ name: 'Stange', bumper: true },
	{ name: 'Droon', back: 28, up: 22, look: 0 },
];

// ---------- options (shared by the main menu and the pause menu) ----------
const OPTS = {
	mode: { label: 'Sõidurežiim', values: [ 'arcade', 'sim' ], names: [ 'Arcade', 'Simulatsioon' ], get: () => S.mode, set: v => { S.mode = v; vehicle.mode = v; store.set( 'mode', v ); } },
	auto: { label: 'Käigukast', values: [ true, false ], names: [ 'Automaat', 'Manuaal' ], get: () => S.auto, set: v => { S.auto = v; vehicle.setAuto( v ); store.set( 'auto', v ); } },
	car: { label: 'Auto', values: CAR_SPECS.map( c => c.id ), names: CAR_SPECS.map( c => c.name ), get: () => S.car, set: v => selectCar( v ) },
	color: { label: 'Värv', values: [ 0, 1, 2, 3, 4 ], names: [ 'Tehase', 'Värv 2', 'Värv 3', 'Värv 4', 'Värv 5' ], get: () => S.colors[ S.car ] || 0, set: v => { S.colors[ S.car ] = v; store.set( 'colors', S.colors ); car && car.setColor( v ); showCar && showCar.setColor( v ); } },
	place: { label: 'Koht', values: PLACES.map( ( _, i ) => i ), names: PLACES.map( p => p.name ), get: () => S.place, set: v => { S.place = v; store.set( 'place', v ); if ( started && ! inMenu ) pendingPlace = v; } },
	cam: { label: 'Kaamera', values: CAMS.map( ( _, i ) => i ), names: CAMS.map( c => c.name ), get: () => S.cam, set: v => { S.cam = v; } },
	detail: { label: 'Graafika', values: [ 2, 3 ], names: [ 'Tahvel', 'Arvuti' ], get: () => S.detail, set: v => { S.detail = v; store.set( 'detail', v ); } },
	sound: { label: 'Heli', values: [ false, true ], names: [ 'Sees', 'Väljas' ], get: () => S.muted, set: v => { S.muted = v; audio.muted = v; store.set( 'muted', v ); if ( ! v ) audio.unlock(); } },
};
let pendingPlace = null;

function cycle( key, d ) {

	const o = OPTS[ key ];
	const i = o.values.indexOf( o.get() );
	o.set( o.values[ ( i + d + o.values.length ) % o.values.length ] );
	refreshUI();

}

function buildOpts( el, keys ) {

	el.innerHTML = '';
	for ( const k of keys ) {

		const row = document.createElement( 'div' );
		row.className = 'opt nav';
		row.dataset.opt = k;
		row.tabIndex = 0;
		row.innerHTML = `<span>${OPTS[ k ].label}</span><div class="val"><i data-d="-1">‹</i><em></em><i data-d="1">›</i></div>`;
		row.onclick = e => { const d = e.target.dataset.d; cycle( k, d ? + d : 1 ); };
		el.append( row );

	}

}

buildOpts( $( 'mopts' ), [ 'mode', 'auto', 'color', 'place', 'detail', 'sound' ] );
buildOpts( $( 'popts' ), [ 'car', 'mode', 'auto', 'color', 'cam', 'place', 'sound' ] );

for ( const spec of CAR_SPECS ) {

	const b = document.createElement( 'button' );
	b.className = 'carbtn nav';
	b.dataset.car = spec.id;
	b.innerHTML = `<b>${spec.name}</b><small>${spec.hp} HJ · ${spec.drive === 'awd' ? '4WD' : spec.drive.toUpperCase()}</small>`;
	b.onclick = () => selectCar( spec.id );
	$( 'cars' ).append( b );

}

const DRIVE = { awd: '4WD', fwd: 'FWD', rwd: 'RWD' };
const TAGS = { rally: '4WD · Turbo · Boxer 2.2', touring: 'Esivedu · Turbo · 5 silindrit', coupe: 'Tagavedu · S14 2.3' };
function refreshUI() {

	for ( const row of document.querySelectorAll( '.opt' ) ) {

		const o = OPTS[ row.dataset.opt ];
		row.querySelector( 'em' ).textContent = o.names[ o.values.indexOf( o.get() ) ] ?? '';

	}

	for ( const b of document.querySelectorAll( '.carbtn' ) ) b.setAttribute( 'aria-pressed', b.dataset.car === S.car );
	const sp = specOf( S.car );
	$( 'ci-name' ).textContent = sp.name;
	$( 'ci-tag' ).textContent = TAGS[ sp.id ];
	$( 'ci-hp' ).textContent = sp.hp;
	$( 'ci-kg' ).textContent = sp.mass;
	$( 'ci-rpm' ).textContent = sp.redline;
	$( 'ci-drive' ).textContent = DRIVE[ sp.drive ];
	$( 'i-car' ).textContent = sp.name;
	$( 'i-mode' ).textContent = S.mode === 'arcade' ? 'Arcade' : 'Sim';
	$( 'i-place' ).textContent = PLACES[ S.place ].name;
	if ( inMenu && ( ! showCar || showCar.id !== S.car ) ) makeShowCar();
	else if ( showCar ) showCar.setColor( S.colors[ S.car ] || 0 );

}

// ---------- menu navigation with keyboard / gamepad ----------
let focusIdx = 0;
function navItems() {

	const root = paused ? $( 'pause' ) : inMenu ? $( 'menu' ) : null;
	return root ? [ ...root.querySelectorAll( '.nav' ) ] : [];

}

function moveFocus( d ) {

	const items = navItems();
	if ( ! items.length ) return;
	focusIdx = ( focusIdx + d + items.length ) % items.length;
	items.forEach( ( el, i ) => el.classList.toggle( 'focus', i === focusIdx ) );
	items[ focusIdx ].scrollIntoView( { block: 'nearest' } );

}

function navSide( d ) {

	const el = navItems()[ focusIdx ];
	if ( ! el ) return;
	if ( el.dataset.opt ) cycle( el.dataset.opt, d );
	else if ( el.dataset.car ) { const i = CAR_SPECS.findIndex( c => c.id === S.car ); selectCar( CAR_SPECS[ ( i + d + CAR_SPECS.length ) % CAR_SPECS.length ].id ); }

}

function navOk() { const el = navItems()[ focusIdx ]; if ( el ) el.click(); }

function setPaused( on ) {

	if ( ! started || inMenu || spawning && on ) return;
	paused = on;
	$( 'pause' ).style.display = on ? 'grid' : 'none';
	$( 'p-where' ).textContent = PLACES[ S.place ].name;
	keys.clear();
	if ( on ) { focusIdx = 0; moveFocus( 0 ); refreshUI(); } else {

		if ( pendingPlace !== null ) { goPlace( pendingPlace ); pendingPlace = null; }
		last = performance.now();

	}

}

$( 'p-resume' ).onclick = () => setPaused( false );
$( 'p-reset' ).onclick = () => { setPaused( false ); resetCar(); };
$( 'p-menu' ).onclick = () => { setPaused( false ); openMenu(); };
$( 'pbtn' ).onclick = () => { setPaused( ! paused ); $( 'pbtn' ).blur(); };

function openMenu() {

	inMenu = true;
	$( 'menu' ).style.display = 'grid';
	$( 'hud' ).style.display = 'none';
	$( 'touch' ).style.display = 'none';
	focusIdx = navItems().indexOf( $( 'go' ) );
	moveFocus( 0 );
	refreshUI();

}

// ---------- input ----------
const keys = new Set();
const touch = { left: false, right: false, gas: false, brake: false, hand: false };
const ctl = { throttle: 0, brake: 0, steer: 0, handbrake: false };

addEventListener( 'keydown', e => {

	audio.unlock();
	if ( inMenu || paused ) {

		const m = { ArrowUp: - 1, ArrowDown: 1, KeyW: - 1, KeyS: 1 }[ e.code ];
		if ( m ) { moveFocus( m ); e.preventDefault(); return; }
		const s = { ArrowLeft: - 1, ArrowRight: 1, KeyA: - 1, KeyD: 1 }[ e.code ];
		if ( s ) { navSide( s ); e.preventDefault(); return; }
		if ( e.code === 'Enter' || e.code === 'Space' ) { navOk(); e.preventDefault(); return; }
		if ( e.code === 'Escape' && paused ) setPaused( false );
		return;

	}

	keys.add( e.code );
	if ( [ 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space' ].includes( e.code ) ) e.preventDefault();
	if ( e.repeat || ! started ) return;
	if ( e.code === 'Escape' || e.code === 'KeyP' ) setPaused( true );
	if ( e.code === 'KeyE' ) vehicle.shift( 1 );
	if ( e.code === 'KeyQ' ) vehicle.shift( - 1 );
	if ( e.code === 'KeyG' ) { cycle( 'auto', 1 ); toast( S.auto ? 'Automaat' : 'Manuaal' ); }
	if ( e.code === 'KeyC' ) cycleCam();
	if ( e.code === 'KeyR' ) resetCar();
	if ( e.code === 'KeyH' ) audio.horn();
	if ( e.code === 'KeyT' ) { cycle( 'mode', 1 ); toast( S.mode === 'arcade' ? 'Arcade' : 'Simulatsioon' ); }
	if ( e.code === 'KeyM' ) cycle( 'sound', 1 );

} );
addEventListener( 'keyup', e => keys.delete( e.code ) );
addEventListener( 'blur', () => { keys.clear(); if ( started && ! inMenu && ! paused ) setPaused( true ); } );

const padPrev = {};
let padNavT = 0, padSeen = false;
function pollPad( dt ) {

	const gp = navigator.getGamepads ? [ ...navigator.getGamepads() ].find( g => g && g.connected ) : null;
	if ( ! gp ) return null;
	if ( ! padSeen ) { padSeen = true; toast( 'Pult ühendatud' ); }
	const b = i => gp.buttons[ i ] || { value: 0, pressed: false };
	const edge = i => { const p = b( i ).pressed, was = padPrev[ i ]; padPrev[ i ] = p; return p && ! was; };
	const ev = {};
	for ( const i of [ 0, 1, 2, 3, 4, 5, 8, 9, 12, 13, 14, 15 ] ) ev[ i ] = edge( i );

	if ( inMenu || paused ) {

		padNavT -= dt;
		const ly = gp.axes[ 1 ] || 0, lx = gp.axes[ 0 ] || 0;
		let v = ev[ 12 ] ? - 1 : ev[ 13 ] ? 1 : 0, h = ev[ 14 ] ? - 1 : ev[ 15 ] ? 1 : 0;
		if ( ! v && ! h && padNavT <= 0 ) {

			if ( Math.abs( ly ) > 0.6 ) v = Math.sign( ly );
			else if ( Math.abs( lx ) > 0.6 ) h = Math.sign( lx );
			if ( v || h ) padNavT = 0.22;

		}

		if ( Math.abs( ly ) < 0.3 && Math.abs( lx ) < 0.3 ) padNavT = 0;
		if ( v ) moveFocus( v );
		if ( h ) navSide( h );
		if ( ev[ 0 ] ) { audio.unlock(); navOk(); }
		if ( ( ev[ 1 ] || ev[ 9 ] ) && paused ) setPaused( false );
		return null;

	}

	if ( ev[ 9 ] ) { setPaused( true ); return null; }
	if ( ev[ 5 ] ) vehicle.shift( 1 );
	if ( ev[ 4 ] ) vehicle.shift( - 1 );
	if ( ev[ 3 ] || ev[ 8 ] ) cycleCam();
	if ( ev[ 1 ] ) resetCar();
	if ( ev[ 2 ] ) audio.horn();
	return gp;

}

function readInput( dt ) {

	const k = c => keys.has( c );
	let gas = k( 'ArrowUp' ) || k( 'KeyW' ) || touch.gas ? 1 : 0;
	let brk = k( 'ArrowDown' ) || k( 'KeyS' ) || touch.brake ? 1 : 0;
	let steer = ( k( 'ArrowLeft' ) || k( 'KeyA' ) || touch.left ? 1 : 0 ) - ( k( 'ArrowRight' ) || k( 'KeyD' ) || touch.right ? 1 : 0 );
	let hand = k( 'Space' ) || touch.hand;
	let analog = false;

	const gp = pollPad( dt );
	if ( gp ) {

		const ax = gp.axes[ 0 ] || 0, dz = 0.1;
		if ( Math.abs( ax ) > dz ) {

			const a = ( Math.abs( ax ) - dz ) / ( 1 - dz );
			steer = - Math.sign( ax ) * ( 0.55 * a + 0.45 * a * a * a ); // fine control near centre
			analog = true;

		}

		const b = i => gp.buttons[ i ] || { value: 0, pressed: false };
		if ( b( 7 ).value > 0.03 ) gas = b( 7 ).value;
		if ( b( 6 ).value > 0.03 ) brk = b( 6 ).value;
		if ( b( 0 ).pressed ) hand = true;

	}

	const rate = ( cur, target, up, down ) => cur + Math.max( - down * dt, Math.min( up * dt, target - cur ) );
	ctl.throttle = rate( ctl.throttle, gas, 4, 8 );
	ctl.brake = rate( ctl.brake, brk, 5, 10 );
	ctl.steer = analog ? steer : rate( ctl.steer, steer, Math.sign( steer ) && Math.sign( steer ) !== Math.sign( ctl.steer ) ? 8 : 3, 5 );
	ctl.handbrake = hand;
	return ctl;

}

for ( const pad of document.querySelectorAll( '#touch .pad' ) ) {

	const k = pad.dataset.k;
	const on = e => {

		e.preventDefault();
		pad.classList.add( 'on' );
		audio.unlock();
		if ( k === 'up' ) vehicle.shift( 1 );
		else if ( k === 'down' ) vehicle.shift( - 1 );
		else touch[ k ] = true;

	};

	const off = e => { e.preventDefault(); touch[ k ] = false; pad.classList.remove( 'on' ); };
	pad.addEventListener( 'pointerdown', on );
	pad.addEventListener( 'pointerup', off );
	pad.addEventListener( 'pointercancel', off );
	pad.addEventListener( 'pointerleave', off );

}

if ( isTouch ) document.body.classList.add( 'touch' );

// ---------- audio: CC0 samples (engine loops, skid, crash, tree fall), synth fallback ----------
const ENGINE_RPM = [ 900, 2200, 3400, 4600, 5800, 7000 ];
const audio = {
	ctx: null, muted: S.muted, bufs: {}, engine: null,
	unlock() {

		if ( this.ctx || this.muted ) return;
		try {

			const ctx = this.ctx = new ( window.AudioContext || window.webkitAudioContext )();
			this.master = ctx.createGain();
			this.master.gain.value = 0.9;
			this.master.connect( ctx.destination );
			this.lp = ctx.createBiquadFilter();
			this.lp.type = 'lowpass';
			this.lp.frequency.value = 4000;
			this.lp.connect( this.master );
			this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
			this.syn = ctx.createGain(); this.syn.gain.value = 0;
			const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
			this.o1.connect( f ).connect( this.syn ).connect( this.master ); this.o1.start();
			const len = ctx.sampleRate, nb = ctx.createBuffer( 1, len, ctx.sampleRate ), d = nb.getChannelData( 0 );
			for ( let i = 0; i < len; i ++ ) d[ i ] = Math.random() * 2 - 1;
			this.noiseBuf = nb;
			this.tw = ctx.createOscillator(); this.tw.type = 'sine'; this.tw.frequency.value = 2000;
			this.twG = ctx.createGain(); this.twG.gain.value = 0;
			this.tw.connect( this.twG ).connect( this.master ); this.tw.start();
			const wn = ctx.createBufferSource(); wn.buffer = nb; wn.loop = true;
			this.twBp = ctx.createBiquadFilter(); this.twBp.type = 'bandpass'; this.twBp.frequency.value = 3000; this.twBp.Q.value = 4;
			this.twN = ctx.createGain(); this.twN.gain.value = 0;
			wn.connect( this.twBp ).connect( this.twN ).connect( this.master ); wn.start();
			if ( world.manifest ) this.load();

		} catch { this.ctx = null; }

	},
	async load() {

		if ( this.loading ) return;
		this.loading = true;
		const list = ( world.manifest && world.manifest.sounds ) || [];
		await Promise.all( list.map( async n => {

			try { this.bufs[ n ] = await this.ctx.decodeAudioData( await ( await fetch( './sfx/' + n ) ).arrayBuffer() ); } catch { /* skip */ }

		} ) );
		const loops = ENGINE_RPM.map( ( _, i ) => this.bufs[ 'engine' + i + '.wav' ] );
		if ( loops.every( Boolean ) ) {

			this.engine = loops.map( ( b, i ) => {

				const src = this.ctx.createBufferSource(); src.buffer = b; src.loop = true;
				const g = this.ctx.createGain(); g.gain.value = 0;
				src.connect( g ).connect( this.lp ); src.start();
				return { src, g, rpm: ENGINE_RPM[ i ] };

			} );
			this.syn.gain.value = 0;

		}

		if ( this.bufs[ 'skid.mp3' ] ) {

			const src = this.ctx.createBufferSource(); src.buffer = this.bufs[ 'skid.mp3' ]; src.loop = true;
			src.loopStart = 0.3; src.loopEnd = Math.min( src.buffer.duration, 3.3 );
			this.skid = this.ctx.createGain(); this.skid.gain.value = 0;
			src.connect( this.skid ).connect( this.master ); src.start( 0, 0.3 );

		}

	},
	update( rpm, throttle, slide, speed, boost = 0, quiet = false ) {

		if ( ! this.ctx ) return;
		const t = this.ctx.currentTime, mute = this.muted || quiet ? 0 : 1;
		// the same loops serve every car: higher-revving engines play them a little faster
		const r = rpm * ( 7200 / vehicle.redline ) ** 0.5;
		if ( this.engine ) {

			let k = 0;
			while ( k < ENGINE_RPM.length - 2 && r > ENGINE_RPM[ k + 1 ] ) k ++;
			const a = Math.max( 0, Math.min( 1, ( r - ENGINE_RPM[ k ] ) / ( ENGINE_RPM[ k + 1 ] - ENGINE_RPM[ k ] ) ) );
			const vol = ( 0.22 + throttle * 0.28 ) * mute;
			this.engine.forEach( ( e, i ) => {

				const w = i === k ? 1 - a : i === k + 1 ? a : 0;
				e.g.gain.setTargetAtTime( w * vol, t, 0.04 );
				e.src.playbackRate.setTargetAtTime( Math.max( 0.5, Math.min( 2.2, rpm / e.rpm ) ), t, 0.03 );

			} );
			this.lp.frequency.setTargetAtTime( 900 + throttle * 5000, t, 0.08 );

		} else {

			this.o1.frequency.setTargetAtTime( rpm / 30, t, 0.02 );
			this.syn.gain.setTargetAtTime( ( 0.05 + throttle * 0.07 ) * mute, t, 0.05 );

		}

		if ( this.skid ) this.skid.gain.setTargetAtTime( Math.min( 0.5, slide * Math.min( 1, speed / 5 ) * 0.55 ) * mute, t, 0.06 );
		if ( this.tw ) {

			const b = boost * mute;
			this.tw.frequency.setTargetAtTime( 1700 + b * 4200 + rpm * 0.15, t, 0.08 );
			this.twG.gain.setTargetAtTime( b * b * 0.035 * ( 0.3 + throttle * 0.7 ), t, 0.08 );
			this.twBp.frequency.setTargetAtTime( 2200 + b * 3000, t, 0.1 );
			this.twN.gain.setTargetAtTime( b * 0.05 * throttle, t, 0.08 );

		}

	},
	noise( dur, type, f0, f1, q, vol, delay = 0 ) {

		if ( ! this.ctx || this.muted ) return;
		const c = this.ctx, t = c.currentTime + delay;
		const src = c.createBufferSource(); src.buffer = this.noiseBuf;
		const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
		f.frequency.setValueAtTime( f0, t ); f.frequency.exponentialRampToValueAtTime( f1, t + dur );
		const g = c.createGain();
		g.gain.setValueAtTime( 0.0001, t ); g.gain.exponentialRampToValueAtTime( vol, t + 0.008 ); g.gain.exponentialRampToValueAtTime( 0.0001, t + dur );
		src.connect( f ).connect( g ).connect( this.master );
		src.start( t, Math.random() * 0.5 ); src.stop( t + dur + 0.05 );

	},
	bov( k ) { this.noise( 0.35 + k * 0.25, 'bandpass', 4200, 1400, 1.2, 0.22 * k ); this.noise( 0.12, 'highpass', 6000, 3000, 0.7, 0.08 * k ); },
	pop( k ) {

		if ( ! this.ctx || this.muted ) return;
		const c = this.ctx, t = c.currentTime;
		const o = c.createOscillator(); o.type = 'triangle';
		o.frequency.setValueAtTime( 110 + Math.random() * 40, t ); o.frequency.exponentialRampToValueAtTime( 45, t + 0.09 );
		const g = c.createGain(); g.gain.setValueAtTime( 0.5 * k, t ); g.gain.exponentialRampToValueAtTime( 0.0001, t + 0.1 );
		o.connect( g ).connect( this.master ); o.start( t ); o.stop( t + 0.12 );
		this.noise( 0.06 + Math.random() * 0.04, 'lowpass', 2500, 400, 0.8, 0.45 * k );
		if ( Math.random() < 0.5 ) this.noise( 0.03, 'highpass', 3000, 2000, 0.5, 0.25 * k, 0.03 + Math.random() * 0.05 );

	},
	play( name, vol = 1 ) {

		if ( ! this.ctx || this.muted || ! this.bufs[ name ] ) return;
		const src = this.ctx.createBufferSource(); src.buffer = this.bufs[ name ];
		const g = this.ctx.createGain(); g.gain.value = vol;
		src.connect( g ).connect( this.master ); src.start();

	},
	bang( s ) {

		if ( ! this.ctx || this.muted ) return;
		if ( this.bufs[ 'crash.ogg' ] ) return this.play( 'crash.ogg', Math.min( 1, s * 1.2 ) );
		const n = this.ctx.createBufferSource(); n.buffer = this.noiseBuf;
		const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
		const g = this.ctx.createGain(); const t = this.ctx.currentTime;
		g.gain.setValueAtTime( 0.6 * s, t ); g.gain.exponentialRampToValueAtTime( 0.001, t + 0.35 );
		n.connect( lp ).connect( g ).connect( this.master ); n.start( t ); n.stop( t + 0.4 );

	},
	horn() {

		this.unlock();
		if ( ! this.ctx || this.muted ) return;
		const t = this.ctx.currentTime;
		for ( const f of [ 415, 523 ] ) {

			const o = this.ctx.createOscillator(), g = this.ctx.createGain();
			o.type = 'square'; o.frequency.value = f;
			g.gain.setValueAtTime( 0.07, t ); g.gain.exponentialRampToValueAtTime( 0.001, t + 0.5 );
			o.connect( g ).connect( this.master ); o.start( t ); o.stop( t + 0.55 );

		}

	},
};

// ---------- spawning ----------
function spawnAt( v ) {

	spawning = { at: v.clone(), t: 0 };
	skids.clear();
	showStatus( 'Laen linna', 'Maa-ameti 3D-majad ja ortofoto' );

}

function trySpawn( dt ) {

	spawning.t += dt;
	const ready = world.update( spawning.at.x, spawning.at.z );
	roads.update( spawning.at.x, spawning.at.z );
	facades.update( spawning.at.x, spawning.at.z );
	if ( ( ready < 1 || ! roads.rasterAt( spawning.at.x, spawning.at.z ) ) && spawning.t < 20 ) return;

	// prefer a spot on asphalt, clear of buildings and trees
	const a = spawning.at;
	let pick = null, fallback = null, narrow = null;
	const wide = ( x, z ) => [ [ 4, 0 ], [ - 4, 0 ], [ 0, 4 ], [ 0, - 4 ] ].filter( ( [ dx, dz ] ) => world.surface( x + dx, z + dz ) === 1 ).length >= 3;
	for ( let r = 0; r <= 120 && ! pick; r += 3 ) {

		const n = Math.max( 1, Math.round( r * 1.5 ) );
		for ( let i = 0; i < n; i ++ ) {

			const ang = i / n * Math.PI * 2;
			const x = a.x + Math.cos( ang ) * r, z = a.z + Math.sin( ang ) * r;
			const p = new THREE.Vector3( x, world.height( x, z ) + 1, z );
			if ( world.normal( x, z ).y < 0.97 ) continue;
			if ( world.closest( p, 4 ) || world.treesNear( x, z, 3 ).length ) continue;
			if ( ! fallback ) fallback = p;
			if ( world.surface( x, z ) !== 1 ) continue;
			if ( ! narrow ) narrow = p;
			if ( ! wide( x, z ) ) continue;
			pick = p;
			break;

		}

	}

	pick = pick || narrow || fallback || new THREE.Vector3( a.x, world.height( a.x, a.z ) + 1, a.z );

	let yaw = keepYaw;
	if ( yaw === null ) {

		// face the longest open direction (usually down the street)
		let best = - 1;
		for ( let i = 0; i < 24; i ++ ) {

			const ang = i / 24 * Math.PI * 2;
			const dir = new THREE.Vector3( Math.sin( ang ), 0, Math.cos( ang ) );
			const h = world.raycast( pick, dir, 150 );
			let d = h ? h.distance : 150;
			// bonus for staying on asphalt
			for ( let s = 4; s <= 24; s += 4 ) if ( world.surface( pick.x + dir.x * s, pick.z + dir.z * s ) === 1 ) d += 6;
			if ( d > best ) { best = d; yaw = ang; }

		}

	}

	keepYaw = null;
	vehicle.place( pick.x, pick.z, yaw );
	spawning = null;
	camPos.set( pick.x - Math.sin( yaw ) * 12, pick.y + 6, pick.z - Math.cos( yaw ) * 12 );
	camLook.copy( pick );
	camYaw = yaw;
	hideStatus();

}

let keepYaw = null;
function resetCar() {

	if ( spawning ) return;
	keepYaw = vehicle.yaw;
	spawnAt( new THREE.Vector3( vehicle.pos.x, 0, vehicle.pos.z ) );
	spawning.t = 30; // chunks are already there

}

function goPlace( i ) {

	S.place = ( i + PLACES.length ) % PLACES.length;
	store.set( 'place', S.place );
	keepYaw = null;
	refreshUI();
	spawnAt( placeVec( PLACES[ S.place ] ) );

}

// ---------- camera ----------
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camYaw = 0;
const _v = new THREE.Vector3();

function updateCamera( dt ) {

	if ( spawning ) {

		const a = spawning.at, t = performance.now() * 0.0001;
		camera.position.set( a.x + Math.sin( t ) * 220, world.height( a.x, a.z ) + 170, a.z + Math.cos( t ) * 220 );
		camera.lookAt( a.x, world.height( a.x, a.z ), a.z );
		return;

	}

	const p = vehicle.pos;
	// follow the direction of travel a little when sliding, so drifts look good
	const vh = _v.set( vehicle.vel.x, 0, vehicle.vel.z );
	let yaw = vehicle.yaw;
	if ( vh.length() > 4 && vehicle.speed > 0 ) {

		const vy = Math.atan2( vh.x, vh.z );
		let d = Math.atan2( Math.sin( vy - yaw ), Math.cos( vy - yaw ) );
		yaw += d * 0.45;

	}

	let dy = yaw - camYaw;
	dy = Math.atan2( Math.sin( dy ), Math.cos( dy ) );
	camYaw += dy * Math.min( 1, dt * 4 );
	const c = CAMS[ S.cam ];

	if ( c.hood || c.bumper ) {

		const q = vehicle.quat;
		camera.position.copy( new THREE.Vector3( 0, c.hood ? 0.68 : 0.05, c.hood ? 0.35 : 2.25 ).applyQuaternion( q ).add( p ) );
		camera.quaternion.copy( q ).multiply( new THREE.Quaternion().setFromAxisAngle( UP, Math.PI ) );
		camera.rotateX( - 0.05 );
		camera.fov = c.hood ? 70 : 74;
		camera.updateProjectionMatrix();
		return;

	}

	const f = new THREE.Vector3( Math.sin( camYaw ), 0, Math.cos( camYaw ) );
	const sp = Math.abs( vehicle.speed );
	const want = p.clone().addScaledVector( f, - c.back - sp * 0.04 ).addScaledVector( UP, c.up );
	const from = p.clone().addScaledVector( UP, 1.4 );
	const to = want.clone().sub( from );
	const dist = to.length();
	to.normalize();
	const hit = world.raycast( from, to, dist );
	if ( hit ) want.copy( from ).addScaledVector( to, Math.max( 2, hit.distance - 0.6 ) );
	const gy = world.height( want.x, want.z ) + 0.8;
	if ( want.y < gy ) want.y = gy;

	camPos.lerp( want, 1 - Math.exp( - dt * 8 ) );
	camLook.lerp( p.clone().addScaledVector( UP, 0.9 ).addScaledVector( f, c.look ), 1 - Math.exp( - dt * 14 ) );
	camera.position.copy( camPos );
	if ( vehicle.impact > 0.02 ) {

		camera.position.x += ( Math.random() - 0.5 ) * vehicle.impact * 0.5;
		camera.position.y += ( Math.random() - 0.5 ) * vehicle.impact * 0.5;

	}

	camera.lookAt( camLook );
	camera.fov += ( 55 + Math.min( 12, sp * 0.25 ) - camera.fov ) * Math.min( 1, dt * 3 );
	camera.updateProjectionMatrix();

}

function cycleCam() { S.cam = ( S.cam + 1 ) % CAMS.length; toast( CAMS[ S.cam ].name ); }

// ---------- HUD ----------
function showStatus( a, b ) {

	const s = $( 'status' );
	s.style.display = '';
	s.textContent = a;
	if ( b ) { const sm = document.createElement( 'small' ); sm.textContent = b; s.append( sm ); }

}

function hideStatus() { $( 'status' ).style.display = 'none'; }

let toastT = 0;
function toast( t ) { const el = $( 'toast' ); el.textContent = t; el.style.opacity = 1; clearTimeout( toastT ); toastT = setTimeout( () => { el.style.opacity = 0; }, 1300 ); }

const tctx = $( 'tacho' ).getContext( '2d' );
const FONT = '"Barlow Condensed", sans-serif';
function drawTacho() {

	const c = tctx, W = 500, cx = 250, cy = 250, R = 220;
	c.clearRect( 0, 0, W, W );
	c.beginPath(); c.arc( cx, cy, R + 14, 0, Math.PI * 2 );
	c.fillStyle = 'rgba(12,13,15,.8)'; c.fill();
	c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,.15)'; c.stroke();
	const max = Math.ceil( ( vehicle.limit + 300 ) / 1000 ) * 1000;
	const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
	const ang = r => a0 + ( a1 - a0 ) * Math.min( 1, r / max );
	// rev arc
	c.lineCap = 'butt';
	c.beginPath(); c.arc( cx, cy, R - 10, a0, a1 ); c.lineWidth = 10; c.strokeStyle = 'rgba(255,255,255,.08)'; c.stroke();
	const hot = vehicle.rpm > vehicle.redline - 250;
	c.beginPath(); c.arc( cx, cy, R - 10, a0, ang( vehicle.rpm ) ); c.lineWidth = 10; c.strokeStyle = hot ? '#e63b2e' : '#eceef1'; c.stroke();
	c.beginPath(); c.arc( cx, cy, R - 26, ang( vehicle.redline ), a1 ); c.lineWidth = 6; c.strokeStyle = '#e63b2e'; c.stroke();
	c.fillStyle = '#eceef1'; c.strokeStyle = 'rgba(255,255,255,.7)';
	c.font = `600 30px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
	for ( let r = 0; r <= max; r += 500 ) {

		const a = ang( r ), big = r % 1000 === 0;
		c.lineWidth = big ? 4 : 2;
		c.beginPath();
		c.moveTo( cx + Math.cos( a ) * ( R - ( big ? 52 : 42 ) ), cy + Math.sin( a ) * ( R - ( big ? 52 : 42 ) ) );
		c.lineTo( cx + Math.cos( a ) * ( R - 32 ), cy + Math.sin( a ) * ( R - 32 ) );
		c.stroke();
		if ( big ) { c.fillStyle = r >= vehicle.redline ? '#e63b2e' : '#c9cdd3'; c.fillText( r / 1000, cx + Math.cos( a ) * ( R - 78 ), cy + Math.sin( a ) * ( R - 78 ) ); }

	}

	// needle
	const a = ang( vehicle.rpm );
	c.strokeStyle = '#e63b2e'; c.lineWidth = 5; c.lineCap = 'round';
	c.beginPath(); c.moveTo( cx - Math.cos( a ) * 18, cy - Math.sin( a ) * 18 ); c.lineTo( cx + Math.cos( a ) * ( R - 34 ), cy + Math.sin( a ) * ( R - 34 ) ); c.stroke();
	c.beginPath(); c.arc( cx, cy, 10, 0, Math.PI * 2 ); c.fillStyle = '#e63b2e'; c.fill();
	// gear + speed
	const g = vehicle.gear === - 1 ? 'R' : vehicle.gear === 0 ? 'N' : String( vehicle.gear );
	c.fillStyle = hot ? '#e63b2e' : '#ffffff';
	c.font = `700 120px ${FONT}`;
	c.fillText( g, cx, cy + 86 );
	c.fillStyle = '#ffffff';
	c.font = `600 54px ${FONT}`;
	c.fillText( Math.round( Math.abs( vehicle.speed ) * 3.6 ), cx, cy + 166 );
	c.font = `500 20px ${FONT}`;
	c.fillStyle = '#8d939c';
	c.fillText( 'KM/H', cx, cy + 200 );
	c.font = `600 22px ${FONT}`;
	c.fillStyle = vehicle.auto ? '#ffb400' : '#8d939c';
	c.fillText( vehicle.auto ? 'AUTO' : 'MANUAAL', cx, cy - 62 );
	if ( vehicle.spec.turbo ) {

		const bw = 120, bx = cx - bw / 2, by = cy - 36;
		c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect( bx, by, bw, 6 );
		c.fillStyle = vehicle.boost > 0.8 ? '#ffb400' : '#9aa4b0';
		c.fillRect( bx, by, bw * Math.max( 0, Math.min( 1, vehicle.boost ) ), 6 );

	}

	if ( ctl.handbrake ) { c.fillStyle = '#e63b2e'; c.font = `700 24px ${FONT}`; c.fillText( 'P', cx, cy - 94 ); }

}

function renderMinimap() {

	const fr = $( 'mapframe' ).getBoundingClientRect();
	const size = fr.width;
	const x = fr.left, y = innerHeight - fr.bottom;
	const p = vehicle.pos;
	mapCam.position.set( p.x, p.y + 600, p.z );
	mapCam.up.set( Math.sin( camYaw ), 0, Math.cos( camYaw ) );
	mapCam.lookAt( p.x, p.y, p.z );
	marker.position.set( p.x, p.y + 40, p.z );
	marker.rotation.y = vehicle.yaw;
	const fog = scene.fog;
	scene.fog = null;
	const se = renderer.shadowMap.enabled;
	renderer.shadowMap.autoUpdate = false;
	renderer.setScissorTest( true );
	renderer.setScissor( x, y, size, size );
	renderer.setViewport( x, y, size, size );
	renderer.clear();
	renderer.render( scene, mapCam );
	renderer.setScissorTest( false );
	renderer.setViewport( 0, 0, innerWidth, innerHeight );
	renderer.shadowMap.autoUpdate = se;
	scene.fog = fog;

}

// ---------- shadows: buildings, trees and props cast, everything lit receives ----------
function tagShadows() {

	scene.traverse( o => {

		if ( ! o.isMesh || o.userData.sh || o === sky || o === wall ) return;
		o.userData.sh = 1;
		const m = Array.isArray( o.material ) ? o.material[ 0 ] : o.material;
		if ( ! m || m.isShaderMaterial || m.isMeshBasicMaterial || m.transparent ) return;
		o.receiveShadow = true;
		if ( m.isMeshStandardMaterial || o.isInstancedMesh ) o.castShadow = true;

	} );

}

function placeSun() {

	// keep the shadow box around the car, snapped to shadow texels so edges do not crawl
	const ext = sun.shadow.camera.right, tex = ext * 2 / sun.shadow.mapSize.x;
	const p = vehicle.pos;
	const fx = Math.round( ( p.x + vehicle.vel.x * 0.8 ) / tex ) * tex, fz = Math.round( ( p.z + vehicle.vel.z * 0.8 ) / tex ) * tex;
	sun.target.position.set( fx, p.y, fz );
	sun.position.set( fx, p.y, fz ).addScaledVector( SUN_DIR, 300 );
	sun.target.updateMatrixWorld();

}

// ---------- start ----------
async function startGame() {

	audio.unlock();
	inMenu = false;
	$( 'menu' ).style.display = 'none';
	$( 'hud' ).style.display = 'block';
	if ( isTouch ) $( 'touch' ).style.display = 'block';
	vehicle.mode = S.mode;
	vehicle.setAuto( S.auto );
	if ( ! started ) {

		const d = S.detail;
		world.radius = d;
		roads.radius = d === 2 ? 1 : 2;
		facades.radius = d === 2 ? 140 : 200;
		facades.maxTex = d === 2 ? 512 : 1024;
		scene.fog.far = d === 2 ? 850 : 1250;
		scene.fog.near = d === 2 ? 300 : 450;
		const sz = d === 2 ? 1024 : 2048, ext = d === 2 ? 55 : 85;
		sun.shadow.mapSize.set( sz, sz );
		Object.assign( sun.shadow.camera, { left: - ext, right: ext, top: ext, bottom: - ext, near: 50, far: 600 } );
		sun.shadow.camera.updateProjectionMatrix();
		showStatus( 'Laen linna', 'Maa-ameti 3D-majad ja ortofoto' );
		try { await world.init(); } catch ( e ) { showStatus( 'Oih!', 'Linna andmeid ei saanud laadida.' ); return; }
		started = true;
		if ( audio.ctx ) audio.load();

	}

	goPlace( S.place );
	last = performance.now();

}

$( 'go' ).onclick = startGame;

// ---------- loop ----------
let last = performance.now();
let chunkT = 0, shadowT = 0, lastBang = false;
const _side = new THREE.Vector3();
function loop( now ) {

	requestAnimationFrame( loop );
	const dt = Math.min( 0.05, ( now - last ) / 1000 );
	last = now;

	if ( inMenu ) {

		pollPad( dt );
		if ( audio.ctx ) audio.update( 900, 0, 0, 0, 0, true );
		renderShowroom( dt );
		return;

	}

	if ( ! started ) { pollPad( dt ); renderShowroom( dt ); return; }

	const input = readInput( dt );
	if ( paused ) {

		if ( audio.ctx ) audio.update( vehicle.rpm, 0, 0, 0, 0, true );
		renderer.setViewport( 0, 0, innerWidth, innerHeight );
		renderer.clear();
		renderer.render( scene, camera );
		if ( ! spawning ) renderMinimap();
		return;

	}

	if ( spawning ) trySpawn( dt );
	else {

		vehicle.update( dt, input );
		if ( vehicle.pos.y < world.height( vehicle.pos.x, vehicle.pos.z ) - 6 ) resetCar();
		// city limit: the grid wall pushes the car back
		const r = Math.hypot( vehicle.pos.x, vehicle.pos.z );
		if ( r > BOUNDARY - 2.4 ) {

			const nx = vehicle.pos.x / r, nz = vehicle.pos.z / r;
			const k = ( r - BOUNDARY + 2.4 );
			vehicle.pos.x -= nx * k; vehicle.pos.z -= nz * k;
			const vn = vehicle.vel.x * nx + vehicle.vel.z * nz;
			if ( vn > 0 ) {

				vehicle.vel.x -= nx * vn * 1.4; vehicle.vel.z -= nz * vn * 1.4;
				vehicle.impact = Math.max( vehicle.impact, Math.min( 1, vn / 15 ) );

			}

		}

		chunkT -= dt;
		if ( chunkT <= 0 ) { world.update( vehicle.pos.x, vehicle.pos.z ); roads.update( vehicle.pos.x, vehicle.pos.z ); facades.update( vehicle.pos.x, vehicle.pos.z ); chunkT = 0.25; }

	}

	shadowT -= dt;
	if ( shadowT <= 0 ) { tagShadows(); shadowT = 1; }
	world.animate( dt );
	roads.animate( dt );
	wall.material.uniforms.uCar.value.copy( vehicle.pos );

	// car visuals
	car.root.position.copy( vehicle.pos );
	car.root.quaternion.copy( vehicle.quat );
	_side.set( 1, 0, 0 ).applyQuaternion( vehicle.quat );
	vehicle.wheels.forEach( ( w, i ) => {

		const v = car.wheels[ i ];
		v.pivot.position.y = 0.56 + ( - 0.05 - w.len );
		v.pivot.rotation.y = w.front ? vehicle.steer : 0;
		v.spin.rotation.x += w.omega * dt;
		// tyre marks on hard surfaces
		const hard = w.surf === 1 || w.surf === 2 || w.surf === 4;
		if ( ! spawning && w.contact && hard && w.slide > 0.32 && w.cp ) skids.add( i, w.cp, _side, Math.min( 1, ( w.slide - 0.25 ) * 2 ), w.cp.y + 0.02 );
		else skids.add( i, null, null, 0 );

	} );
	const gy = world.ready ? world.ground( vehicle.pos.x, vehicle.pos.z, vehicle.pos.y ) : 0;
	car.shadow.position.set( vehicle.pos.x, gy + 0.1, vehicle.pos.z );
	car.shadow.rotation.z = vehicle.yaw;
	car.shadow.material.opacity = 0.7 * Math.max( 0, 1 - ( vehicle.pos.y - gy - 0.6 ) / 6 );

	if ( vehicle.impact > 0.15 && ! lastBang ) { audio.bang( vehicle.impact ); rumble( vehicle.impact, vehicle.impact, 160 ); }
	lastBang = vehicle.impact > 0.15;
	vehicle.impact *= Math.exp( - dt * 6 );
	const slide = Math.max( ...vehicle.wheels.map( w => w.contact ? w.slide : 0 ) );
	audio.update( vehicle.rpm, vehicle.throttle, slide, Math.abs( vehicle.speed ), vehicle.boost );
	for ( const [ kind, k ] of vehicle.events ) {

		if ( kind === 'bov' ) audio.bov( k );
		else { audio.pop( k ); car.pop( k ); }

	}

	vehicle.events.length = 0;
	car.animate( dt );

	updateCamera( dt );
	sky.position.copy( camera.position );
	placeSun();

	renderer.setViewport( 0, 0, innerWidth, innerHeight );
	renderer.clear();
	renderer.render( scene, camera );
	if ( ! spawning ) renderMinimap();
	drawTacho();

}

// ---------- boot ----------
selectCar( S.car );
// real car models: swap them in as soon as they have loaded
carModelsReady.then( n => { if ( ! n ) return; makeCar( S.car ); if ( showCar ) makeShowCar(); } );
vehicle.mode = S.mode;
openMenu();
requestAnimationFrame( loop );

// test hooks
window.__game = { vehicle, world, roads, facades, ctl, keys, skids, CAR_SPECS, S, selectCar, setPaused, startGame, cycle, get car() { return car; }, get spawning() { return spawning; }, get paused() { return paused; } };
