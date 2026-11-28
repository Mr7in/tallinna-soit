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
import { TileMap, worldToEN, enToWorld, tileGen } from './map.js';

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
	look: store.get( 'look', 'ps1' ),
};
if ( S.look !== 'ps1' && S.look !== 'sharp' ) S.look = 'ps1';
if ( ! CAR_SPECS.find( c => c.id === S.car ) ) S.car = 'rally';
const specOf = id => CAR_SPECS.find( c => c.id === id );

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer( { canvas: $( 'c' ), antialias: true, powerPreference: 'high-performance' } );
renderer.setSize( innerWidth, innerHeight );
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.autoClear = false;

const scene = new THREE.Scene();
// TLN 4:47: June white night, the sun just over the horizon (palette from the CI: koidusinine, valge öö roosa, kuldne tund)
const HORIZON = new THREE.Color( 0xd9a9b6 );
scene.background = HORIZON;
scene.fog = new THREE.Fog( HORIZON, 450, 1250 );
const hemi = new THREE.HemisphereLight( 0xa9aee0, 0x4a3d48, 1.05 );
scene.add( hemi );
const SUN_DIR = new THREE.Vector3( - 0.62, 0.36, 0.48 ).normalize(); // low dawn sun: long, warm light
const sun = new THREE.DirectionalLight( 0xffc58e, 1.55 );
sun.castShadow = true;
sun.shadow.intensity = 0.62;
sun.shadow.bias = - 0.0006;
sun.shadow.normalBias = 0.12; // enough to keep acne (dotted walls) off the flat-shaded buildings
scene.add( sun, sun.target );

// sky dome: horizon haze, blue zenith, a soft sun glow and drifting fair-weather clouds (all in the shader, no textures)
const sky = new THREE.Mesh( new THREE.SphereGeometry( 3000, 32, 16 ), new THREE.ShaderMaterial( {
	side: THREE.BackSide, depthWrite: false, fog: false,
	uniforms: { uSun: { value: SUN_DIR }, uHor: { value: HORIZON }, uZen: { value: new THREE.Color( 0x2b3a67 ) }, uTime: { value: 0 } },
	vertexShader: 'varying vec3 vD; void main(){ vD = normalize( position ); vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); gl_Position = p.xyww; }',
	fragmentShader: `uniform vec3 uSun, uHor, uZen; uniform float uTime; varying vec3 vD;
		float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
		float noise( vec2 p ) {
			vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
			return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
		}
		float fbm( vec2 p ) { float v = 0.0, a = 0.5; for ( int i = 0; i < 5; i ++ ) { v += a * noise( p ); p = p * 2.03 + vec2( 1.7, 9.2 ); a *= 0.5; } return v; }
		void main(){
			float h = max( vD.y, 0.0 );
			vec3 c = mix( uHor, uZen, pow( h, 0.42 ) );
			// the sunrise side of the sky burns gold near the horizon
			float sh = max( dot( normalize( vec3( vD.x, 0.0001, vD.z ) ), normalize( vec3( uSun.x, 0.0, uSun.z ) ) ), 0.0 );
			c = mix( c, vec3( 0.96, 0.68, 0.40 ), pow( sh, 3.0 ) * ( 1.0 - smoothstep( 0.0, 0.35, h ) ) * 0.75 );
			c = mix( c, uHor * 0.92, smoothstep( 0.0, -0.08, vD.y ) );
			float s = max( dot( vD, uSun ), 0.0 );
			// clouds on a flat layer high above: project the view ray onto it
			if ( vD.y > 0.02 ) {
				vec2 uv = vD.xz / ( vD.y + 0.12 ) * 1.6 + vec2( uTime * 0.006, uTime * 0.0025 );
				float n = fbm( uv );
				float cov = smoothstep( 0.48, 0.72, n );
				float thick = smoothstep( 0.5, 0.9, n );
				vec3 cc = mix( vec3( 0.95, 0.70, 0.74 ), vec3( 0.42, 0.40, 0.58 ), thick * 0.8 );
				cc += vec3( 1.0, 0.74, 0.42 ) * pow( sh, 4.0 ) * 0.45 * ( 1.0 - thick );
				c = mix( c, cc, cov * smoothstep( 0.02, 0.22, vD.y ) * 0.7 );
			}
			c += vec3( 1.0, 0.82, 0.55 ) * ( pow( s, 900.0 ) * 6.0 + pow( s, 16.0 ) * 0.45 );
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

// ---------- TLN 4:47 look: low resolution, dawn grade, ordered dither, CRT lines ----------
// the scene goes into a small HDR target, then one full-screen pass tone maps, grades and pixelates it
const LOOKS = {
	ps1: { h: 360, levels: 31, scan: 0.16 }, // 15-bit colour, nearest upscale
	sharp: { h: 0, levels: 0, scan: 0 }, // full resolution, the grade only
};
const lookRT = new THREE.WebGLRenderTarget( 1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false } );
const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
const postMat = new THREE.ShaderMaterial( {
	depthTest: false, depthWrite: false,
	uniforms: { tSrc: { value: lookRT.texture }, uRes: { value: new THREE.Vector2( 1, 1 ) }, uLevels: { value: 31 }, uScan: { value: 0.16 } },
	vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
	fragmentShader: `uniform sampler2D tSrc; uniform vec2 uRes; uniform float uLevels, uScan; varying vec2 vUv;
		vec3 neutral( vec3 c ) {
			float x = min( c.r, min( c.g, c.b ) ); c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
			float peak = max( c.r, max( c.g, c.b ) ); if ( peak < 0.76 ) return c;
			float d = 0.24, np = 1.0 - d * d / ( peak + d - 0.76 ); c *= np / peak;
			return mix( c, vec3( np ), 1.0 - 1.0 / ( 0.15 * ( peak - np ) + 1.0 ) );
		}
		float b2( vec2 a ) { a = floor( a ); return fract( dot( a, vec2( 0.5, a.y * 0.75 ) ) ); }
		float bayer( vec2 a ) { return b2( 0.5 * a ) * 0.25 + b2( a ); }
		void main(){
			vec3 c = neutral( max( texture2D( tSrc, vUv ).rgb, 0.0 ) );
			// valge öö grade: blue shadows, warm pink-gold highlights, lifted blacks, a little less saturation
			float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
			c = mix( vec3( l ), c, 0.86 );
			c *= mix( vec3( 0.80, 0.85, 1.14 ), vec3( 1.10, 0.97, 0.86 ), smoothstep( 0.04, 0.7, l ) );
			c = c * 0.93 + vec3( 0.016, 0.018, 0.042 );
			c = pow( clamp( c, 0.0, 1.0 ), vec3( 1.0 / 2.2 ) );
			vec2 px = floor( vUv * uRes );
			if ( uLevels > 0.0 ) c = floor( c * uLevels + bayer( px ) ) / uLevels;
			c *= 1.0 - uScan * step( 0.62, fract( vUv.y * uRes.y ) );
			vec2 q = vUv - 0.5; c *= 1.0 - dot( q, q ) * 0.5;
			gl_FragColor = vec4( c, 1.0 );
		}`,
} );
{ const q = new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ), postMat ); q.frustumCulled = false; postScene.add( q ); }
const _db = new THREE.Vector2();
let lookKey = '';
function present( scn, cam ) {

	const L = LOOKS[ S.look ] || LOOKS.ps1;
	renderer.getDrawingBufferSize( _db );
	const h = L.h ? Math.min( L.h, _db.y ) : _db.y, w = Math.max( 1, Math.round( h * _db.x / Math.max( 1, _db.y ) ) );
	const k = w + 'x' + h + S.look;
	if ( k !== lookKey ) {

		lookKey = k;
		const ms = L.h ? 0 : 4;
		if ( lookRT.samples !== ms ) { lookRT.samples = ms; lookRT.dispose(); }
		lookRT.setSize( w, h );
		postMat.uniforms.uRes.value.set( w, h );
		postMat.uniforms.uLevels.value = L.levels;
		postMat.uniforms.uScan.value = L.scan;

	}

	renderer.setRenderTarget( lookRT );
	renderer.clear();
	renderer.render( scn, cam );
	renderer.setRenderTarget( null );
	renderer.setViewport( 0, 0, innerWidth, innerHeight );
	renderer.render( postScene, postCam );

}

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

	miniFW = 0;

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
roads.env = envTex;
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


// ---------- showroom (main menu) ----------
const show = new THREE.Scene();
const showCam = new THREE.PerspectiveCamera( 30, innerWidth / innerHeight, 0.1, 100 );
show.background = new THREE.Color( 0x141a33 );
show.add( new THREE.HemisphereLight( 0xb7a8c9, 0x14121c, 0.6 ) );
const key = new THREE.SpotLight( 0xffd9a8, 170, 30, 0.55, 0.6 );
key.position.set( 4, 7, 3 ); key.castShadow = true; key.shadow.mapSize.set( 2048, 2048 ); key.shadow.bias = - 0.0002;
show.add( key, key.target );
const rim = new THREE.DirectionalLight( 0xe8a0a8, 1.6 ); rim.position.set( - 5, 3, - 6 ); show.add( rim );
{

	// floor with a soft light pool
	const c = document.createElement( 'canvas' ); c.width = c.height = 512;
	const x = c.getContext( '2d' );
	const g = x.createRadialGradient( 256, 256, 10, 256, 256, 256 );
	g.addColorStop( 0, '#3e4a5c' ); g.addColorStop( 0.45, '#22263a' ); g.addColorStop( 1, '#141a33' );
	x.fillStyle = g; x.fillRect( 0, 0, 512, 512 );
	x.strokeStyle = 'rgba(255,255,255,0.05)'; x.lineWidth = 2;
	for ( let i = 0; i <= 512; i += 32 ) { x.beginPath(); x.moveTo( i, 0 ); x.lineTo( i, 512 ); x.stroke(); x.beginPath(); x.moveTo( 0, i ); x.lineTo( 512, i ); x.stroke(); }
	const t = new THREE.CanvasTexture( c ); t.colorSpace = THREE.SRGBColorSpace;
	const floor = new THREE.Mesh( new THREE.CircleGeometry( 14, 64 ), new THREE.MeshStandardMaterial( { map: t, roughness: 0.35, metalness: 0.2 } ) );
	floor.rotation.x = - Math.PI / 2; floor.receiveShadow = true; show.add( floor );
	const ring = new THREE.Mesh( new THREE.RingGeometry( 3.05, 3.12, 96 ), new THREE.MeshBasicMaterial( { color: 0xe0442e } ) );
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

	showIdle += dt;
	if ( window.__game && window.__game.turn !== undefined ) turntable.rotation.y = window.__game.turn;
	else { if ( showIdle > 3 ) showTurn += dt * 0.25; turntable.rotation.y += ( showTurn - turntable.rotation.y ) * Math.min( 1, dt * 12 ); }
	if ( showIdle > 3 ) showPitch *= 1 - Math.min( 1, dt * 1.5 );
	const wide = innerWidth > 760;
	showCam.position.set( wide ? 1.2 : 0, 1.55 + showPitch * 8, 8.6 - showPitch * 3 );
	showCam.lookAt( wide ? 1.4 : 0, wide ? 0.55 : 0.1, 0 );
	present( show, showCam );

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
	mode: { label: 'Sõidurežiim', values: [ 'arcade', 'sim' ], names: [ 'Rally', 'Simulatsioon' ], get: () => S.mode, set: v => { S.mode = v; vehicle.mode = v; store.set( 'mode', v ); } },
	auto: { label: 'Käigukast', values: [ true, false ], names: [ 'Automaat', 'Manuaal' ], get: () => S.auto, set: v => { S.auto = v; vehicle.setAuto( v ); store.set( 'auto', v ); } },
	car: { label: 'Auto', values: CAR_SPECS.map( c => c.id ), names: CAR_SPECS.map( c => c.name ), get: () => S.car, set: v => selectCar( v ) },
	color: { label: 'Värv', values: [ 0, 1, 2, 3, 4 ], names: [ 'Tehase', 'Värv 2', 'Värv 3', 'Värv 4', 'Värv 5' ], get: () => S.colors[ S.car ] || 0, set: v => { S.colors[ S.car ] = v; store.set( 'colors', S.colors ); car && car.setColor( v ); showCar && showCar.setColor( v ); } },
	place: { label: 'Koht', values: PLACES.map( ( _, i ) => i ), names: PLACES.map( p => p.name ), get: () => S.place, set: v => { S.place = v; store.set( 'place', v ); if ( started && ! inMenu ) pendingPlace = v; } },
	cam: { label: 'Kaamera', values: CAMS.map( ( _, i ) => i ), names: CAMS.map( c => c.name ), get: () => S.cam, set: v => { S.cam = v; } },
	detail: { label: 'Graafika', values: [ 2, 3 ], names: [ 'Tahvel', 'Arvuti' ], get: () => S.detail, set: v => { S.detail = v; store.set( 'detail', v ); } },
	look: { label: 'Pilt', values: [ 'ps1', 'sharp' ], names: [ 'PS1', 'Terav' ], get: () => S.look, set: v => { S.look = v; store.set( 'look', v ); } },
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

buildOpts( $( 'mopts' ), [ 'mode', 'auto', 'color', 'place', 'look', 'detail', 'sound' ] );
buildOpts( $( 'popts' ), [ 'car', 'mode', 'auto', 'color', 'cam', 'place', 'look', 'sound' ] );

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
	$( 'i-mode' ).textContent = S.mode === 'arcade' ? 'Rally' : 'Sim';
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
	if ( on && document.pointerLockElement ) document.exitPointerLock();
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
	if ( mapOpen ) {

		if ( e.code === 'KeyM' || e.code === 'Escape' ) closeMap();
		else if ( e.code === 'Enter' || e.code === 'Space' ) { const p = big.toEN( big.w / 2, big.h / 2 ); teleport( p.E, p.N ); }
		else if ( e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'KeyE' ) big.zoomAt( 0.7 );
		else if ( e.code === 'Minus' || e.code === 'NumpadSubtract' || e.code === 'KeyQ' ) big.zoomAt( 1 / 0.7 );
		else keys.add( e.code );
		e.preventDefault();
		return;

	}

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
	if ( e.code === 'KeyT' ) { cycle( 'mode', 1 ); toast( S.mode === 'arcade' ? 'Rally' : 'Simulatsioon' ); }
	if ( e.code === 'KeyM' ) openMap();

} );
addEventListener( 'keyup', e => keys.delete( e.code ) );
addEventListener( 'blur', () => { keys.clear(); if ( started && ! inMenu && ! paused && ! mapOpen ) setPaused( true ); } );

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

	if ( mapOpen ) {

		const lx = gp.axes[ 0 ] || 0, ly = gp.axes[ 1 ] || 0;
		const dz = v => Math.abs( v ) < 0.15 ? 0 : v;
		big.pan( - dz( lx ) * 700 * dt, - dz( ly ) * 700 * dt );
		const zi = ( gp.buttons[ 7 ] || { value: 0 } ).value, zo = ( gp.buttons[ 6 ] || { value: 0 } ).value;
		if ( zi > 0.05 || zo > 0.05 ) big.zoomAt( Math.exp( ( zo - zi ) * dt * 2.5 ) );
		if ( ev[ 0 ] ) { const p = big.toEN( big.w / 2, big.h / 2 ); teleport( p.E, p.N ); }
		if ( ev[ 1 ] || ev[ 3 ] || ev[ 8 ] || ev[ 9 ] ) closeMap();
		return null;

	}

	if ( inMenu || paused ) {
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
	if ( ev[ 3 ] ) cycleCam();
	if ( ev[ 8 ] ) { openMap(); return null; }
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

		// right stick: look around the car
		const rx = gp.axes[ 2 ] || 0, ry = gp.axes[ 3 ] || 0, rd = 0.15;
		const ra = v => Math.abs( v ) < rd ? 0 : Math.sign( v ) * ( ( Math.abs( v ) - rd ) / ( 1 - rd ) ) ** 1.5;
		if ( ra( rx ) || ra( ry ) ) orbitBy( ra( rx ) * 3.2 * dt, - ra( ry ) * 1.6 * dt );
		const b = i => gp.buttons[ i ] || { value: 0, pressed: false };
		if ( b( 10 ).pressed || b( 11 ).pressed ) { orbit.yaw = 0; orbit.pitch = 0; }
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

// ---------- mouse / touch: look around the car while driving, turn the car in the showroom ----------
const canvasEl = $( 'c' );
const drag = { id: null, x: 0, y: 0 };
let showTurn = 0, showIdle = 99, showPitch = 0;
canvasEl.addEventListener( 'pointerdown', e => {

	if ( drag.id !== null && e.pointerType !== 'mouse' ) return;
	drag.id = e.pointerId; drag.x = e.clientX; drag.y = e.clientY;
	try { canvasEl.setPointerCapture( e.pointerId ); } catch { /* old browsers */ }
	if ( ! inMenu && ! paused && started && e.pointerType === 'mouse' && e.button === 0 && canvasEl.requestPointerLock && ! document.pointerLockElement ) {

		try { const r = canvasEl.requestPointerLock(); if ( r && r.catch ) r.catch( () => {} ); } catch { /* not allowed */ }

	}

} );
const endDrag = e => { if ( e.pointerId === drag.id ) drag.id = null; };
canvasEl.addEventListener( 'pointerup', endDrag );
canvasEl.addEventListener( 'pointercancel', endDrag );
addEventListener( 'pointermove', e => {

	const locked = document.pointerLockElement === canvasEl;
	let dx, dy;
	if ( locked ) { dx = e.movementX; dy = e.movementY; }
	else if ( e.pointerId === drag.id ) { dx = e.clientX - drag.x; dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; }
	else if ( e.pointerType === 'mouse' && ! e.buttons && e.target === canvasEl ) { dx = e.movementX || 0; dy = e.movementY || 0; }
	else return;
	if ( inMenu ) {

		if ( e.pointerId !== drag.id ) return; // the showroom turns only while dragging
		showTurn += dx * 0.012; showPitch = Math.max( - 0.15, Math.min( 0.5, showPitch + dy * 0.004 ) ); showIdle = 0;
		return;

	}

	if ( paused || ! started ) return;
	const k = e.pointerType === 'mouse' ? 0.0045 : 0.009;
	orbitBy( - dx * k, dy * k * 0.7 );

} );

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
	splash() { this.noise( 0.9, 'lowpass', 1800, 300, 0.7, 0.5 ); this.noise( 0.5, 'bandpass', 900, 250, 1.0, 0.35, 0.12 ); },
	clack( k ) { this.noise( 0.07, 'bandpass', 900, 400, 1.6, 0.22 * k ); },
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
			if ( world.normal( x, z ).y < 0.97 || roads.waterLevel( x, z ) !== null ) continue;
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

// ---------- water: the car floats for a moment, then sinks; it comes back where it last stood on a street ----------
const sink = { on: false, t: 0 }, safe = { x: 0, z: 0, yaw: 0, t: 0, ok: false };
function updateWater( dt ) {

	const p = vehicle.pos;
	const wl = roads.waterLevel( p.x, p.z );
	if ( wl !== null && p.y < wl + 0.45 ) {

		if ( ! sink.on ) { sink.on = true; sink.t = 0; audio.splash(); toast( 'Auto uppus!' ); rumble( 0.8, 0.8, 300 ); }
		sink.t += dt;
		// water drag, and a buoyancy a little weaker than gravity: a slow sink
		vehicle.vel.multiplyScalar( Math.exp( - dt * 2.2 ) );
		vehicle.vel.y += 7.5 * dt;
		vehicle.angVel.multiplyScalar( Math.exp( - dt * 2 ) );
		if ( sink.t > 2.6 ) {

			sink.on = false;
			if ( safe.ok ) { vehicle.place( safe.x, safe.z, safe.yaw ); skids.clear(); }
			else resetCar();

		}

		return;

	}

	sink.on = false;
	safe.t -= dt;
	if ( safe.t <= 0 && world.surface( p.x, p.z ) === 1 && vehicle.wheels.every( w => w.contact ) && Math.abs( vehicle.speed ) < 25 ) {

		safe.t = 1; safe.ok = true;
		// a little behind the car, so it does not drive straight back into the water
		const f = vehicle.vel.clone().setY( 0 );
		const back = f.lengthSq() > 1 ? f.normalize().multiplyScalar( - 6 ) : f.set( 0, 0, 0 );
		safe.x = p.x + back.x; safe.z = p.z + back.z; safe.yaw = vehicle.yaw;
		if ( world.surface( safe.x, safe.z ) !== 1 ) { safe.x = p.x; safe.z = p.z; }

	}

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
// free look around the car: right stick, mouse or a swipe. It eases back behind the car once you let go.
const orbit = { yaw: 0, pitch: 0, idle: 99 };
function orbitBy( dy, dp ) {

	orbit.yaw = Math.atan2( Math.sin( orbit.yaw + dy ), Math.cos( orbit.yaw + dy ) );
	orbit.pitch = Math.max( - 0.3, Math.min( 1.1, orbit.pitch + dp ) );
	orbit.idle = 0;

}
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
	orbit.idle += dt;
	if ( orbit.idle > 1.6 && Math.abs( vehicle.speed ) > 2 ) {

		const k = 1 - Math.exp( - dt * 2.5 );
		orbit.yaw -= orbit.yaw * k; orbit.pitch -= orbit.pitch * k;

	}

	if ( c.hood || c.bumper ) {

		const q = vehicle.quat;
		camera.position.copy( new THREE.Vector3( 0, c.hood ? 0.68 : 0.05, c.hood ? 0.35 : 2.25 ).applyQuaternion( q ).add( p ) );
		camera.quaternion.copy( q ).multiply( new THREE.Quaternion().setFromAxisAngle( UP, Math.PI + orbit.yaw ) );
		camera.rotateX( - 0.05 - orbit.pitch * 0.6 );
		camera.fov = c.hood ? 70 : 74;
		camera.updateProjectionMatrix();
		return;

	}

	const oy = camYaw + orbit.yaw;
	const f = new THREE.Vector3( Math.sin( oy ), 0, Math.cos( oy ) );
	const sp = Math.abs( vehicle.speed );
	const arm = Math.hypot( c.back + sp * 0.04, c.up ), el = Math.max( 0.04, Math.min( 1.45, Math.atan2( c.up, c.back + sp * 0.04 ) + orbit.pitch ) );
	const want = p.clone().addScaledVector( f, - arm * Math.cos( el ) ).addScaledVector( UP, arm * Math.sin( el ) );
	const from = p.clone().addScaledVector( UP, 1.4 );
	const to = want.clone().sub( from );
	const dist = to.length();
	to.normalize();
	const hit = world.raycast( from, to, dist );
	if ( hit ) want.copy( from ).addScaledVector( to, Math.max( 2, hit.distance - 0.6 ) );
	const gy = world.height( want.x, want.z ) + 0.8;
	if ( want.y < gy ) want.y = gy;

	camPos.lerp( want, 1 - Math.exp( - dt * ( orbit.idle < 0.3 ? 20 : 8 ) ) );
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
const FONT = '"VT323", monospace';
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
	c.beginPath(); c.arc( cx, cy, R - 10, a0, ang( vehicle.rpm ) ); c.lineWidth = 10; c.strokeStyle = hot ? '#e0442e' : '#eceef1'; c.stroke();
	c.beginPath(); c.arc( cx, cy, R - 26, ang( vehicle.redline ), a1 ); c.lineWidth = 6; c.strokeStyle = '#e0442e'; c.stroke();
	c.fillStyle = '#eceef1'; c.strokeStyle = 'rgba(255,255,255,.7)';
	c.font = `400 40px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
	for ( let r = 0; r <= max; r += 500 ) {

		const a = ang( r ), big = r % 1000 === 0;
		c.lineWidth = big ? 4 : 2;
		c.beginPath();
		c.moveTo( cx + Math.cos( a ) * ( R - ( big ? 52 : 42 ) ), cy + Math.sin( a ) * ( R - ( big ? 52 : 42 ) ) );
		c.lineTo( cx + Math.cos( a ) * ( R - 32 ), cy + Math.sin( a ) * ( R - 32 ) );
		c.stroke();
		if ( big ) { c.fillStyle = r >= vehicle.redline ? '#e0442e' : '#c9cdd3'; c.fillText( r / 1000, cx + Math.cos( a ) * ( R - 78 ), cy + Math.sin( a ) * ( R - 78 ) ); }

	}

	// needle
	const a = ang( vehicle.rpm );
	c.strokeStyle = '#e0442e'; c.lineWidth = 5; c.lineCap = 'round';
	c.beginPath(); c.moveTo( cx - Math.cos( a ) * 18, cy - Math.sin( a ) * 18 ); c.lineTo( cx + Math.cos( a ) * ( R - 34 ), cy + Math.sin( a ) * ( R - 34 ) ); c.stroke();
	c.beginPath(); c.arc( cx, cy, 10, 0, Math.PI * 2 ); c.fillStyle = '#e0442e'; c.fill();
	// gear + speed
	const g = vehicle.gear === - 1 ? 'R' : vehicle.gear === 0 ? 'N' : String( vehicle.gear );
	c.fillStyle = hot ? '#e0442e' : '#ffffff';
	c.font = `400 150px ${FONT}`;
	c.fillText( g, cx, cy + 86 );
	c.fillStyle = '#ffffff';
	c.font = `400 72px ${FONT}`;
	c.fillText( Math.round( Math.abs( vehicle.speed ) * 3.6 ), cx, cy + 166 );
	c.font = `400 28px ${FONT}`;
	c.fillStyle = '#8d939c';
	c.fillText( 'KM/H', cx, cy + 200 );
	c.font = `400 30px ${FONT}`;
	c.fillStyle = vehicle.auto ? '#f4c27a' : '#8d939c';
	c.fillText( vehicle.auto ? 'AUTO' : 'MANUAAL', cx, cy - 62 );
	if ( vehicle.spec.turbo ) {

		const bw = 120, bx = cx - bw / 2, by = cy - 36;
		c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect( bx, by, bw, 6 );
		c.fillStyle = vehicle.boost > 0.8 ? '#f4c27a' : '#9aa4b0';
		c.fillRect( bx, by, bw * Math.max( 0, Math.min( 1, vehicle.boost ) ), 6 );

	}

	if ( ctl.handbrake ) { c.fillStyle = '#e0442e'; c.font = `700 24px ${FONT}`; c.fillText( 'P', cx, cy - 94 ); }

}

// ---------- maps ----------
const mini = new TileMap( $( 'mini' ), { labels: true, rotate: false } );
const big = new TileMap( $( 'bigc' ), { labels: true, rotate: false } );
big.places = PLACES.map( p => { const { E, N } = toLest( p.lat, p.lon ); return { name: p.name, E, N }; } );
big.cursor = true;
let mapOpen = false;
// The minimap is drawn north-up onto an oversized canvas only when the car has moved far enough or new tiles
// arrived; every frame just shifts and rotates that canvas with a CSS transform (compositor only, no repaint).
const miniCar = $( 'minicar' );
let miniE = 0, miniN = 0, miniGen = - 1, miniDrawT = 0, miniFW = 0;
function renderMinimap( dt ) {

	const { E, N } = worldToEN( vehicle.pos.x, vehicle.pos.z );
	miniDrawT -= dt;
	const dx = ( E - miniE ) / mini.mpp, dy = ( miniN - N ) / mini.mpp;
	if ( Math.hypot( dx, dy ) > miniFW * 0.12 || ( miniDrawT <= 0 && miniGen !== tileGen() ) || miniFW === 0 ) {

		miniFW = $( 'mapframe' ).offsetWidth;
		mini.mpp = 340 / Math.max( 60, miniFW );
		mini.E = miniE = E; mini.N = miniN = N;
		miniGen = tileGen();
		mini.draw();
		miniDrawT = 0.25;

	}

	const ox = ( E - miniE ) / mini.mpp, oy = ( miniN - N ) / mini.mpp;
	const h = Math.PI - ( camYaw + orbit.yaw );
	mini.canvas.style.transform = `rotate(${ ( - h ).toFixed( 4 )}rad) translate(${ ( - ox ).toFixed( 2 )}px,${ ( - oy ).toFixed( 2 )}px)`;
	miniCar.style.transform = `rotate(${ ( Math.PI - vehicle.yaw - h ).toFixed( 4 )}rad)`;

}

function openMap() {

	if ( ! started || inMenu || spawning || paused ) return;
	mapOpen = true;
	keys.clear();
	if ( document.pointerLockElement ) document.exitPointerLock();
	$( 'bigmap' ).style.display = 'block';
	const { E, N } = worldToEN( vehicle.pos.x, vehicle.pos.z );
	big.E = E; big.N = N; big.mpp = 2.2;
	big.car = { E, N, yaw: vehicle.yaw };
	$( 'bigmap' ).querySelector( '.title small' ).textContent = isTouch ? 'Puuduta kohta, kuhu tahad sõita' : 'Kliki kohta, kuhu tahad sõita';
	$( 'bm-tip' ).innerHTML = isTouch ? 'Lohista · näpista suumiks · <b>puuduta kohta</b> = teleport' : padSeen ? 'Kang liigutab · RT/LT suumib · <b>A</b> = teleport · <b>B</b> sulgeb' : 'Lohista · rullik suumib · <b>kliki</b> = teleport · <b>M</b> sulgeb';

}

function closeMap() {

	mapOpen = false;
	keys.clear();
	$( 'bigmap' ).style.display = 'none';
	last = performance.now();

}

function teleport( E, N ) {

	let { x, z } = enToWorld( E, N );
	const r = Math.hypot( x, z ), lim = BOUNDARY - 60;
	if ( r > lim ) { x *= lim / r; z *= lim / r; }
	closeMap();
	keepYaw = null;
	spawnAt( new THREE.Vector3( x, 0, z ) );
	toast( 'Teleport' );

}

{

	// big map: drag to pan, wheel / pinch to zoom, click or tap to teleport
	const c = $( 'bigc' ), pts = new Map();
	let moved = 0, pinch = 0;
	c.addEventListener( 'pointerdown', e => { try { c.setPointerCapture( e.pointerId ); } catch { /* synthetic */ } pts.set( e.pointerId, [ e.clientX, e.clientY ] ); moved = pts.size > 1 ? 99 : 0; pinch = 0; } );
	c.addEventListener( 'pointermove', e => {

		const p = pts.get( e.pointerId );
		if ( ! p ) return;
		const dx = e.clientX - p[ 0 ], dy = e.clientY - p[ 1 ];
		if ( pts.size === 1 ) { big.pan( dx, dy ); moved += Math.abs( dx ) + Math.abs( dy ); }
		else {

			const [ a, b ] = [ ...pts.values() ];
			const d0 = Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ] );
			p[ 0 ] = e.clientX; p[ 1 ] = e.clientY;
			const d1 = Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ] );
			if ( d0 > 10 && d1 > 10 ) { const r = c.getBoundingClientRect(); big.zoomAt( d0 / d1, ( a[ 0 ] + b[ 0 ] ) / 2 - r.left, ( a[ 1 ] + b[ 1 ] ) / 2 - r.top ); }
			pinch = 1;
			return;

		}

		p[ 0 ] = e.clientX; p[ 1 ] = e.clientY;

	} );
	const up = e => {

		const had = pts.delete( e.pointerId );
		if ( had && e.type === 'pointerup' && moved < 8 && ! pinch && pts.size === 0 ) {

			const r = c.getBoundingClientRect(), p = big.toEN( e.clientX - r.left, e.clientY - r.top );
			teleport( p.E, p.N );

		}

	};
	c.addEventListener( 'pointerup', up );
	c.addEventListener( 'pointercancel', up );
	c.addEventListener( 'wheel', e => { e.preventDefault(); const r = c.getBoundingClientRect(); big.zoomAt( Math.exp( e.deltaY * 0.0015 ), e.clientX - r.left, e.clientY - r.top ); }, { passive: false } );
	$( 'bm-in' ).onclick = () => big.zoomAt( 0.6 );
	$( 'bm-out' ).onclick = () => big.zoomAt( 1 / 0.6 );
	$( 'bm-x' ).onclick = () => closeMap();
	$( 'bm-car' ).onclick = () => { const p = worldToEN( vehicle.pos.x, vehicle.pos.z ); big.E = p.E; big.N = p.N; };
	$( 'mapframe' ).addEventListener( 'pointerdown', e => { e.stopPropagation(); e.preventDefault(); openMap(); } );

}

function updateBigMap( dt ) {

	const k = c => keys.has( c );
	const px = ( k( 'ArrowLeft' ) || k( 'KeyA' ) ? 1 : 0 ) - ( k( 'ArrowRight' ) || k( 'KeyD' ) ? 1 : 0 );
	const py = ( k( 'ArrowUp' ) || k( 'KeyW' ) ? 1 : 0 ) - ( k( 'ArrowDown' ) || k( 'KeyS' ) ? 1 : 0 );
	if ( px || py ) big.pan( px * 600 * dt, py * 600 * dt );
	big.draw();

}

// ---------- frame rate: counter, and render resolution that follows the device ----------
const MAX_PR = Math.min( window.devicePixelRatio, isTouch ? 1.5 : 1.75 );
let pr = Math.min( MAX_PR, isTouch ? 1.25 : 1.75 ), fpsN = 0, fpsT = 0, fpsAvg = 60, adaptT = 0, adaptN = 0;
renderer.setPixelRatio( pr );
function frameStats( dt, playing ) {

	fpsN ++; fpsT += dt;
	if ( fpsT >= 0.5 ) {

		fpsAvg = fpsN / fpsT;
		const el = $( 'fps' );
		el.textContent = Math.round( fpsAvg ) + ' FPS';
		el.classList.toggle( 'low', fpsAvg < 28 );
		fpsN = 0; fpsT = 0;

	}

	if ( ! playing ) { adaptT = 0; adaptN = 0; return; }
	adaptT += dt; adaptN ++;
	if ( adaptT < 2.5 ) return;
	const f = adaptN / adaptT;
	adaptT = 0; adaptN = 0;
	let np = pr;
	if ( f < 30 ) np = Math.max( 0.6, pr - ( f < 22 ? 0.25 : 0.12 ) );
	else if ( f > 54 ) np = Math.min( MAX_PR, pr + 0.1 );
	if ( Math.abs( np - pr ) > 0.01 ) { pr = np; renderer.setPixelRatio( pr ); renderer.setSize( innerWidth, innerHeight ); }

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
		roads.parked.phone = d === 2;
		roads.parked.clear = vehicle.pos;
		facades.radius = d === 2 ? 170 : 330;
		facades.sharp = d !== 2; // the sharpening costs four extra texture reads: computers only
		facades.maxTex = d === 2 ? 1024 : 4096; // photo facades at full resolution on computers
		scene.fog.far = d === 2 ? 850 : 1250;
		scene.fog.near = d === 2 ? 300 : 450;
		const sz = d === 2 ? 1024 : 2048, ext = d === 2 ? 55 : 85;
		sun.shadow.mapSize.set( sz, sz );
		Object.assign( sun.shadow.camera, { left: - ext, right: ext, top: ext, bottom: - ext, near: 50, far: 600 } );
		sun.shadow.camera.updateProjectionMatrix();
		showStatus( 'Laen linna', 'Maa-ameti 3D-majad ja ortofoto' );
		try { await world.init(); } catch ( e ) { showStatus( 'Oih!', 'Linna andmeid ei saanud laadida.' ); return; }
		started = true;
		// parked cars load after the city is up, so they never hold back the start
		setTimeout( () => roads.parked.load().catch( e => console.warn( 'parked cars', e ) ), 2500 );
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
	const dt = Math.min( 0.1, ( now - last ) / 1000 );
	last = now;

	if ( inMenu ) {

		frameStats( dt, false );
		pollPad( dt );
		if ( audio.ctx ) audio.update( 900, 0, 0, 0, 0, true );
		renderShowroom( dt );
		return;

	}

	if ( ! started ) { pollPad( dt ); renderShowroom( dt ); return; }

	if ( mapOpen ) {

		pollPad( dt );
		frameStats( dt, false );
		if ( audio.ctx ) audio.update( vehicle.rpm, 0, 0, 0, 0, true );
		updateBigMap( dt );
		return;

	}

	const input = readInput( dt );
	frameStats( dt, ! paused && ! spawning );
	if ( paused ) {

		if ( audio.ctx ) audio.update( vehicle.rpm, 0, 0, 0, 0, true );
		present( scene, camera );
		return;

	}

	if ( spawning ) trySpawn( dt );
	else {

		vehicle.update( dt, input );
		updateWater( dt );
		if ( vehicle.pos.y < world.height( vehicle.pos.x, vehicle.pos.z ) - 6 && ! sink.on ) resetCar();
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
	roads.parked.update( dt, vehicle.pos.x, vehicle.pos.z );
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
		// clack over tram and train rails
		const rb = w.contact && w.cp ? roads.railBump( w.cp.x, w.cp.z ) : 0;
		if ( rb > 0.012 && ! w.onRail && Math.abs( vehicle.speed ) > 1.5 ) { audio.clack( Math.min( 1, Math.abs( vehicle.speed ) / 15 ) ); if ( i === 0 ) rumble( 0.25, 0.4, 60 ); }
		w.onRail = rb > 0.012;
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
	sky.material.uniforms.uTime.value += dt;
	placeSun();

	present( scene, camera );
	if ( ! spawning ) renderMinimap( dt );
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
window.__game = { renderer, scene, camera, sun, openMap, closeMap, teleport, big, mini, orbit, get mapOpen() { return mapOpen; }, vehicle, world, roads, facades, ctl, keys, skids, CAR_SPECS, S, selectCar, setPaused, startGame, cycle, get car() { return car; }, get spawning() { return spawning; }, get paused() { return paused; } };
